#!/usr/bin/env python3
"""Publish separate, source-bound seven-crystal-system annotations.

The visually reviewed Point Group facts never overwrite Handbook fields.
Original PDFs remain private. Unknown symbols fail closed, as do changed source
bytes, changed legacy fields, or missing visual-review evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

BEGIN = '// BEGIN SOURCE-BOUND CRYSTAL SYSTEM ANNOTATIONS'
END = '// END SOURCE-BOUND CRYSTAL SYSTEM ANNOTATIONS'
SYSTEMS = {
    'triclinic': ('三斜晶系', ['1', '-1']),
    'monoclinic': ('单斜晶系', ['2', 'm', '2/m']),
    'orthorhombic': ('斜方晶系', ['222', 'mm2', 'mmm']),
    'tetragonal': ('四方晶系', ['4', '-4', '4/m', '422', '4mm', '-42m', '4/mmm']),
    'trigonal': ('三方晶系', ['3', '-3', '32', '3m', '-3m']),
    'hexagonal': ('六方晶系', ['6', '-6', '6/m', '622', '6mm', '-6m2', '6/mmm']),
    'cubic': ('立方晶系', ['23', 'm-3', '432', '-43m', 'm-3m']),
}
POINT_GROUPS = {group: (system, title) for system, (title, groups) in SYSTEMS.items() for group in groups}
FULL_SYMBOLS = {'-32/m': '-3m', '6/m2/m2/m': '6/mmm'}


def normal_symbol(symbol):
    # Only symbols explicitly transcribed from the rendered source enter here.
    # A missing vector overbar is never reconstructed from extraction text.
    return re.sub(r'\s+', '', symbol.replace('−', '-'))


def classify(symbol):
    value = normal_symbol(symbol)
    value = FULL_SYMBOLS.get(value, value)
    if value not in POINT_GROUPS:
        raise ValueError('Unknown/unreviewed point-group symbol: ' + symbol)
    return POINT_GROUPS[value]


def compile_annotations(reviewed, knowledge, pdf_dir=None):
    if reviewed.get('schema_version') != 1 or len(reviewed.get('classification_sources', [])) != 2:
        raise ValueError('Missing reviewed schema/classification sources')
    records, seen = [], set()
    for row in reviewed['records']:
        url, digest = row['source_url'], row['source_pdf_sha256']
        if url in seen or not re.fullmatch(r'https://www\.handbookofmineralogy\.org/pdfs/[a-z0-9_-]+\.pdf', url):
            raise ValueError('Duplicate or unsupported source: ' + url)
        seen.add(url)
        if not re.fullmatch(r'[a-f0-9]{64}', digest) or row.get('source_page') != 1:
            raise ValueError('Source checksum/page is invalid')
        visual = row.get('visual_review', {})
        if not visual.get('reviewer') or visual.get('page') != 1 or not re.fullmatch(r'[a-f0-9]{64}', visual.get('render_sha256', '')):
            raise ValueError('Rendered visual review is missing')
        keys = row['legacy_keys']
        if not keys:
            raise ValueError('Missing legacy key')
        for key in keys:
            field = knowledge[key].get('verified_properties', {}).get('crystal_system', {})
            if field.get('source_url') != url or field.get('value') != row['source_original_value'] or field.get('status') != 'verified':
                raise ValueError('Original crystal-system field changed: ' + key)
        if pdf_dir is not None:
            path = next((pdf_dir / (key + '.pdf') for key in keys if (pdf_dir / (key + '.pdf')).exists()), None)
            if path is None or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('Original PDF changed/missing; repeat visual review: ' + keys[0])
        groups = []
        for group in row['point_groups']:
            system, title = classify(group['source_symbol'])
            source_symbol = normal_symbol(group['source_symbol'])
            if FULL_SYMBOLS.get(source_symbol, source_symbol) != normal_symbol(group['standard_symbol']):
                raise ValueError('Source point-group normalization changed symbol')
            groups.append({**group, 'crystal_system': system, 'crystal_system_zh': title})
        if not groups:
            raise ValueError('No reviewed point group')
        conditional = len({g['crystal_system'] for g in groups}) > 1
        display = '；'.join(f"{g['crystal_system_zh']}（{g['condition_zh']+'，' if g['condition_zh'] and conditional else ''}源页点群 {g['source_symbol']}）" for g in groups)
        records.append({**row, 'point_groups': groups, 'display_zh': display,
                        'status': 'conditional' if conditional else 'derived_from_reviewed_point_group'})
    expected = {key for key, row in knowledge.items() if re.match(r'^Hexagonal', str(row.get('verified_properties', {}).get('crystal_system', {}).get('value', '')))}
    actual = [key for row in records for key in row['legacy_keys']]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise ValueError('Reviewed annotations must cover exactly the original Hexagonal fields; pseudohexagonal is not converted')
    return {**reviewed, 'records': records, 'counts': {'source_pdfs': len(records), 'legacy_labels': len(actual),
            'conditional_sources': sum(row['status'] == 'conditional' for row in records),
            'source_internal_discrepancies': sum(bool(row.get('source_internal_discrepancy')) for row in records)}}


def read_knowledge(path, node):
    code = "const fs=require('fs'),vm=require('vm'),c={window:{}};vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),c);process.stdout.write(JSON.stringify(c.window.MINERAL_KB));"
    return json.loads(subprocess.run([node, '-e', code, str(path)], check=True, capture_output=True, text=True).stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reviewed', type=Path, default=Path(__file__).with_name('crystal-system-reviewed.json'))
    parser.add_argument('--minerals', type=Path, required=True)
    parser.add_argument('--pdf-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Selected-fact annotation JSON; never full pages')
    parser.add_argument('--publish', action='store_true', help='Explicitly append/update the separate annotation variable; leave original KB objects unchanged')
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    reviewed = json.loads(args.reviewed.read_text(encoding='utf-8'))
    payload = compile_annotations(reviewed, read_knowledge(args.minerals, args.node), args.pdf_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.publish:
        text = args.minerals.read_text(encoding='utf-8')
        if text.count(BEGIN) != text.count(END) or text.count(BEGIN) > 1:
            raise ValueError('Malformed generated annotation block')
        text = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\s*', '', text, flags=re.S).rstrip()
        text += '\n' + BEGIN + '\nwindow.MINERAL_CRYSTAL_SYSTEM_ANNOTATIONS = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n' + END + '\n'
        temp = args.minerals.with_suffix('.js.tmp')
        temp.write_text(text, encoding='utf-8')
        temp.replace(args.minerals)
    print(json.dumps(payload['counts'], ensure_ascii=False))


if __name__ == '__main__':
    main()

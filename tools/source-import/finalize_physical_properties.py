#!/usr/bin/env python3
"""Apply explicit visual-review decisions, bound to original PDF SHA-256 hashes.

Run after collect_physical_properties.py. Never confirms a changed source PDF.
"""
import argparse
from pathlib import Path
from collections import Counter
import json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Candidate JSON from the collector')
    parser.add_argument('--decisions', type=Path, required=True, help='Explicit visual-review decisions tied to original PDF SHA-256')
    parser.add_argument('--output', type=Path, required=True, help='Reviewed facts JSON, kept separate from candidate input')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding='utf-8'))
    decisions = json.loads(args.decisions.read_text(encoding='utf-8'))
    assert data['complete'] and data['count'] == 89
    reviewed = decisions['reviewed_source_hashes']
    for row in data['records']:
        assert row.get('source_pdf_sha256') == reviewed[row['key']], row['key']
        for key, prop in row['properties'].items():
            override = decisions['overrides'].get(row['key'], {}).get(key)
            if override is not None:
                prop['raw'] = override
                prop['value'] = override.rstrip('.').strip()
                prop['status'] = 'verified'
                prop['verification'] = 'Official PDF rendering checked; original factual property manually transcribed to correct legacy glyph encoding.'
            elif key in decisions['needs_review'].get(row['key'], []):
                prop['value'] = None
                prop['status'] = 'needs_review'
                prop['note'] = 'Source Miller-index overbars or angle glyphs were lost in PDF text extraction; excluded rather than guessing the original indices.'
            elif prop['status'] == 'candidate':
                prop['status'] = 'verified'
                prop['verification'] = 'Checked against official PDF rendering; source spelling, directional dependence and reported range retained.'
            else:
                assert prop['status'] in {'unavailable', 'source_inferred', 'needs_review'}, prop
                prop['value'] = None
    data['verification_complete'] = True
    data['verification'] = {
        'date': decisions['reviewed_at'],
        'method': 'All 89 selected official PDF sources visually checked using 15 private contact sheets plus full-page review of scanned Chromite and Magnetite. Selected scientific property facts only; no source paragraphs or images in the output.',
        'source_integrity': 'Review decisions tied to each original PDF SHA-256; new source hashes require another review.',
        'limitations': 'Old Handbook pages can report historical nomenclature or ranges. Hexagonal and mixed systems retained exactly as stated, not converted automatically to trigonal. Vector overbars/angle glyphs in uncertain cleavage indices are withheld. No calculated density is substituted for measured density. Square-bracketed inferred values are never promoted.',
    }
    data['property_counts'] = {key: dict(Counter(r['properties'][key]['status'] for r in data['records'])) for key in data['records'][0]['properties']}
    data['verified_count'] = sum(p['status'] == 'verified' for r in data['records'] for p in r['properties'].values())
    data['unique_pdf_count'] = len({r['source_url'] for r in data['records']})
    data['original_missing_entries_supplemented'] = sum(r['missing_original_hardness_or_crystal'] and r['properties']['hardness']['status'] == r['properties']['crystal_system']['status'] == 'verified' for r in data['records'])
    assert all(p['value'] is None for r in data['records'] for p in r['properties'].values() if p['status'] != 'verified')
    assert not any('R:' in (p['raw'] or '') for r in data['records'] for k,p in r['properties'].items() if k in {'luster','streak'})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = {k: data[k] for k in ['count', 'unique_pdf_count', 'verified_count', 'original_missing_entries_supplemented', 'property_counts']}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()

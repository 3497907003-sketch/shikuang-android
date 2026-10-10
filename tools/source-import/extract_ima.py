#!/usr/bin/env python3
"""Extract the openly licensed official CNMNC PDF using its drawn table grid.

No generated descriptions or classification assignments are added. Chemical
subscripts/superscripts are recovered from original PDF character coordinates.
"""
from pathlib import Path
from collections import Counter
import argparse
import calendar
from datetime import date
import csv
import hashlib
import html
import json
import re
import unicodedata

import pdfplumber

SUB = str.maketrans('0123456789+-=()aeiorux', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑᵢₒᵣᵤₓ')
SUP = str.maketrans('0123456789+-=()n', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ')
# The September 2026 PDF embeds Symbol as CIDFont+F8. Its ToUnicode map
# contains private-use code points that cannot be rendered by phone fonts.
# Visually checked on source pages 79 (Gachingite), 160 (Orcelite) and
# 201 (Sluzhenikinite): approximate equality, less-than-or-equal and space.
SYMBOL_GLYPHS = {'\uf0bb': '≈', '\uf0a3': '≤', '\uf020': ' '}


def formula_character(character):
    text = character['text']
    font = character.get('fontname', '')
    if font == 'CIDFont+F8' or 'Symbol' in font:
        text = ''.join(SYMBOL_GLYPHS.get(c, c) for c in text)
    if any('\ue000' <= c <= '\uf8ff' for c in text):
        raise ValueError(f'Unreviewed private-use formula glyph in {font}: {text!r}')
    return text


def clean(value):
    return re.sub(r'\s+', ' ', value or '').strip()


def slug(name):
    stripped = ''.join(c for c in unicodedata.normalize('NFKD', name) if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', '-', stripped.casefold()).strip('-')


def formula_from_chars(chars):
    if not chars:
        return '', ''
    # Normal text uses the largest font; original charges and quantities use a
    # smaller font displaced vertically from the parent line.
    normal_size = max(c['size'] for c in chars)
    regular = [c for c in chars if c['size'] >= normal_size * .85]
    baselines = []
    for c in sorted(regular, key=lambda c: c['bottom']):
        if not baselines or abs(c['bottom'] - baselines[-1]) > 2:
            baselines.append(c['bottom'])
    if not baselines:
        baselines = [max(c['bottom'] for c in chars)]
    lines = [[] for _ in baselines]
    for c in chars:
        if c['size'] < normal_size * .85:
            candidates = [(abs(c['bottom'] - (baseline + offset * normal_size)), i, kind)
                          for i, baseline in enumerate(baselines)
                          for kind, offset in [('sub', .126), ('sup', -.64)]]
            _, index, kind = min(candidates)
        else:
            index = min(range(len(baselines)), key=lambda i: abs(c['bottom'] - baselines[i]))
            kind = None
        lines[index].append((c, kind))
    plain_parts, html_parts = [], []
    for baseline, line in zip(baselines, lines):
        # Coordinates restore the exact reading order that ordinary extract_text
        # loses by placing all quantities on a later line.
        for c, kind in sorted(line, key=lambda item: item[0]['x0']):
            text = formula_character(c)
            if kind == 'sub':
                plain_parts.append(text.translate(SUB))
            elif kind == 'sup':
                plain_parts.append(text.translate(SUP))
            else:
                plain_parts.append(text)
            escaped = html.escape(text)
            html_parts.append(f'<{kind}>{escaped}</{kind}>' if kind else escaped)
    return clean(''.join(plain_parts)), clean(''.join(html_parts))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True, help='Official downloaded seven-column IMA master-list PDF')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--version', default='2026-09', help='Master-list year-month; verify changed table layouts before reuse')
    parser.add_argument('--source-url', default='https://cnmnc.units.it/files/editor/IMA_Master_List_(2026-09).pdf')
    parser.add_argument('--expected-count', type=int, default=6239)
    parser.add_argument('--retrieved-at', default=date.today().isoformat())
    args = parser.parse_args()
    version_date = date.fromisoformat(args.version + '-01')
    month_year = calendar.month_name[version_date.month] + ' ' + str(version_date.year)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    minerals = []
    with pdfplumber.open(args.pdf) as doc:
        introductory_text = '\n'.join(p.extract_text() for p in doc.pages[:2])
        declared_count = int(re.search(r'on the (\d+) currently valid species', introductory_text)[1])
        assert month_year in introductory_text
        assert 'Creative Commons Attribution-ShareAlike 3.0 Unported License' in introductory_text
        for page in doc.pages[2:]:
            tables = page.find_tables()
            assert len(tables) == 1, (page.page_number, len(tables))
            table = tables[0]
            assert len(table.columns) == 7, page.page_number
            for row, values in zip(table.rows, table.extract()):
                if values[0] == 'Name':
                    continue
                values = [clean(v) for v in values]
                assert values[0] and values[2], (page.page_number, values)
                formula, formula_html = formula_from_chars(page.crop(row.cells[1]).chars)
                minerals.append({
                    'id': 'ima-' + slug(values[0]),
                    'name_en': values[0],
                    'formula': formula,
                    'formula_html': formula_html,
                    'ima_status': values[2],
                    'ima_number': values[3],
                    'discovery_country': values[4],
                    'first_reference': values[5],
                    'second_reference': values[6],
                    'source_url': args.source_url,
                    'source_page': page.page_number,
                    'source_id': 'ima-cnmnc',
                })
            page.flush_cache()
    assert len(minerals) == declared_count == args.expected_count, (len(minerals), declared_count)
    assert len({r['name_en'] for r in minerals}) == len(minerals)
    assert len({r['id'] for r in minerals}) == len(minerals), 'ID collision'
    for row in minerals:
        assert row['formula'] and row['ima_number'] and row['first_reference'], row
    samples = {r['name_en']: r for r in minerals}
    assert samples['Abellaite']['formula'] == 'NaPb₂(CO₃)₂(OH)'
    assert samples['Quartz']['formula'] == 'SiO₂'
    assert samples['Calcite']['formula'] == 'Ca(CO₃)'
    assert samples['Pyrite']['formula'] == 'FeS₂'
    source = {
        'title': 'The New IMA List of Minerals – Updated: ' + month_year,
        'url': args.source_url,
        'publisher': 'IMA Commission on New Minerals, Nomenclature and Classification (CNMNC)',
        'license': 'CC BY-SA 3.0 Unported',
        'license_url': 'https://creativecommons.org/licenses/by-sa/3.0/',
        'scope': f'Official list of {declared_count} currently valid mineral species; approved formula, IMA status/number or year, first-discovery country and references. This is a reference catalog, not inference-model coverage.',
        'sha256': hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
        'extraction': 'Original seven-column PDF table grid and character coordinates; whitespace normalized; chemical scripts preserved in Unicode and HTML. Three Symbol private-use glyphs visually mapped to ≈, ≤ and space on original pages 79, 160 and 201. Unreviewed private-use glyphs rejected. No generated descriptions.',
        'attribution': f'IMA-CNMNC, The New IMA List of Minerals, {month_year}; original authors and contributors credited in the source PDF. Extracted for 识矿 on {args.retrieved_at}; changes: machine-readable format and chemical-script encoding.',
    }
    payload = {'schema_version': 1, 'version': args.version, 'retrieved_at': args.retrieved_at, 'count': len(minerals), 'source': source, 'minerals': minerals}
    (args.output_dir / f'ima-catalog-{args.version}.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with (args.output_dir / f'ima-catalog-{args.version}.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=list(minerals[0]))
        writer.writeheader()
        writer.writerows(minerals)
    report = {'count': len(minerals), 'declared_count': declared_count, 'unique_names': len({r['name_en'] for r in minerals}), 'unique_ids': len({r['id'] for r in minerals}), 'status_counts': dict(Counter(r['ima_status'] for r in minerals)), 'missing_fields': {k: sum(not r[k] for r in minerals) for k in minerals[0]}, 'samples': {name: samples[name] for name in ['Abellaite', 'Abelloemringerite', 'Quartz', 'Calcite', 'Pyrite', 'Actinolite', 'Zýkaite']}}
    (args.output_dir / 'ima-extraction-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'samples'}, ensure_ascii=False))


if __name__ == '__main__':
    main()

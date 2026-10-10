#!/usr/bin/env python3
"""Audit published reference data against private original sources, read-only.

Only writes the requested summary report. PDF pages, archive text, photographs,
cookies and full source documents are never copied into the report.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import json
import math
from pathlib import Path
import re
import subprocess
import unicodedata
from urllib.parse import urlsplit
import zipfile
from annotate_crystal_systems import compile_annotations


SUB = str.maketrans('0123456789+-=()aeiorux', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑᵢₒᵣᵤₓ')
SUP = str.maketrans('0123456789+-=()n', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ')
ORIGINAL_FIELDS = ('name_en', 'formula', 'formula_html', 'ima_status', 'ima_number',
                   'discovery_country', 'first_reference', 'second_reference',
                   'source_url', 'source_page', 'source_id')
EXCLUDED = r'synthetic|synthesi|calculated|simulat|theoretical|hypothetical|idealized|ab initio|first.princip|density functional|\bDFT\b|quantum|mathematical model|optimized|predicted'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def normal(value):
    return unicodedata.normalize('NFKC', value).strip().casefold().replace('\u2011', '-')


def formula_plain(value):
    for tag, conversion in [('sub', SUB), ('sup', SUP)]:
        value = re.sub(r'<' + tag + r'>(.*?)</' + tag + r'>',
                       lambda m: html.unescape(m[1]).translate(conversion), value)
    # Spaces assigned to a small script font by the original PDF may be wrapped
    # in separate HTML tags. Compare the same normalized whitespace as the
    # source extractor; retain every chemical character and its script position.
    return re.sub(r'\s+', ' ', html.unescape(value)).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--sources', type=Path, required=True, help='Private source folder; only read, never copied')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--re-extracted-ima', type=Path, help='Fresh portable extract_ima.py output for all-row reproducibility comparison')
    parser.add_argument('--re-extracted-physical', type=Path, help='Fresh collector + finalizer output for reproducibility comparison')
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    repo, source = args.repo, args.sources
    report = {'schema_version': 1, 'validated_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'All published reference records compared to acquired official-source files and reviewed imports. This audit does not establish ML accuracy, photograph quality or photo reuse permission.',
              'checks': {}, 'anomalies': {}, 'files': {}, 'original_sources': {}}

    def check(name, failed):
        failed = list(failed)
        report['checks'][name] = not failed
        if failed:
            report['anomalies'][name] = {'count': len(failed), 'examples': failed[:5]}

    catalog = read(repo / 'data/catalog.json')
    crystals = read(repo / 'data/crystals.json')
    images = read(repo / 'data/image-sources.json')
    original = read(source / 'ima-catalog-2026-09.json')
    physical = read(source / 'physical-properties.json')
    original_images = read(source / 'image-sources.json')
    originals = {row['id']: row for row in original['minerals']}
    species = {row['id']: row for row in catalog['minerals']}
    by_name = {normal(row['name_en']): row for row in species.values()}
    expression = "const fs=require('node:fs'),vm=require('node:vm');const c={window:{}};vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),c);process.stdout.write(JSON.stringify({knowledge:c.window.MINERAL_KB,crystal_systems:c.window.MINERAL_CRYSTAL_SYSTEM_ANNOTATIONS}));"
    extracted = json.loads(subprocess.run([args.node, '-e', expression, str(repo / 'data/minerals.js')], check=True, capture_output=True, text=True).stdout)
    kb = extracted['knowledge']
    check('official_catalog_count_and_unique_ids', [] if catalog['count'] == len(catalog['minerals']) == len(species) == len(originals) == 6239 else ['count or unique ID mismatch'])
    check('official_names_unique', [] if len({r['name_en'] for r in species.values()}) == 6239 else ['duplicate name'])
    check('official_fields_preserved', [row['id'] + ':' + field for row in species.values() for field in ORIGINAL_FIELDS if row.get(field) != originals.get(row['id'], {}).get(field)])
    check('formula_unicode_html_equivalent', [r['id'] for r in species.values() if formula_plain(r['formula_html']) != r['formula'] or re.search(r'</?(?:sub|sup)\b|�|[\ue000-\uf8ff]', r['formula'])])
    check('symbol_formula_glyphs_match_reviewed_pdf_pages', [name for name, formula in {
        'Gachingite': 'Au(Te₁₋ₓSeₓ) (0.2 ≈ x ≤ 0.5)',
        'Orcelite': 'Ni₅₋ₓAs₂ (x ≈ 0.25)',
        'Sluzhenikinite': 'Pd₁₅(Sb₇₋ₓSnₓ) (3 ≤ x ≤ 4)',
    }.items() if by_name.get(normal(name), {}).get('formula') != formula])
    check('source_page_valid', [r['id'] for r in species.values() if not isinstance(r['source_page'], int) or not 3 <= r['source_page'] <= 244])
    legacy_formulas = [key for key, row in kb.items() if row.get('formula_source')]
    check('legacy_official_formula_and_source', [key for key in legacy_formulas if normal(kb[key]['name_en']) not in by_name or kb[key]['formula'] != by_name[normal(kb[key]['name_en'])]['formula'] or kb[key]['formula_source'] != {'source_id': 'ima-cnmnc', 'url': by_name[normal(kb[key]['name_en'])]['source_url'], 'page': by_name[normal(kb[key]['name_en'])]['source_page'], 'version': catalog['version']}])
    check('legacy_kb_count', [] if len(kb) == 105 else ['expected 105 original labels'])
    pdf = source / 'IMA_Master_List_2026-09.pdf'
    archive = source / 'amc.zip'
    check('original_pdf_hash', [] if sha(pdf) == catalog['source']['sha256'] else ['IMA PDF SHA-256 mismatch'])
    check('original_zip_hash', [] if sha(archive) == crystals['source']['sha256'] else ['AMCSD ZIP SHA-256 mismatch'])
    check('ima_license_and_credits_preserved', [] if (repo / 'data/licenses/ima-cnmnc-2026-09.txt').read_bytes() == (source / 'IMA-CNMNC-CREDITS-LICENSE.txt').read_bytes() and catalog['source']['license'] == 'CC BY-SA 3.0 Unported' and 'creative commons' in (repo / 'data/licenses/ima-cnmnc-2026-09.txt').read_text(encoding='utf-8').lower() else ['license or credits mismatch'])
    if args.re_extracted_ima:
        fresh = {r['id']: r for r in read(args.re_extracted_ima)['minerals']}
        check('all_ima_rows_reproduced_from_original_pdf', [r['id'] + ':' + key for r in species.values() for key in ORIGINAL_FIELDS if r.get(key) != fresh.get(r['id'], {}).get(key)])
    if args.re_extracted_physical:
        check('reviewed_physical_import_reproduced', [] if read(args.re_extracted_physical) == physical else ['reviewed collector output differs from reviewed original'])

    physical_fields = Counter()
    physical_sources = {}
    for row in physical['records']:
        for prop in row['properties'].values():
            physical_fields[prop['status']] += 1
        physical_sources.setdefault(row['source_url'], {'url': row['source_url'], 'sha256': row['source_pdf_sha256'], 'legacy_keys': []})['legacy_keys'].append(row['key'])
    check('physical_review_complete', [] if physical.get('verification_complete') is True and physical.get('complete') is True and len(physical['records']) == 89 and physical_fields['verified'] == 477 else ['physical review incomplete or counts differ'])
    check('physical_legacy_import_exact', [r['key'] for r in physical['records'] if kb.get(r['key'], {}).get('verified_properties') != r['properties']])
    check('physical_catalog_import_exact', [r['key'] for r in physical['records'] if normal(r['name_en']) in by_name and by_name[normal(r['name_en'])].get('physical_properties') != r['properties']])
    check('physical_status_and_null_semantics', [r['key'] + ':' + key for r in physical['records'] for key, prop in r['properties'].items() if prop['status'] not in {'verified', 'needs_review', 'source_inferred', 'unavailable'} or (prop['status'] != 'verified' and prop['value'] is not None) or (prop['status'] == 'verified' and (not prop['value'] or not prop.get('verification'))) or prop['source_url'] != r['source_url'] or prop['source_page'] != 1])
    check('physical_original_pdf_hashes', [r['key'] for r in physical['records'] if sha(source / 'physical-source-pdfs' / (r['key'] + '.pdf')) != r['source_pdf_sha256']])
    check('physical_no_calculated_density_substitution', [r['key'] for r in physical['records'] if r['properties']['density_measured'].get('unit') != 'g/cm³' or re.search(r'calc|calculated', r['properties']['density_measured']['raw'] or '', re.I)])
    try:
        annotations = compile_annotations(read(repo / 'tools/source-import/crystal-system-reviewed.json'), kb, source / 'physical-source-pdfs')
        check('crystal_system_separate_annotation_exact_and_pdf_bound', [] if extracted.get('crystal_systems') == annotations else ['published annotation differs from reviewed source-bound inference'])
    except (ValueError, KeyError, OSError) as error:
        annotations = {}
        check('crystal_system_separate_annotation_exact_and_pdf_bound', [str(error)])
    report['crystal_system_annotations'] = annotations.get('counts', {})

    crystal_rows = [r for rows in crystals['by_species'].values() for r in rows]
    check('crystal_counts_unique_ids', [] if len(crystal_rows) == crystals['stats']['matched_records'] == len({r['id'] for r in crystal_rows}) == 9895 and len(crystals['by_species']) == crystals['stats']['species_with_records'] == 3430 else ['crystal counts or IDs differ'])
    check('crystal_ima_species_and_cell_values', [r['id'] for key, rows in crystals['by_species'].items() for r in rows if key not in species or normal(r['mineral_name']) != normal(species[key]['name_en']) or set(r['cell']) != {'a', 'b', 'c', 'alpha', 'beta', 'gamma'} or not all(math.isfinite(v) and v > 0 for v in r['cell'].values()) or not all(r['cell'][v] < 180 for v in ['alpha', 'beta', 'gamma'])])
    unmatched_archive, excluded_headers = [], []
    with zipfile.ZipFile(archive) as files:
        archive_count = sum(name.endswith('.amc') for name in files.namelist())
        for row in crystal_rows:
            lines = files.read(row['source_file']).decode('utf-8').splitlines()
            index = next((i for i, line in enumerate(lines) if line.startswith('_database_code_amcsd ')), None)
            header = '\n'.join(lines[:index])
            if re.search(EXCLUDED, header, re.I):
                excluded_headers.append(row['id'])
            fields = lines[index + 1].split() if index is not None else []
            expected = [row['cell'][key] for key in ['a', 'b', 'c', 'alpha', 'beta', 'gamma']]
            if len(fields) != 7 or [float(v) for v in fields[:6]] != expected or fields[6] != row['space_group'] or lines[index].split()[-1] != row['id'] or lines[0].strip() != row['mineral_name'] or row['citation'] not in lines:
                unmatched_archive.append(row['id'])
    check('crystal_archive_count', [] if archive_count == crystals['stats']['archive_records'] == 21503 else ['archive count mismatch'])
    check('all_crystal_measurements_match_original_zip', unmatched_archive)
    check('explicit_synthetic_or_computational_headers_excluded', excluded_headers)
    check('catalog_crystal_counts_match', [r['id'] for r in species.values() if r['crystal_record_count'] != len(crystals['by_species'].get(r['id'], []))])

    rows = images['records']
    check('image_metadata_exact_to_acquired_import', [] if images == original_images else ['image metadata differs from original acquired import'])
    check('image_counts_unique_ids_urls', [] if len(rows) == images['stats']['image_references'] == len({r['id'] for r in rows}) == len({r['original_image_url'] for r in rows}) == 780 and len({r['mineral_name'] for r in rows}) == 130 else ['image counts or unique IDs/URLs differ'])
    check('image_species_use_official_names', [r['id'] for r in rows if normal(r['mineral_name']) not in by_name])
    check('image_no_training_ready_claims', [r['id'] for r in rows if r['training_ready'] is not False or r['quality_review'] != 'not_performed_pixels_not_downloaded' or not r['training_blockers']])
    check('image_urls_are_official_https', [r['id'] for r in rows if urlsplit(r['original_image_url']).scheme != 'https' or urlsplit(r['original_image_url']).hostname not in {'www.rruff.net', 'upload.wikimedia.org'}])
    check('commons_individual_author_license_metadata', [r['id'] for r in rows if r['source'] == 'Wikimedia Commons' and (not r['author'] or not r['license'] or not r['permission_evidence_url'])])
    check('rruff_permissions_not_invented', [r['id'] for r in rows if r['source'] == 'RRUFF' and (r['license'] is not None or r['author'] is not None or r['permission_status'] != 'unverified_photo_reuse_permission' or not r['sample_id'])])
    check('handbook_and_rruff_no_blanket_open_license_claim', [] if 'no open' in catalog['external_indexes'][0]['source']['license'].lower() and 'No open license' in physical['source']['license'] and 'no explicit per-photo reuse license confirmed' in images['source_policies']['RRUFF']['photo_permission_conclusion'] else ['rights scope wording differs'])
    manifest = read(repo / 'data/reference-manifest.json')
    for item in manifest['files']:
        path = repo / item['path']
        report['files'][item['path']] = {'bytes': path.stat().st_size, 'sha256': sha(path)}
    report['files']['data/minerals.js'] = {'bytes': (repo / 'data/minerals.js').stat().st_size, 'sha256': sha(repo / 'data/minerals.js')}
    check('published_manifest_hashes', [item['path'] for item in manifest['files'] if report['files'][item['path']] != {'bytes': item['bytes'], 'sha256': item['sha256']}])
    catalog_physical = [r for r in species.values() if 'physical_properties' in r]
    catalog_physical_counts = Counter(p['status'] for r in catalog_physical for p in r['physical_properties'].values())
    report['counts'] = {'ima_species': len(species), 'official_formulas_in_legacy_kb': len(legacy_formulas), 'original_kb_labels': len(kb), 'handbook_links': sum(bool(r.get('handbook_url')) for r in species.values()), 'physical_legacy_labels': len(physical['records']), 'physical_unique_pdf_sources': len(physical_sources), 'verified_label_fields': physical_fields['verified'], 'physical_label_field_status_counts': dict(physical_fields), 'catalog_physical_unique_ima_species': len(catalog_physical), 'catalog_unique_species_verified_fields': catalog_physical_counts['verified'], 'catalog_unique_species_field_status_counts': dict(catalog_physical_counts), 'crystal_records': len(crystal_rows), 'crystal_species': len(crystals['by_species']), 'image_references': len(rows), 'image_species': len({r['mineral_name'] for r in rows}), 'training_ready_images': sum(r['training_ready'] for r in rows)}
    report['original_sources'] = {'ima_pdf': {'file': pdf.name, 'sha256': sha(pdf), 'url': catalog['source']['url']}, 'amcsd_zip': {'file': archive.name, 'sha256': sha(archive), 'url': crystals['source']['download_url']}, 'handbook_pdfs': sorted(physical_sources.values(), key=lambda r: r['url'])}
    report['license_review'] = {'ima': {'license': catalog['source']['license'], 'attribution_file': 'data/licenses/ima-cnmnc-2026-09.txt', 'credits_sha256': sha(repo / 'data/licenses/ima-cnmnc-2026-09.txt')}, 'handbook': {'citation': physical['source']['citation'], 'permissions_url': physical['source']['permissions_url'], 'scope': 'Selected scientific facts and source links only; no open PDF/body-text redistribution license identified.'}, 'amcsd': {'scope': crystals['source']['scope'], 'terms': crystals['source']['terms']}, 'images': {'scope': 'Metadata-only candidate references. Commons licenses remain per-file; RRUFF photo reuse permission remains unverified. No pixels copied or trained.'}, 'live_primary_pages_checked': ['https://handbookofmineralogy.org/', 'https://msaweb.org/copyright-permission-request-form/', 'https://www.rruff.net/about/download-data/']}
    report['limitations'] = ['Original legacy formation, uses and unreplaced attributes are not newly verified.', 'Historical Handbook ranges, mixed crystal systems and directional hardness remain as reported.', 'Thirty-two uncertain cleavage fields and all unverified facts remain null.', 'Acquired files are date-specific; updating an original PDF hash requires another visual review.', 'No photograph quality review, training split, model retraining or accuracy validation is asserted.', 'License wording and attribution are checked; this report does not grant rights to reproduce complete source works.']
    report['anomaly_count'] = sum(v['count'] for v in report['anomalies'].values())
    report['passed'] = report['anomaly_count'] == 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'anomaly_count': report['anomaly_count'], 'counts': report['counts']}, ensure_ascii=False))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()

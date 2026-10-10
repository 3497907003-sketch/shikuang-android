#!/usr/bin/env python3
"""Read a bounded subset of original KB species from official MSA PDFs.

Two workers maximum; global spacing between requests; retains only selected
scientific facts in output, never descriptive paragraphs, images or diagrams.
"""
import argparse
from datetime import date
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from urllib.parse import urlsplit
import hashlib
import json
import re
import subprocess
import threading
import time

import pdfplumber
from pdfplumber.utils import extract_text

PDF_DIR = None
OUTPUT = None
RETRIEVED_AT = None
OFFLINE = False
REQUEST_SPACING = 2.0
REQUEST_LOCK = threading.Lock()
LAST_REQUEST = 0
PROPERTY_KEYS = ('hardness', 'density_measured', 'crystal_system', 'cleavage', 'luster', 'streak')
LABEL_PATTERN = r'(?:Cleavage|Parting|Fracture|Tenacity|Hardness|VHN|D\s*\(\s*(?:meas|calc)\.\s*\)|Density|Luster|Streak|Color|Pleochroism|Anisotropism|Orientation|Dispersion|Reflectance|R|Optical\s*Class|Optical\s*Properties|Physical\s*Properties|Cell\s*Data|Luminescen\w*|Fluorescen\w*|Radioactiv\w*)\s*[:=]'


def decode_page(page):
    # These old PDF fonts falsely advertise WinAnsiEncoding. Their original
    # Computer Modern glyphs were visually checked on the Actinolite source:
    # CM roman '{' displays an en dash; CMSY f/g display braces, ± degrees.
    # CMSY's inaccurate ascent also shifts displayed braces to a later line in
    # normal text extraction. Restore the metric to its displayed parent line.
    chars = []
    for original in page.chars:
        c = dict(original)
        font = c.get('fontname', '').lower()
        if 'cmsy' in font:
            c['text'] = {'f': '{', 'g': '}', '±': '°', '¡': '−', 'k': '∥', '?': '⊥'}.get(c['text'], c['text'])
            shift = c['size'] * .711
            for axis in ['top', 'bottom', 'doctop']:
                c[axis] -= shift
        elif re.search(r'cm(?:r|sl|ti|bx)\d+', font):
            c['text'] = {'{': '–', '}': '—', '®': 'ff', '¯': 'fi', '°': 'fl', '±': 'ffi', '²': 'ffl', '\\': '“'}.get(c['text'], c['text'])
        chars.append(c)
    return extract_text(chars) or ''


def paced_request():
    global LAST_REQUEST
    with REQUEST_LOCK:
        delay = max(0, REQUEST_SPACING - (time.monotonic() - LAST_REQUEST))
        if delay:
            time.sleep(delay)
        LAST_REQUEST = time.monotonic()


def field(text, label, end_pattern=LABEL_PATTERN):
    start = re.search(label, text, re.I)
    if not start:
        return ''
    rest = text[start.end():]
    end = re.search(end_pattern, rest, re.I)
    raw = (rest[:end.start()] if end else rest).strip()
    return re.sub(r'\s+', ' ', raw).strip()


def property_record(raw, url, unit=None):
    value = raw.strip().rstrip('.').strip()
    if re.fullmatch(r'(?:n\.?\s*d\.?|not determined|unknown)', value, re.I):
        value = None
    record = {'value': value or None, 'raw': raw or None, 'source_url': url, 'source_page': 1,
              'status': 'candidate' if value else 'unavailable'}
    if unit:
        record['unit'] = unit
    # Legacy TeX PDF fonts occasionally encode braces/minus/overbar incorrectly
    # in text extraction. Do not promote damaged Miller indices as verified data.
    if raw and (re.search(r'\bf\s+g\b', raw) or '�' in raw or '\\' in raw):
        record['status'] = 'needs_review'
        record['value'] = None
        record['note'] = 'Legacy PDF text encoding requires visual verification; raw extraction retained.'
    if raw and ((raw.lstrip().startswith('[') and not re.match(r'^\s*\[(?:[−-]?\d){3}\]', raw)) or re.search(r'\[[^\]]*[A-Za-z][^\]]*\]', raw)):
        record['status'] = 'source_inferred'
        record['value'] = None
        record['note'] = 'Original source uses square brackets for inferred/calculated/analogical information; excluded from verified facts.'
    return record


def simple_factual_statement(raw):
    # Keep the requested property statement; eliminate a displaced symbol or
    # subsequent spectral/optical text, rather than copying unrelated content.
    if re.match(r'^n\.?\s*d\.?', raw, re.I):
        return raw
    return re.split(r'(?<=\.)\s+', raw, maxsplit=1)[0]


def extract(target):
    url = target['handbook_url']
    parts = urlsplit(url)
    assert parts.scheme == 'https' and parts.hostname in {'handbookofmineralogy.org', 'www.handbookofmineralogy.org'} and parts.path.endswith('.pdf')
    assert re.fullmatch(r'[a-z0-9_-]+', target['key']), 'Unsafe target key'
    path = PDF_DIR / f"{target['key']}.pdf"
    if not path.exists():
        if OFFLINE:
            return {'key': target['key'], 'name_en': target['canonical_name_en'], 'status': 'offline_cache_missing', 'source_url': url}
        paced_request()
        result = subprocess.run(['curl', '--proto', '=https', '--proto-redir', '=https', '--silent', '--show-error', '--fail', '--location', '--max-time', '35', '--retry', '1', '--retry-delay', '4', '--output', str(path), url], capture_output=True, text=True)
        if result.returncode != 0:
            path.unlink(missing_ok=True)
            return {'key': target['key'], 'name_en': target['canonical_name_en'], 'status': 'download_failed', 'source_url': url, 'error': result.stderr.strip()[:300]}
    if not path.read_bytes().startswith(b'%PDF-'):
        return {'key': target['key'], 'name_en': target['canonical_name_en'], 'status': 'not_pdf', 'source_url': url}
    with pdfplumber.open(path) as doc:
        if len(doc.pages) > 3:
            return {'key': target['key'], 'name_en': target['canonical_name_en'], 'status': 'unexpected_page_count', 'source_url': url, 'pages': len(doc.pages)}
        text = decode_page(doc.pages[0])
        if not re.search(r'Physical\s*Properties\s*:', text, re.I):
            return {'key': target['key'], 'name_en': target['canonical_name_en'], 'status': 'no_first_page_physical_section', 'source_url': url}
    # Only parsing working memory contains complete page text. It is neither
    # emitted to logs nor exported into the facts dataset.
    text = re.sub(r'(?<=[a-z])-\n(?=[a-z])', '', text)
    text = re.sub(r'\s+', ' ', text)
    crystal = field(text, r'Crystal\s*Data\s*:\s*', r'Point\s*Group\s*:')
    # The system is the initial statement before the point-group information.
    crystal = re.split(r'\.\s+', crystal, maxsplit=1)[0].strip()
    properties = {
        'hardness': property_record(field(text, r'Hardness\s*=\s*'), url, 'Mohs'),
        'density_measured': property_record(field(text, r'D\s*\(\s*meas\.\s*\)\s*=\s*'), url, 'g/cm³'),
        'crystal_system': property_record(crystal, url),
        'cleavage': property_record(field(text, r'Cleavage\s*:\s*'), url),
        'luster': property_record(simple_factual_statement(field(text, r'Luster\s*:\s*')), url),
        'streak': property_record(simple_factual_statement(field(text, r'Streak\s*:\s*')), url),
    }
    return {'key': target['key'], 'name_en': target['canonical_name_en'], 'original_name_en': target['name_en'],
            'ima_species': target['ima_species'], 'source_title': target['handbook_title'], 'source_url': url,
            'source_pdf_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'properties': properties,
            'missing_original_hardness_or_crystal': not bool(target['hardness'] and target['crystal_system'])}


def write(records, unmatched, complete=False):
    property_counts = {key: dict(Counter(r['properties'][key]['status'] for r in records if 'properties' in r)) for key in PROPERTY_KEYS}
    payload = {'schema_version': 1, 'retrieved_at': RETRIEVED_AT, 'complete': complete,
               'source': {'title': 'Handbook of Mineralogy — selected factual physical properties for original 识矿 entries',
                          'publisher': 'Mineralogical Society of America', 'url': 'https://handbookofmineralogy.org/',
                          'citation': 'John W. Anthony, Richard A. Bideaux, Kenneth W. Bladh, and Monte C. Nichols, Eds., Handbook of Mineralogy, Mineralogical Society of America.',
                          'scope': 'Six factual property fields from a bounded subset of the original KB, not full pages, descriptions, images or diagrams. Every field carries its specific official PDF source.',
                          'license': 'No open license for reproducing PDF texts identified. This collection contains selected scientific facts; do not redistribute the source PDFs as an application asset.',
                          'permissions_url': 'https://msaweb.org/copyright-permission-request-form/'},
               'count': len(records), 'property_counts': property_counts, 'records': sorted(records, key=lambda r: r['key']),
               'unavailable': [{'key': r['key'], 'name_en': r['canonical_name_en'], 'ima_species': r['ima_species'],
                                'reason': 'No exact official Handbook species page in collected index; group, variety or mixture labels are not automatically mapped to a single mineral species.'} for r in unmatched]}
    temp = OUTPUT.with_suffix(OUTPUT.suffix + '.tmp')
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(OUTPUT)
    return {key: value for key, value in payload.items() if key in {'complete', 'count', 'property_counts'}}


def main():
    global PDF_DIR, OUTPUT, RETRIEVED_AT, OFFLINE, REQUEST_SPACING
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets', type=Path, required=True)
    parser.add_argument('--pdf-dir', type=Path, required=True, help='Private source-PDF cache; never package these PDFs in the app')
    parser.add_argument('--output', type=Path, required=True, help='Unreviewed candidate facts JSON, not a publishable data file')
    parser.add_argument('--retrieved-at', default=date.today().isoformat())
    parser.add_argument('--workers', type=int, choices=[1, 2], default=2)
    parser.add_argument('--request-spacing', type=float, default=2.0, help='Seconds between request starts; minimum 2')
    parser.add_argument('--offline', action='store_true', help='Read cached official PDFs without network requests')
    args = parser.parse_args()
    if args.request_spacing < 2.0:
        parser.error('--request-spacing must be at least 2 seconds')
    PDF_DIR, OUTPUT = args.pdf_dir, args.output
    RETRIEVED_AT, OFFLINE, REQUEST_SPACING = args.retrieved_at, args.offline, args.request_spacing
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    targets = json.loads(args.targets.read_text(encoding='utf-8'))
    records = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(extract, row) for row in targets['targets']]
        for future in as_completed(pending):
            records.append(future.result())
            if len(records) % 10 == 0:
                write(records, targets['unmatched'])
                print(json.dumps({'completed': len(records), 'of': len(pending)}, ensure_ascii=False), flush=True)
    report = write(records, targets['unmatched'], complete=True)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

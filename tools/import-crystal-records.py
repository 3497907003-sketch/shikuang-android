"""Extract factual cell parameters from the official AMCSD bulk export.

No atom-coordinate tables, photographs or article body text are redistributed.
Species names must match the official IMA catalogue exactly. An absence of a
synthetic-material note is not treated as proof of natural specimen origin.
"""
import argparse
import collections
import hashlib
import json
import math
import re
import unicodedata
import zipfile
from pathlib import Path


def normal(value):
    return unicodedata.normalize('NFKC', value).strip().casefold().replace('\u2011', '-')


def extract(text):
    lines = text.splitlines()
    if len(lines) < 6:
        return None
    code_index = next((i for i, line in enumerate(lines) if line.startswith('_database_code_amcsd ')), None)
    if code_index is None or code_index + 1 >= len(lines):
        return None
    header = '\n'.join(lines[:code_index])
    # Ambiguous mixed natural/synthetic studies are conservatively omitted.
    if re.search(r'synthetic|synthesi|calculated|simulat|theoretical|hypothetical|idealized|ab initio|first.princip|density functional|\bDFT\b|quantum|mathematical model|optimized|predicted', header, re.I):
        return None
    fields = lines[code_index + 1].split()
    if len(fields) != 7:
        return None
    try:
        values = [float(value) for value in fields[:6]]
    except ValueError:
        return None
    if not all(math.isfinite(x) and x > 0 for x in values) or not all(x < 180 for x in values[3:]):
        return None
    code = lines[code_index].split()[-1]
    if not re.fullmatch(r'\d{7}', code):
        return None
    journal_index = next((i for i in range(2, code_index) if re.search(r'\(\d{4}\)', lines[i])), None)
    if journal_index is None:
        return None
    notes_index = next((i for i in range(journal_index + 1, code_index) if re.match(r'(?:locality|note|sample|pressure|temperature|p\s*=|t\s*=)', lines[i], re.I)), code_index)
    # These are bibliographic identifiers, experimental notes and measurements.
    return {
        'id': code,
        'mineral_name': lines[0].strip(),
        'authors': ' '.join(lines[1:journal_index]),
        'citation': lines[journal_index],
        'article_title': ' '.join(lines[journal_index + 1:notes_index]),
        'experimental_notes': ' '.join(x for x in lines[notes_index:code_index] if not x.startswith('_')),
        'cell': dict(zip(['a', 'b', 'c', 'alpha', 'beta', 'gamma'], values)),
        'space_group': fields[6],
        'source_url': 'https://www.rruff.net/amcsd/',
        'source_id': 'amcsd',
        'sample_origin': '原文未注明；未将缺少合成说明当作天然标本证明',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('catalogue')
    parser.add_argument('archive')
    parser.add_argument('output')
    args = parser.parse_args()
    catalogue = json.loads(Path(args.catalogue).read_text())
    species = {normal(row['name_en']): row['id'] for row in catalogue.get('entries', catalogue.get('minerals', []))}
    by_species = collections.defaultdict(list)
    archive = Path(args.archive)
    total = eligible = 0
    with zipfile.ZipFile(archive) as files:
        for filename in sorted(files.namelist()):
            if not filename.endswith('.amc'):
                continue
            total += 1
            row = extract(files.read(filename).decode('utf8', errors='strict'))
            if row is None:
                continue
            key = species.get(normal(row['mineral_name']))
            if key:
                row['source_file'] = filename
                eligible += 1
                by_species[key].append(row)
    # Retain every matching factual record; the UI renders a bounded selection.
    payload = {
        'schema_version': 1,
        'retrieved_at': '2026-10-10',
        'source': {
            'id': 'amcsd', 'title': 'American Mineralogist Crystal Structure Database / RRUFF',
            'url': 'https://www.rruff.net/about/download-data/',
            'download_url': 'https://www.rruff.net/AMS/zipped_files/amc.zip',
            'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
            'scope': '晶胞测量数值、空间群、实验条件与书目元数据；不含论文正文、照片或原子坐标表',
            'terms': '官方公开批量下载；事实测量数据保留原论文和 AMCSD 归属，未声称论文或图片可自由转载',
        },
        'stats': {'archive_records': total, 'matched_records': eligible, 'species_with_records': len(by_species)},
        'by_species': dict(sorted(by_species.items())),
    }
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps(payload['stats']))


if __name__ == '__main__':
    main()

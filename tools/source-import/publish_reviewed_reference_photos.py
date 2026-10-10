#!/usr/bin/env python3
"""Prepare a small source-verified photo gallery, separate from model training.

Copies only exact reviewed derivative bytes; preserves per-photo attribution and
licensing. Never edits the app, its existing manifest, training CSV or weights.
"""
import argparse, hashlib, json, re, shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageOps


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_kb(path):
    text = path.read_text(encoding='utf-8')
    return json.JSONDecoder().raw_decode(text.split('=', 1)[1].lstrip())[0]


def normalize(name):
    return re.sub(r'[^a-z0-9]', '', name.casefold())


PARENTS = {'amazonite': 'Microcline', 'amethyst': 'Quartz', 'chalcedony': 'Quartz',
           'agate': 'Quartz', 'carnelian': 'Quartz', 'jasper': 'Quartz',
           'chrysoprase': 'Quartz', 'flint': 'Quartz', 'labrador': 'Labradorite'}
NON_SPECIES = {'tourmaline': 'mineral_group', 'apatite': 'mineral_group',
               'tetrahedrite': 'mineral_group',
               'hornblende': 'mineral_group', 'nephritis': 'mineral_aggregate',
               'lapis_lazuli': 'rock_aggregate', 'limonite': 'mineral_aggregate',
               'amber': 'organic_mineraloid', 'opal': 'mineraloid'}
ALIASES = {'antimonite': 'Stibnite', 'cobaltin': 'Cobaltite', 'credit': 'Creedite',
           'cancrinit': 'Cancrinite', 'analcim': 'Analcime', 'vesuvian': 'Vesuvianite',
           'scheelit': 'Scheelite', 'elbait': 'Elbaite', 'barite': 'Baryte',
           'sulfur': 'Sulphur', 'nephritis': 'Nephrite'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--kb', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--existing-image-sources', type=Path, required=True)
    parser.add_argument('--existing-assets-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-per-class', type=int, default=3)
    parser.add_argument('--publish-to-app', type=Path, help='Authorized app root; merge sources and copy only new reviewed photo assets')
    parser.add_argument('--proof-root', type=Path, default=Path.cwd(), help='Base directory of relative source_validation_report paths in the supplied reviewed registry')
    args = parser.parse_args()
    if not 1 <= args.max_per_class <= 3:
        raise ValueError('Bounded gallery proposal supports 1–3 distinct groups per label')
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError('Output already populated: choose a new gallery revision')
    kb = load_kb(args.kb)
    catalog = {normalize(row['name_en']): row for row in json.loads(args.catalog.read_text())['minerals']}
    existing = json.loads(args.existing_image_sources.read_text())['records']
    ids = {row['id'] for row in existing}
    original_sha1s = {row.get('sha1') for row in existing if row.get('sha1')}
    existing_names = {normalize(row['mineral_name']) for row in existing}
    existing_photo_hashes = set()
    for subdir in ['images', 'assets']:
        directory = args.existing_assets_root / subdir
        if directory.is_dir():
            for path in directory.rglob('*'):
                if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
                    existing_photo_hashes.add(sha(path))
    candidates = defaultdict(list)
    rejected = []
    for row in map(json.loads, args.registry.read_text().splitlines()):
        if row.get('training_ready') is not True:
            continue
        raw = args.dataset / row['path']
        crop = args.dataset / row['training_derivative_path']
        valid = (row.get('admission_recommended') and row.get('pixel_review_status') == 'pixel_quality_pass'
                 and row.get('metadata_approved') and row.get('download_provenance_verified')
                 and not row.get('class_conflict_group') and not row.get('known_source_identifier_conflict')
                 and row.get('author') and row.get('license') and row.get('source_url', '').startswith('https://')
                 and raw.is_file() and crop.is_file() and sha(raw) == row.get('file_sha256')
                 and sha(crop) == row.get('training_derivative_sha256'))
        if not valid:
            rejected.append(row['id'])
            continue
        with Image.open(crop) as photo:
            if photo.format != 'JPEG' or min(photo.size) < 224:
                rejected.append(row['id'])
                continue
            row = dict(row, public_width=photo.width, public_height=photo.height)
        with Image.open(raw) as photo:
            raw_size = list(ImageOps.exif_transpose(photo).size)
        if row.get('normalized_crop_box') is None and row.get('training_derivative_pre_resize_size') != raw_size:
            raise ValueError('Crop coordinates missing from an actually cropped photo: ' + row['id'])
        candidates[row['class']].append(row)
    selected = []
    global_hashes = set()
    for key in sorted(candidates):
        pool = candidates[key]
        chosen_groups, scene_domains, localities = set(), set(), set()
        for _ in range(args.max_per_class):
            usable = [row for row in pool if row['group_id'] not in chosen_groups
                      and row['training_derivative_sha256'] not in global_hashes]
            if not usable:
                break
            # Diversity means recorded source scene/locality and aspect ratio,
            # never inferred mineral species or model scores.
            def rank(row):
                locality = re.search(r'Locality:\s*(.*?)(?:\bSize:|\( Locality at)', row.get('source_caption', ''))
                locality = locality[1].strip() if locality else ''
                return (row['id'] in ids,
                        row.get('scene_source_domain') in scene_domains,
                        locality in localities,
                        abs(row['public_width'] / row['public_height'] - 1), row['id'])
            row = min(usable, key=rank)
            selected.append(row)
            chosen_groups.add(row['group_id'])
            global_hashes.add(row['training_derivative_sha256'])
            scene_domains.add(row.get('scene_source_domain'))
            locality = re.search(r'Locality:\s*(.*?)(?:\bSize:|\( Locality at)', row.get('source_caption', ''))
            localities.add(locality[1].strip() if locality else '')
    args.output.mkdir(parents=True)
    records = []
    byte_size = 0
    source_proofs = {}
    for row in selected:
        key = row['class']
        display_name = ALIASES.get(key, kb[key]['name_en'])
        species_name = PARENTS.get(key, display_name)
        label_unit = NON_SPECIES.get(key, 'mineral_variety' if key in PARENTS else 'mineral_species')
        official = catalog.get(normalize(species_name)) if label_unit in {'mineral_species', 'mineral_variety'} else None
        relative = 'images/reviewed-v25/' + row['id'] + '.jpg'
        destination = args.output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.dataset / row['training_derivative_path'], destination)
        assert sha(destination) == row['training_derivative_sha256']
        byte_size += destination.stat().st_size
        url = (row.get('license_url') or '').replace('http://creativecommons.org/', 'https://creativecommons.org/', 1)
        if not url and row['license'] == 'Public domain':
            url = row['source_url']
        records.append({'id': row['id'], 'source_asset_id': row['id'], 'model_key': key,
                        'mineral_name': display_name, 'species_name': species_name,
                        'catalog_id': official['id'] if official else None, 'label_unit': label_unit,
                        'source': 'Wikimedia Commons', 'image_page_url': row['source_url'],
                        'original_image_url': row['original_image_url'],
                        'downloaded_image_url': row.get('download_image_url') or row['original_image_url'],
                        'local_image_url': relative, 'width': row['public_width'], 'height': row['public_height'],
                        'original_image_width': row.get('source_original_width') or row['width'],
                        'original_image_height': row.get('source_original_height') or row['height'],
                        'downloaded_image_width': row.get('downloaded_width'),
                        'downloaded_image_height': row.get('downloaded_height'),
                        'downloaded_asset_kind': 'official_original' if row.get('source_sha1_verified') else 'official_thumbnail',
                        'source_original_sha1': row['source_sha1'], 'source_file_sha256': row['file_sha256'],
                        'crop_sha256': row['training_derivative_sha256'], 'sha256': sha(destination),
                        'bytes': destination.stat().st_size, 'author': row['author'],
                        'license': row['license'], 'license_url': url,
                        'source_license_url_original': row.get('license_url'),
                        'attribution': row['attribution'], 'usage_terms': row.get('usage_terms'),
                        'permission_status': 'per_file_license_and_source_reviewed',
                        'modifications': row['training_derivative_transform'] if row.get('normalized_crop_box') is not None else row['training_derivative_transform'].replace('source-bound normalized ROI', 'full downloaded frame retained; no ROI crop'),
                        'normalized_crop_box': row.get('normalized_crop_box'),
                        'group_id': row['group_id'], 'specimen_id': row.get('specimen_id'),
                        'specimen_namespace': row.get('specimen_namespace'),
                        'source_catalog_identity': row.get('source_catalog_identity'),
                        'scene_source_domain': row.get('scene_source_domain'),
                        'label_scope': row.get('label_scope'),
                        'associated_minerals': row.get('source_companion_minerals', []),
                        'other_source_mineral_mentions': row.get('source_other_model_mentions', []),
                        'replacement_relation_text': row.get('replacement_relation_text'),
                        'quality_review': row['pixel_review']['reason'],
                        'source_validation_report': 'docs/source-validation/reviewed-photo-publication.json',
                        'quality_review_status': 'pixel_quality_pass',
                        'source_review_status': 'per_file_source_label_license_sha_verified',
                        'review_evidence': {'pixel_review_performed': True, 'source_and_license_review_performed': True,
                                            'download_provenance_verified': True, 'source_raw_sha256_verified': True,
                                            'published_derivative_sha256_verified': True,
                                            'source_label_independently_analysed': False},
                        'identification_evidence': {'level': 'source_label_and_pixel_target_reviewed',
                                                    'evidence_url': row['source_url'],
                                                    'analytical_confirmation': None,
                                                    'independently_verified': False},
                        'training_ready': True,
                        'training_status': 'Eligible source-labelled research data; not a claim this photo trained a released model',
                        'reference_gallery_purpose': 'Offline photo/source reference; not model coverage or field accuracy validation'})
        proof_path = Path(row['source_validation_report'])
        if not proof_path.is_absolute():
            proof_path = args.proof_root / proof_path
        if proof_path not in source_proofs:
            source_proofs[proof_path] = {item['id']: item for item in json.loads(proof_path.read_text())['records']}
        proof = source_proofs[proof_path][row['id']]
        if not proof['eligible_for_grouping']:
            raise ValueError('Source proof does not approve this image: ' + row['id'])
        records[-1]['review_evidence']['source_metadata_snapshot_sha256'] = proof['source_metadata_snapshot_sha256']
        records[-1]['review_evidence']['source_pixel_review_sha256'] = hashlib.sha256(json.dumps(row['pixel_review'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    manifest = {'schema_version': 1, 'generated_at': datetime.now(timezone.utc).isoformat(),
                'scope': 'Small offline source-labelled real specimen photo gallery; independent from model training',
                'records': records, 'training_completed_claimed': False,
                'scientific_limitations': ['Source labels are not independently verified XRD/chemical identifications.',
                                         'Groups include conservative photo/catalog proxies; unknown physical identity remains unknown.',
                                         'Varieties, mineral groups and aggregates are explicitly distinguished from IMA species.']}
    (args.output / 'reviewed-photo-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    overlap_id = sum(row['id'] in ids for row in selected)
    overlap_sha = sum(row['source_sha1'] in original_sha1s for row in selected)
    report = {'approved_pool_images': sum(len(pool) for pool in candidates.values()),
              'selected_images': len(records), 'selected_model_labels': len(candidates),
              'distinct_reference_names': len({row['mineral_name'] for row in records}),
              'distinct_exact_ima_species': len({row['catalog_id'] for row in records if row['catalog_id']}),
              'new_reference_names_vs_existing_metadata': sorted({row['mineral_name'] for row in records
                                                                 if normalize(row['mineral_name']) not in existing_names}),
              'source_asset_id_overlap_existing_metadata': overlap_id,
              'source_original_sha1_overlap_existing_metadata': overlap_sha,
              'new_source_records_vs_existing_metadata': len(selected) - overlap_id,
              'existing_local_photo_hash_matches': sum(row['sha256'] in existing_photo_hashes for row in records),
              'all_photo_bytes': byte_size, 'manifest_bytes': (args.output / 'reviewed-photo-manifest.json').stat().st_size,
              'per_label': dict(Counter(row['model_key'] for row in records)), 'failed_approved_revalidation_ids': rejected,
              'freeze_unchanged': 'No frozen dataset, source raw/ROI byte or model was modified. App mutation, when requested, is limited to the gallery data, copied photo assets, license attribution and source audit.',
              'selection_policy': 'At most3 reviewed groups per class; prefer new source IDs, recorded scene/locality diversity, then square aspect. No model predictions used.'}
    (args.output / 'proposal-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if args.publish_to_app:
        app = args.publish_to_app
        source_path = app / 'data/image-sources.json'
        before_bytes = source_path.read_bytes()
        sources = json.loads(before_bytes)
        by_id = {row.get('source_asset_id') or row['id']: row for row in sources['records']}
        added = enhanced = 0
        for photo in records:
            current = by_id.get(photo['source_asset_id'])
            if current and current.get('sha1') and current['sha1'] != photo['source_original_sha1']:
                raise ValueError('Existing source SHA1 changed: ' + photo['id'])
            destination = app / photo['local_image_url']
            if destination.exists() and sha(destination) != photo['sha256']:
                raise ValueError('App photo path would overwrite different bytes: ' + str(destination))
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.output / photo['local_image_url'], destination)
            extra = {'model_species': True, 'model_label_aliases': [photo['model_key']],
                     'sample_id': photo['specimen_id'] if photo['specimen_namespace'] else None,
                     'specimen_group_id': photo['group_id'], 'group_scope': 'Conservative source/photo/catalog grouping, not independently authenticated physical specimen identity',
                     'sha1': photo['source_original_sha1'], 'permission_evidence_url': photo['image_page_url'],
                     'training_blockers': [], 'independent_laboratory_validation': False}
            if current:
                previous_hash = current.get('previous_source_record_sha256') or hashlib.sha256(json.dumps(current, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                current.update(photo);current.update(extra);enhanced += 1
                current['previous_source_record_sha256'] = previous_hash
            else:
                sources['records'].append(dict(photo, **extra));added += 1
        sources['generated_at'] = manifest['generated_at']
        sources['scope'] = 'Original unreviewed online source metadata plus explicitly reviewed local source-labelled photos. Gallery expansion is separate from model training and laboratory accuracy.'
        all_records = sources['records']
        sources['stats'].update({'image_references': len(all_records),
                                'distinct_species': len({row['mineral_name'] for row in all_records}),
                                'distinct_source_names': len({row['mineral_name'] for row in all_records}),
                                'commons_images': sum(row['source'] == 'Wikimedia Commons' for row in all_records),
                                'commons_species': len({row['mineral_name'] for row in all_records if row['source'] == 'Wikimedia Commons'}),
                                'model_species_represented': len({row['mineral_name'] for row in all_records if row.get('model_species')}),
                                'local_images': sum(bool(row.get('local_image_url')) for row in all_records),
                                'training_ready': sum(row.get('training_ready') is True for row in all_records),
                                'reviewed_reference_model_labels': len(candidates),
                                'reviewed_reference_exact_ima_species': report['distinct_exact_ima_species']})
        sources['source_policies']['Wikimedia Commons']['local_photo_publication'] = {
            'scope': 'Only individually licensed, pixel/source/hash/group-reviewed photos are copied offline; other records remain unreviewed metadata.',
            'license_attribution_file': 'data/licenses/reviewed-photo-attributions.json',
            'no_independent_chemical_identification_claim': True,
            'training_ready_meaning': 'Eligible for source-labelled research training; does not mean a released model trained on every gallery photo.'}
        source_path.write_text(json.dumps(sources, ensure_ascii=False, separators=(',', ':')) + '\n')
        assets = [{'path': photo['local_image_url'], 'bytes': photo['bytes'], 'sha256': photo['sha256'],
                   'source_asset_id': photo['source_asset_id']} for photo in records]
        (app / 'data/reviewed-photo-assets.json').write_text(json.dumps({'schema_version': 1, 'assets': assets}, ensure_ascii=False, indent=2) + '\n')
        attribution_fields = ['id', 'local_image_url', 'author', 'license', 'license_url', 'image_page_url',
                              'original_image_url', 'attribution', 'modifications', 'source_original_sha1',
                              'source_file_sha256', 'crop_sha256', 'sha256']
        licensing = {'schema_version': 1, 'scope': 'Each image retains its stated source license independently from application software licensing.',
                     'records': [{key: photo[key] for key in attribution_fields} for photo in records]}
        license_path = app / 'data/licenses/reviewed-photo-attributions.json'
        license_path.parent.mkdir(parents=True, exist_ok=True)
        license_path.write_text(json.dumps(licensing, ensure_ascii=False, indent=2) + '\n')
        license_text = ['识矿 2.5 已审核参考照片逐图归属', '',
                        '各照片分别遵循原页注明的许可；照片许可不改变 App 软件许可。',
                        '本地文件仅由真实来源照片转正、裁切或缩小产生，没有生成或合成图片。',
                        '来源标签与像素审核不等于实验室 XRD/化学独立鉴定。', '']
        for photo in records:
            license_text += [photo['local_image_url'], '作者：' + photo['author'],
                             '许可：' + photo['license'] + ' — ' + photo['license_url'],
                             '来源：' + photo['image_page_url'], '修改：' + photo['modifications'],
                             '本地 SHA-256：' + photo['sha256'], '']
        (app / 'data/licenses/reviewed-photos-v25.txt').write_text('\n'.join(license_text), encoding='utf-8')
        audit = {**report, 'enhanced_existing_source_records': enhanced, 'added_source_records': added,
                 'result_source_records': len(all_records), 'result_source_names': sources['stats']['distinct_source_names'],
                 'old_unreviewed_source_records_preserved': sum(not row.get('local_image_url') for row in all_records),
                 'previous_image_sources_sha256': hashlib.sha256(before_bytes).hexdigest(),
                 'image_sources_sha256': sha(source_path), 'pixel_review_claim': 'Every published file was actually viewed as a full stored photo/contact sheet and any proposed crop was separately visually reviewed.',
                 'analytic_identity_limit': 'Source-labelled photos, not independently linked laboratory/XRD/chemical truth.',
                 'assets': [{**asset, 'raw_sha256': photo['source_file_sha256'],
                             'original_sha1': photo['source_original_sha1'],
                             'license': photo['license'], 'source_url': photo['image_page_url'],
                             'normalized_crop_box': photo['normalized_crop_box'],
                             'source_review_status': photo['source_review_status'],
                             'quality_review_status': photo['quality_review_status']} for asset, photo in zip(assets, records)]}
        audit_path = app / 'docs/source-validation/reviewed-photo-publication.json'
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
        reference = app / 'data/reference-manifest.json'
        reference_manifest = json.loads(reference.read_text())
        for item in reference_manifest['files']:
            if item['path'] == 'data/image-sources.json':
                item.update({'bytes': source_path.stat().st_size, 'sha256': sha(source_path)})
        reference_manifest['counts'].update({'source_image_records': len(all_records), 'local_reviewed_photos': len(records),
                                            'local_reference_exact_ima_species': report['distinct_exact_ima_species']})
        reference.write_text(json.dumps(reference_manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['approved_pool_images', 'selected_images', 'selected_model_labels',
                                                  'distinct_exact_ima_species', 'source_asset_id_overlap_existing_metadata',
                                                  'new_source_records_vs_existing_metadata', 'all_photo_bytes', 'manifest_bytes']}))


if __name__ == '__main__':
    main()

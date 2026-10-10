"""Run existing weights on labeled physical specimens; never invent labels."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('csv', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / 'model-manifest.json').read_text())
    labels = manifest['labels']
    with args.csv.open(newline='', encoding='utf-8-sig') as file:
        rows = list(csv.DictReader(file))
    if not rows:
        raise ValueError('No labeled photos supplied. Fill samples-template.csv with real specimens first.')
    groups, seen_images = {}, {}
    for row in rows:
        specimen = row['specimen_id'].strip()
        if not specimen or row['scene'] not in ('lab', 'daily') or row['split'] not in ('calibration', 'test'):
            raise ValueError('Every photo needs specimen_id, scene and calibration/test split')
        if row['label'] not in labels + ['unknown']:
            raise ValueError('Unsupported ground truth label: ' + row['label'])
        image = (args.csv.parent / row['image']).resolve()
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        if digest in seen_images:
            raise ValueError('Duplicate image bytes in the manifest; remove duplicates before evaluation')
        seen_images[digest] = specimen
        group = groups.setdefault(specimen, [])
        if group and any(row[k] != group[0][k] for k in ['label', 'scene', 'split', 'hardness', 'luster']):
            raise ValueError('A physical specimen must have one scene, split, truth and observation')
        if len(group) >= 3:
            raise ValueError('Use 1–3 photos per specimen, matching the App')
        group.append({**row, 'resolved_image': image})
    sessions = {}
    for model in manifest['models']:
        model_path = root / model['path']
        if hashlib.sha256(model_path.read_bytes()).hexdigest() != model['sha256']:
            raise ValueError('Model checksum mismatch: ' + model['path'])
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        sessions[model['path']] = ort.InferenceSession(str(model_path), options, providers=['CPUExecutionProvider'])
    result = []
    for specimen, photos in groups.items():
        first = photos[0]
        data = {'id': specimen, 'scene': first['scene'], 'split': first['split'], 'label': first['label'],
                'observation': {'hardness': first.get('hardness', ''), 'luster': first.get('luster', '')},
                'runs': [], 'screening': [], 'qualityReports': []}
        for i, photo in enumerate(photos):
            crop = float(photo.get('crop') or 1)
            if not 0.5 <= crop <= 1:
                raise ValueError('crop must be 0.5–1.0')
            with Image.open(photo['resolved_image']) as original:
                image = ImageOps.exif_transpose(original).convert('RGB')
            if min(image.size) < 64:
                data['rejected'] = '照片分辨率过低'
            side = min(image.size) * crop
            left, top = (image.width - side)/2, (image.height - side)/2
            rgb = np.asarray(image.crop((left, top, left+side, top+side)).resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float64)
            gray = rgb @ np.array([0.2126, 0.7152, 0.0722])
            lap = gray[1:-1,:-2] + gray[1:-1,2:] + gray[:-2,1:-1] + gray[2:,1:-1] - 4*gray[1:-1,1:-1]
            data['qualityReports'].append({'mean':float(gray.mean()), 'contrast':float(gray.std()),
                'sharpness':float(lap.var()), 'darkFraction':float((gray<15).mean()), 'brightFraction':float((gray>245).mean())})
            tensor = ((rgb/255 - np.array([0.485, 0.456, 0.406])) / np.array([0.229, 0.224, 0.225])).transpose(2, 0, 1)[None].astype(np.float32)
            for model in manifest['models']:
                session = sessions[model['path']]
                values = session.run(None, {session.get_inputs()[0].name:tensor})[0].reshape(-1)
                if len(values) != model['classes'] or not np.isfinite(values).all():
                    raise ValueError('Invalid model output: ' + model['path'])
                target = data['screening'] if model['classes'] == 1000 else data['runs']
                target.append({'photo':i, 'model':model['path'], 'values':values.tolist()})
        result.append(data)
    args.out.write_text(json.dumps({'schema':'shikuang-evaluation-v2','labels':labels,'specimens':result}, ensure_ascii=False))
    print(f'Wrote raw predictions for {len(result)} physical specimens. Run node tools/evaluate.cjs to calculate metrics.')

if __name__ == '__main__':
    main()

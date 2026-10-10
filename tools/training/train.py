#!/usr/bin/env python3
"""Reviewed-photo training. Validation selects models; a locked test is evaluated once.

This does not certify field/laboratory accuracy. Never use inherited mineral
weights to claim a newly partitioned dataset is an unseen holdout.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urldefrag

import numpy as np
import torch
import torch.nn as nn
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, __version__ as PIL_VERSION
from safetensors.torch import load_file
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms as T
import timm

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
SIZE = 224
MAX_VIEWS = 3  # App accepts at most three photographs of one specimen.
SPLIT_RATIOS = {'train': 0.8, 'val': 0.1, 'test': 0.1}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def read_labels(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    labels = data.get('labels', list(data)) if isinstance(data, dict) else data
    if (not isinstance(labels, list) or len(labels) < 2 or
            any(not isinstance(key, str) or not key.strip() for key in labels) or
            len(labels) != len(set(labels))):
        raise ValueError('Kappa evaluation needs at least two ordered, unique labels')
    return labels


def read_rows(path, root, labels):
    with open(path, encoding='utf-8', newline='') as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValueError(f'No reviewed photos: {path}')
    for row in rows:
        if row.get('training_ready', '').lower() not in ('true', '1', 'yes'):
            raise ValueError('Unreviewed photo cannot enter training or evaluation')
        if row.get('class') not in labels or not row.get('group_id', '').strip():
            raise ValueError('Photo needs a supported class and explicit grouping')
        if (not row.get('source_url', '').startswith('https://') or not row.get('license', '').strip()
                or not row.get('license_url', '').startswith('https://') or not row.get('author', '').strip()):
            raise ValueError('Photo needs per-image source and license evidence')
        specimen_identity(row)
        local = Path(row['path'])
        local = local if local.is_absolute() else Path(root) / local
        if not local.is_file():
            raise ValueError(f'Photo is missing: {row["path"]}')
        actual = digest(local)
        if not row.get('sha256') or row['sha256'] != actual:
            raise ValueError('Reviewed image bytes changed after approval')
        row['resolved_path'] = str(local)
        row['sha256'] = actual
    return rows


def specimen_identity(row):
    specimen = (row.get('specimen_id') or '').strip()
    if not specimen:
        return None
    namespace = (row.get('specimen_namespace') or '').strip()
    if not namespace and ':' in specimen:
        namespace, specimen = specimen.split(':', 1)
    if not namespace or not specimen:
        raise ValueError('Known specimen IDs need an explicit collection/author namespace')
    return namespace, specimen


def partition_audit(partitions, labels=None, enforce_ratios=False):
    owner_groups, owner_hashes, owner_identities = {}, {}, {}
    result = {}
    for split, rows in partitions.items():
        group_labels, group_specimens, specimens = defaultdict(set), defaultdict(set), set()
        for row in rows:
            group = row['group_id']
            group_labels[group].add(row['class'])
            if group in owner_groups and owner_groups[group] != split:
                raise ValueError('Specimen/source group crosses partitions')
            owner_groups[group] = split
            key = row['sha256']
            if key in owner_hashes:
                raise ValueError('Identical photo is repeated or crosses partitions')
            owner_hashes[key] = (split, group, row['class'])
            specimen = specimen_identity(row)
            if specimen:
                specimens.add(group)
                group_specimens[group].add(specimen)
            identities = [('specimen', *specimen)] if specimen else []
            # Source photograph, derivative, video and reviewed duplicate identities
            # must not become independent samples by changing a group_id.
            if row.get('source_url'):
                identities.append(('source_url', urldefrag(row['source_url'])[0]))
            for field in ('source_asset_id', 'video_id', 'duplicate_group_id'):
                if row.get(field):
                    identities.append((field, row[field]))
            for identity in identities:
                owner = owner_identities.setdefault(identity, (split, group, row['class']))
                if owner != (split, group, row['class']):
                    raise ValueError('Known specimen/source/duplicate identity is split into different groups or labels')
        if any(len(names) != 1 for names in group_labels.values()):
            raise ValueError('Conflicting class labels in a specimen/source group')
        if any(len(identities) > 1 for identities in group_specimens.values()):
            raise ValueError('Different known physical specimens are merged into one evaluation group')
        result[split] = {'images': len(rows), 'groups': len(group_labels),
                         'class_counts': dict(Counter(r['class'] for r in rows)),
                         'known_specimen_ids': sum(bool(r.get('specimen_id')) for r in rows),
                         'known_specimen_groups': len(specimens),
                         'source_proxy_groups': len(group_labels) - len(specimens),
                         'group_class_counts': dict(Counter(next(iter(names)) for names in group_labels.values())),
                         'group_ids_sha256': hashlib.sha256('\n'.join(sorted(group_labels)).encode()).hexdigest()}
    if enforce_ratios:
        if set(partitions) != set(SPLIT_RATIOS) or not labels:
            raise ValueError('80/10/10 audit requires train, val, test and explicit labels')
        for key in labels:
            counts = {s: result[s]['group_class_counts'].get(key, 0) for s in SPLIT_RATIOS}
            total = sum(counts.values())
            if total < 10 or any(not value for value in counts.values()):
                raise ValueError(f'{key}: at least 10 disjoint groups and support in every split are required')
            if any(abs(counts[s] - total * ratio) > 1 + 1e-9 for s, ratio in SPLIT_RATIOS.items()):
                raise ValueError(f'{key}: group split differs from 80/10/10 by more than one rounding group')
        total = sum(result[s]['groups'] for s in SPLIT_RATIOS)
        for split in SPLIT_RATIOS:
            result[split]['group_fraction'] = result[split]['groups'] / total
            result[split]['requested_group_fraction'] = SPLIT_RATIOS[split]
    return result


def evaluation_rows(rows, maximum=MAX_VIEWS):
    """Choose views before inference, independently of labels, scores and CSV order."""
    if not isinstance(maximum, int) or not 1 <= maximum <= MAX_VIEWS:
        raise ValueError('Evaluation must use one to three views, matching the App')
    groups = defaultdict(list)
    for row in rows:
        groups[row['group_id']].append(row)
    return [row for group in sorted(groups)
            for row in sorted(groups[group], key=lambda item: item['sha256'])[:maximum]]


def training_audit_rows(rows, labels, maximum=1024):
    """All training groups when bounded; otherwise equal whole-group quotas.

    An audit group keeps the same fixed one-to-three views as validation. CSV
    ordering cannot remove the final classes or cut a selected group in half.
    """
    selected = evaluation_rows(rows)
    groups = defaultdict(list)
    for row in selected:
        groups[row['group_id']].append(row)
    by_class = {key: [] for key in labels}
    for group in sorted(groups):
        key = groups[group][0]['class']
        if key not in by_class or any(row['class'] != key for row in groups[group]):
            raise ValueError('Training audit needs consistent supported group labels')
        by_class[key].append(groups[group])
    if not isinstance(maximum, int) or maximum < len(labels) * MAX_VIEWS or any(not groups for groups in by_class.values()):
        raise ValueError('Training audit budget/support cannot retain every output class')
    if len(selected) <= maximum:
        return selected
    quota = maximum // (len(labels) * MAX_VIEWS)
    return [row for key in labels for group in by_class[key][:quota] for row in group]


def frozen_partitions(checkpoint, args, labels):
    paths, hashes = checkpoint.get('partition_paths'), checkpoint.get('partition_hashes')
    if not isinstance(paths, dict) or not isinstance(hashes, dict) or set(paths) != set(SPLIT_RATIOS):
        raise ValueError('Checkpoint lacks auditable frozen train/validation/test paths; retrain with this contract')
    partitions = {}
    for split in SPLIT_RATIOS:
        if digest(paths[split]) != hashes.get(split):
            raise ValueError('Frozen training partitions changed after checkpoint selection')
        partitions[split] = read_rows(paths[split], args.data_root, labels)
    return partition_audit(partitions, labels, enforce_ratios=True)


def acquire_test_lock(data_root, test_hash, checkpoints, calibration_hash):
    """Dataset lock prevents accidental reuse under a different report filename.

    This local audit record is not tamper-proof: deliberately deleting/moving it
    must be documented and invalidates a claim that the test was evaluated once.
    """
    lock = Path(data_root).resolve() / '.evaluation-locks' / (test_hash + '.json')
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('x', encoding='utf-8') as handle:
        json.dump({'test_sha256': test_hash, 'checkpoints': checkpoints,
                   'calibration_sha256': calibration_hash}, handle)
    return lock


class CenterSquare:
    """Same geometry as 100% app ROI: center square, then bilinear resize.

    PIL and browser rasterizers can differ numerically. Export parity and app
    regression must additionally be measured; this is a geometry contract.
    """
    def __call__(self, image):
        w, h = image.size
        side = min(w, h)
        left, top = (w - side) / 2, (h - side) / 2
        return image.resize((SIZE, SIZE), Image.Resampling.BILINEAR,
                            box=(left, top, left + side, top + side))


class RandomQuarterTurn:
    def __call__(self, image):
        operation = random.choice([None, Image.Transpose.ROTATE_90, Image.Transpose.ROTATE_180, Image.Transpose.ROTATE_270])
        return image if operation is None else image.transpose(operation)


VALIDATION_VARIANTS = ('original', 'rotate90', 'rotate180', 'center_roi75', 'dimmer', 'brighter', 'mild_blur', 'jpeg60')


def validation_variant(image, variant):
    if variant == 'original': return image
    if variant in ('rotate90', 'rotate180'):
        return image.transpose(Image.Transpose.ROTATE_90 if variant == 'rotate90' else Image.Transpose.ROTATE_180)
    if variant == 'center_roi75':
        w, h = image.size; side = min(w, h) * 0.75; left, top = (w - side) / 2, (h - side) / 2
        return image.resize((SIZE, SIZE), Image.Resampling.BILINEAR, box=(left, top, left + side, top + side))
    if variant in ('dimmer', 'brighter'):
        return ImageEnhance.Brightness(image).enhance(0.7 if variant == 'dimmer' else 1.3)
    if variant == 'mild_blur': return image.filter(ImageFilter.GaussianBlur(radius=0.7))
    if variant == 'jpeg60':
        buffer = io.BytesIO(); image.save(buffer, format='JPEG', quality=60); buffer.seek(0)
        with Image.open(buffer) as decoded: return decoded.convert('RGB')
    raise ValueError('Unknown validation-only perturbation')


class PhotoDataset(Dataset):
    def __init__(self, rows, labels, train=False, strength='moderate', variant='original'):
        self.rows, self.classes = rows, {key: i for i, key in enumerate(labels)}
        self.variant = variant
        if train:
            distortion = 0.08 if strength == 'moderate' else 0.12
            brightness = 0.15 if strength == 'moderate' else 0.23
            self.transform = T.Compose([
                T.RandomResizedCrop(SIZE, scale=(0.65, 1.0), ratio=(0.85, 1.18),
                                    interpolation=T.InterpolationMode.BILINEAR),
                T.RandomHorizontalFlip(), T.RandomVerticalFlip(p=0.1),
                T.RandomApply([RandomQuarterTurn()], p=0.5 if strength == 'field' else 0.25),
                T.RandomRotation(18, interpolation=T.InterpolationMode.BILINEAR),
                T.RandomPerspective(distortion_scale=distortion, p=0.2,
                                    interpolation=T.InterpolationMode.BILINEAR),
                T.ColorJitter(brightness=brightness, contrast=brightness,
                              saturation=0.08, hue=0.01),
                T.RandomApply([T.GaussianBlur(3, sigma=(0.1, 0.8))], p=0.12),
                T.ToTensor(), T.Normalize(MEAN, STD),
                T.RandomErasing(p=0.12, scale=(0.01, 0.04), ratio=(0.5, 2.0)),
            ])
        else:
            self.transform = T.Compose([CenterSquare(), T.ToTensor(), T.Normalize(MEAN, STD)])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        with Image.open(row['resolved_path']) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
        return self.transform(validation_variant(image, self.variant)), self.classes[row['class']], index


def seed_worker(worker_id):
    seed = torch.initial_seed() % 2**32
    np.random.seed(seed)
    random.seed(seed)


def loader(rows, labels, args, train=False):
    generator = torch.Generator().manual_seed(args.seed)
    return DataLoader(PhotoDataset(rows, labels, train, getattr(args, 'augmentation', 'moderate'), getattr(args, 'variant', 'original')),
                      batch_size=args.batch_size, shuffle=train, num_workers=args.workers,
                      persistent_workers=args.workers > 0, worker_init_fn=seed_worker,
                      generator=generator)


def model_from_checkpoint(path, device):
    ck = torch.load(path, map_location='cpu', weights_only=False)
    model = timm.create_model(ck['backbone'], pretrained=False, num_classes=len(ck['labels']),
                             drop_rate=ck.get('drop_rate', 0.2))
    model.load_state_dict(ck['state_dict'])
    return model.to(device).eval(), ck


def checked_predictions(values, truth, classes):
    values, truth = np.asarray(values), np.asarray(truth)
    if (values.ndim != 2 or not len(values) or values.shape[1] != classes or
            not np.isfinite(values).all() or truth.shape != (len(values),) or
            not np.issubdtype(truth.dtype, np.integer) or
            np.any(truth < 0) or np.any(truth >= classes)):
        raise ValueError('Evaluation requires finite class-matched outputs and valid integer truth')
    return values, truth


def metrics(logits, truth, labels):
    logits, truth = checked_predictions(logits, truth, len(labels))
    predicted = logits.argmax(axis=1)
    count = len(labels)
    cm = np.zeros((count, count), dtype=np.int64)
    np.add.at(cm, (truth, predicted), 1)
    n = int(cm.sum())
    if not n: raise ValueError('Metrics require at least one labelled sample')
    observed = float(np.trace(cm) / n)
    expected = float(np.dot(cm.sum(axis=0), cm.sum(axis=1)) / n**2)
    kappa = (observed - expected) / (1 - expected) if expected < 1 else None
    tp = np.diag(cm); support = cm.sum(axis=1); predictions = cm.sum(axis=0)
    precision = np.divide(tp, predictions, out=np.zeros(count), where=predictions > 0)
    recall = np.divide(tp, support, out=np.zeros(count), where=support > 0)
    f1 = np.divide(2 * tp, support + predictions, out=np.zeros(count), where=support + predictions > 0)
    top5 = np.argsort(logits, axis=1)[:, -min(5, count):]
    return {'samples': n, 'accuracy': observed, 'kappa': kappa,
            'top5': float(np.any(top5 == truth[:, None], axis=1).mean()),
            'macro_f1_all_labels': float(f1.mean()),
            'macro_f1_supported_labels': float(f1[support > 0].mean()),
            'labels_with_test_support': int((support > 0).sum()),
            'per_class': {key: {'support': int(support[i]), 'precision': float(precision[i]),
                                'recall': float(recall[i]), 'f1': float(f1[i])}
                          for i, key in enumerate(labels)}, 'confusion_matrix': cm.tolist()}


def confidence_metrics(scores, truth, bins=10):
    """Model-score calibration on held-out groups, not identification certainty."""
    scores = np.asarray(scores)
    scores, truth = checked_predictions(scores, truth, scores.shape[1] if scores.ndim == 2 else 0)
    if (not isinstance(bins, int) or bins < 1 or np.any(scores < 0) or np.any(scores > 1 + 1e-6) or
            not np.allclose(scores.sum(axis=1), 1, rtol=0, atol=1e-6)):
        raise ValueError('Calibration metrics require normalized probabilities')
    confidence = scores.max(axis=1)
    correct = (scores.argmax(axis=1) == truth).astype(float)
    ece = 0.0
    for i in range(bins):
        selected = (confidence >= i / bins) & (confidence < (i + 1) / bins if i + 1 < bins else confidence <= 1)
        if selected.any(): ece += selected.mean() * abs(correct[selected].mean() - confidence[selected].mean())
    targets = np.eye(scores.shape[1])[truth]
    return {'expected_calibration_error_10_bins': float(ece),
            'brier_score': float(np.square(scores - targets).sum(axis=1).mean()),
            'negative_log_likelihood': float(-np.log(np.maximum(scores[np.arange(len(truth)), truth], 1e-12)).mean())}


def scenario_metrics(scores, truth, group_ids, rows, labels):
    """Retained metadata only; an absent lab/background observation stays absent."""
    by_group = defaultdict(list)
    for row in rows:
        by_group[row['group_id']].append(row)
    report = {'scope': 'Retained source/review metadata; does not independently verify laboratory or field conditions.', 'fields': {}}
    for field in ('scene_source_domain', 'background', 'lighting', 'device_id', 'coexistence',
                  'lab_scene_confirmed', 'specimen_regularity'):
        selected = defaultdict(list)
        for index, group in enumerate(group_ids):
            raw = [str(row[field]).strip() if row.get(field) is not None else '' for row in by_group[group]]
            unknown = {'', 'unknown', 'none', 'null', 'not_assessed', 'not_recorded'}
            values = {value for value in raw if value.lower() not in unknown}
            if not values:
                value = 'not_recorded'
            elif len(values) != 1 or any(value.lower() in unknown for value in raw):
                value = 'mixed_or_incomplete'
            else:
                value = next(iter(values))
            selected[value].append(index)
        report['fields'][field] = {value: {'groups': len(indices),
                                  'metrics': metrics(scores[indices], truth[indices], labels)
                                  if value not in ('not_recorded', 'mixed_or_incomplete') else None}
                                  for value, indices in selected.items()}
    return report


def bootstrap_kappa(scores, truth, labels, seed, repeats=1000):
    scores, truth = checked_predictions(scores, truth, len(labels))
    if not isinstance(repeats, int) or repeats < 1:
        raise ValueError('Bootstrap needs a positive repeat count')
    randomizer = np.random.default_rng(seed)
    kappas = []
    for _ in range(repeats):
        indices = randomizer.integers(0, len(truth), len(truth))
        value = metrics(scores[indices], truth[indices], labels)['kappa']
        if value is not None:
            kappas.append(value)
    undefined = repeats - len(kappas)
    correct = int((scores.argmax(axis=1) == truth).sum())
    n = len(truth); fraction = correct / n; z = 1.959963984540054
    denominator = 1 + z * z / n
    center = (fraction + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(fraction * (1 - fraction) / n + z * z / (4 * n * n)) / denominator
    perfect = correct == n
    return {'kappa_bootstrap_95_ci': np.quantile(kappas, [0.025, 0.975]).tolist()
            if kappas and undefined < repeats * 0.05 and not perfect else None,
            'accuracy_wilson_95_ci': [max(0.0, center - radius), min(1.0, center + radius)],
            'kappa_interval_withheld_reason': 'No observed errors: empirical resampling cannot estimate unseen-error uncertainty.' if perfect
            else 'At least 5 percent of resamples have undefined Kappa.' if undefined >= repeats * 0.05 else None,
            'kappa_bootstrap_defined_resamples': len(kappas),
            'kappa_bootstrap_undefined_resamples': undefined,
            'kappa_bootstrap_method': 'Specimen/source group resampling; interval withheld for a perfect sample or at least 5% undefined Kappa. Wilson interval describes accuracy on this source distribution, not laboratory extrapolation.'}


@torch.no_grad()
def infer(model, batches, device):
    model.eval()
    outputs, targets = [], []
    for images, truth, _ in batches:
        prediction = model(images.to(device))
        if prediction.ndim != 2 or prediction.shape[0] != len(truth) or not torch.isfinite(prediction).all():
            raise ValueError('Model inference produced invalid outputs')
        outputs.append(prediction.cpu().numpy())
        targets.append(truth.numpy())
    return np.concatenate(outputs), np.concatenate(targets)


def grouped(logits, truth, rows):
    logits = np.asarray(logits)
    logits, truth = checked_predictions(logits, truth, logits.shape[1] if logits.ndim == 2 else 0)
    if len(rows) != len(truth):
        raise ValueError('Photo rows and model predictions differ')
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[row['group_id']].append(index)
    result, targets, ids = [], [], []
    for group, indices in groups.items():
        if len(set(truth[indices])) != 1:
            raise ValueError('Specimen/source group has conflicting truth')
        result.append(logits[indices].mean(axis=0)); targets.append(truth[indices[0]]); ids.append(group)
    return np.asarray(result), np.asarray(targets), ids


def probabilities(logits, temperature=1.0):
    logits = np.asarray(logits)
    if (logits.ndim != 2 or not len(logits) or logits.shape[1] < 2 or not np.isfinite(logits).all() or
            not math.isfinite(temperature) or not 0.3 <= temperature <= 5):
        raise ValueError('Softmax needs finite logits and a validated calibration temperature')
    scaled = logits / temperature
    scaled = scaled - scaled.max(axis=1, keepdims=True)
    values = np.exp(scaled)
    return values / values.sum(axis=1, keepdims=True)


def ensemble_probabilities(outputs, temperatures):
    if not outputs or len(outputs) != len(temperatures):
        raise ValueError('Every selected classifier needs a frozen calibration temperature')
    scores = [probabilities(values, temperature) for values, temperature in zip(outputs, temperatures)]
    if any(values.shape != scores[0].shape for values in scores):
        raise ValueError('Classifier predictions differ in photo count or label order')
    return np.mean(scores, axis=0)


def imagenet_feature_weights(weights, model):
    """Reject an accidentally selected mineral-classifier checkpoint.

    A 1000-output head is necessary evidence, not sufficient proof of provenance;
    the full source URL/hash still needs a separate acquisition review.
    """
    classifier = model.get_classifier()
    names = [name for name, module in model.named_modules() if module is classifier and name]
    if len(names) != 1:
        raise ValueError('ImageNet source needs a traceable full classifier head')
    head = {names[0] + '.' + name: tensor for name, tensor in classifier.state_dict().items()}
    if not head or any(key not in weights or weights[key].ndim < 1 or weights[key].shape[0] != 1000 or
                       weights[key].shape[1:] != tensor.shape[1:] for key, tensor in head.items()):
        raise ValueError('Pretraining must retain the original 1000-class ImageNet head; mineral weights are not allowed')
    return {key: tensor for key, tensor in weights.items() if key not in head}, set(head)


def train(args):
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    if not args.imagenet_source_url.startswith('https://'):
        raise ValueError('ImageNet pretraining needs an official HTTPS acquisition source')
    labels = read_labels(args.labels)
    rows = {s: read_rows(getattr(args, s + '_csv'), args.data_root, labels) for s in ('train', 'val', 'test')}
    audit = partition_audit(rows, labels, enforce_ratios=True)  # Test bytes verified, never inferred or selected upon.
    if any(not audit['train']['class_counts'].get(key) for key in labels):
        raise ValueError('Every output label requires reviewed training photos; shrink coverage explicitly before training')
    for split in ('train', 'val', 'test'):
        if any(not audit[split]['group_class_counts'].get(key) for key in labels):
            raise ValueError('Every reported output class needs disjoint groups in train, validation and test')
    device = torch.device(args.device or ('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'))
    torch.set_num_threads(min(6, torch.get_num_threads()))
    model = timm.create_model(args.backbone, pretrained=False, num_classes=len(labels), drop_rate=args.dropout)
    weights = load_file(str(args.imagenet_weights))
    weights, source_head = imagenet_feature_weights(weights, model)
    mapping = model.load_state_dict(weights, strict=False)
    if mapping.unexpected_keys or set(mapping.missing_keys) != source_head:
        raise ValueError('Pretraining state does not match the requested ImageNet architecture')
    model.to(device)
    train_loader = loader(rows['train'], labels, args, True)
    val_rows = evaluation_rows(rows['val'])
    val_loader = loader(val_rows, labels, args)
    audit_rows = training_audit_rows(rows['train'], labels)
    audit_group_labels = {row['group_id']: row['class'] for row in audit_rows}
    audit_loader = loader(audit_rows, labels, args)
    counts = np.asarray([audit['train']['class_counts'][key] for key in labels], dtype=float)
    base_weights = np.sqrt(np.median(counts) / counts).clip(0.65, 1.6)
    class_weights = torch.tensor(base_weights, dtype=torch.float32, device=device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr / 30)
    best, stale, history = -math.inf, 0, []
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    provenance = {'labels': labels, 'backbone': args.backbone, 'drop_rate': args.dropout,
                  'input': {'shape': [1, 3, SIZE, SIZE], 'layout': 'NCHW', 'dtype': 'float32',
                            'colorSpace': 'RGB', 'pixelScale': 255, 'mean': MEAN, 'std': STD,
                            'crop': 'center square', 'resize': 'bilinear'},
                  'seed': args.seed, 'pretraining_source': 'Declared ImageNet-only backbone; 1000-class source head checked and discarded; random new classifier',
                  'pretraining_original_head_classes': 1000,
                  'pretraining_source_url': getattr(args, 'imagenet_source_url', None),
                  'pretraining_provenance_note': 'Head shape is not proof of training provenance; official source and SHA256 must be reviewed.',
                  'pretraining_sha256': digest(args.imagenet_weights),
                  'partition_hashes': {s: digest(getattr(args, s + '_csv')) for s in rows},
                  'partition_paths': {s: str(getattr(args, s + '_csv').resolve()) for s in rows},
                  'partition_audit': audit, 'dataset_report': str(args.dataset_report or ''),
                  'dataset_report_sha256': digest(args.dataset_report) if args.dataset_report else None,
                  'environment': {'python': sys.version.split()[0], 'torch': str(torch.__version__),
                                  'timm': timm.__version__, 'numpy': np.__version__, 'pillow': PIL_VERSION,
                                  'device': str(device)},
                  'test_used_for_model_selection': False,
                  'validation_used_for_adaptive_class_weights': True,
                  'validation_scope': 'Used repeatedly for class-weight adjustment, checkpoint selection and temperature fitting; only the locked test is untouched.',
                  'evaluation_view_policy': {'maximum_photos_per_group': MAX_VIEWS,
                                             'selection': 'ascending reviewed SHA256 before inference'},
                  'physical_specimen_partition_proven': False,
                  'partition_scope': 'Recorded IDs/source proxies are audited; source-photo proxies do not prove physical-specimen exclusivity.',
                  'training_audit_scope': 'All training groups when at most 1024 capped-view photos, otherwise equal whole-group quotas per class. Monitoring, not full-photo training accuracy or an unseen holdout.',
                  'training_audit_photos': len(audit_rows),
                  'training_audit_groups': len({row['group_id'] for row in audit_rows}),
                  'training_audit_full_group_coverage': len({row['group_id'] for row in audit_rows}) == audit['train']['groups'],
                  'training_audit_group_class_counts': dict(Counter(audit_group_labels.values())),
                  'hyperparameters': {'epochs': args.epochs, 'lr': args.lr, 'weight_decay': args.weight_decay,
                                      'dropout': args.dropout, 'label_smoothing': args.label_smoothing,
                                      'augmentation': args.augmentation, 'warmup_epochs': args.warmup_epochs}}
    print(json.dumps({'device': str(device), 'partitions': {s: {k: audit[s][k] for k in ('images', 'groups')} for s in rows}}, ensure_ascii=False), flush=True)
    for epoch in range(1, args.epochs + 1):
        started = time.monotonic(); model.train()
        warmup = epoch <= args.warmup_epochs
        for name, parameter in model.named_parameters():
            parameter.requires_grad_(not warmup or name in source_head)
        if warmup:
            for layer in model.modules():
                if isinstance(layer, nn.modules.batchnorm._BatchNorm): layer.eval()
        total, samples = 0.0, 0
        for images, truth, _ in train_loader:
            images, truth = images.to(device), truth.to(device)
            optimizer.zero_grad(set_to_none=True)
            prediction = model(images)
            losses = nn.functional.cross_entropy(prediction, truth, weight=class_weights,
                                                 label_smoothing=args.label_smoothing, reduction='none')
            loss = losses.mean()
            if not torch.isfinite(loss): raise RuntimeError('Non-finite training loss')
            loss.backward(); nn.utils.clip_grad_norm_(model.parameters(), 2.0); optimizer.step()
            total += loss.item() * len(truth); samples += len(truth)
        val_logits, val_truth = infer(model, val_loader, device)
        gl, gt, _ = grouped(probabilities(val_logits), val_truth, val_rows); val_metrics = metrics(gl, gt, labels)
        audit_logits, audit_truth = infer(model, audit_loader, device)
        audit_scores, audit_targets, _ = grouped(probabilities(audit_logits), audit_truth, audit_rows)
        train_metrics = metrics(audit_scores, audit_targets, labels)
        score = val_metrics['kappa'] if val_metrics['kappa'] is not None else -1.0
        gap = train_metrics['kappa'] - score if train_metrics['kappa'] is not None else None
        recalls = np.asarray([val_metrics['per_class'][key]['recall'] for key in labels])
        # Bounded per-class penalty, informed by validation only; uncertain source labels cannot receive unbounded weight.
        adjustment = (1 + np.maximum(0, 0.80 - recalls) * 0.35).clip(1, 1.25)
        class_weights = torch.tensor((base_weights * adjustment).clip(0.65, 1.8), dtype=torch.float32, device=device)
        scheduler.step()
        entry = {'epoch': epoch, 'train_loss': total / samples, 'validation_group_kappa': score,
                 'validation_group_accuracy': val_metrics['accuracy'], 'validation_group_macro_f1': val_metrics['macro_f1_all_labels'],
                 'train_audit_kappa': train_metrics['kappa'], 'train_validation_kappa_gap': gap,
                 'seconds': time.monotonic() - started, 'warmup_only': warmup,
                 'class_penalty_weights': class_weights.cpu().tolist()}
        history.append(entry)
        save_json(output.with_suffix('.history.json'), dict(provenance, history=history, device=str(device)))
        print(json.dumps({k: v for k, v in entry.items() if k != 'class_penalty_weights'}, ensure_ascii=False), flush=True)
        if score > best + args.min_delta:
            best, stale = score, 0
            state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            torch.save(dict(provenance, state_dict=state, best_epoch=epoch, best_validation_group_kappa=best), output)
            save_json(output.with_suffix('.validation.json'), dict(val_metrics, epoch=epoch, checkpoint_sha256=digest(output), train_audit=train_metrics, train_validation_kappa_gap=gap))
        else:
            stale += 1
        if epoch > args.warmup_epochs and stale >= args.patience:
            print('Early stopping: validation score did not improve', flush=True); break
    print(json.dumps({'checkpoint': str(output), 'sha256': digest(output), 'best_validation_group_kappa': best,
                      'test_evaluated': False}, ensure_ascii=False), flush=True)


def predict_checkpoints(args, rows):
    labels = read_labels(args.labels)
    device = torch.device(args.device or ('mps' if torch.backends.mps.is_available() else 'cpu'))
    all_logits, checkpoints, truth = [], [], None
    for path in args.checkpoints:
        model, ck = model_from_checkpoint(path, device)
        if ck['labels'] != labels: raise ValueError('Checkpoint label order differs')
        frozen_partitions(ck, args, labels)
        split = 'val' if args.command in ('calibrate', 'stress') else 'test'
        if ck['partition_hashes'][split] != digest(getattr(args, split + '_csv')):
            raise ValueError('Evaluation split differs from the frozen training partition')
        logits, current_truth = infer(model, loader(rows, labels, args), device)
        if truth is not None and not np.array_equal(truth, current_truth): raise ValueError('Evaluation ordering differs')
        truth = current_truth; all_logits.append(logits)
        checkpoints.append({'path': Path(path).name, 'sha256': digest(path), 'best_epoch': ck['best_epoch'],
                            'pretraining_sha256': ck['pretraining_sha256']})
        del model
        if device.type == 'mps': torch.mps.empty_cache()
    return all_logits, truth, checkpoints


def calibration(args):
    labels = read_labels(args.labels); all_rows = read_rows(args.val_csv, args.data_root, labels)
    rows = evaluation_rows(all_rows)
    logits, truth, checkpoints = predict_checkpoints(args, rows)
    _, target, groups = grouped(logits[0], truth, rows)
    group_counts = Counter(r['group_id'] for r in rows)
    sample_weights = torch.tensor([1.0 / group_counts[r['group_id']] for r in rows], dtype=torch.float64)
    temperatures = []
    for values in logits:
        x = torch.tensor(values, dtype=torch.float64); y = torch.tensor(truth)
        scale = torch.tensor(0.0, dtype=torch.float64, requires_grad=True)
        optimizer = torch.optim.LBFGS([scale], lr=0.2, max_iter=80)
        def closure():
            optimizer.zero_grad()
            losses = nn.functional.cross_entropy(x / scale.exp().clamp(0.3, 5), y, reduction='none')
            loss = (losses * sample_weights).sum() / sample_weights.sum()
            loss.backward(); return loss
        optimizer.step(closure); temperatures.append(float(scale.exp().clamp(0.3, 5).detach()))
    report = {'schema': 'shikuang-calibration-v1', 'validation_only': True,
              'validation_sha256': digest(args.val_csv), 'checkpoints': checkpoints,
              'temperatures': temperatures, 'groups': len(groups), 'labels': labels,
              'selection_rule': 'per-model softmax(logits / validation temperature), equal mean over models and photos, then argmax; matches app summarization',
              'temperature_fit_weighting': 'each source/specimen group contributes equal total photo-NLL weight; at most three fixed views',
              'evaluation_view_policy': {'maximum_photos_per_group': MAX_VIEWS,
                                         'selection': 'ascending reviewed SHA256 before inference'},
              'reviewed_photos': len(all_rows), 'evaluated_photos': len(rows),
              'decision_thresholds_tuned': False, 'unknown_input_gate_calibrated': False,
              'calibration_scope': 'Temperature for known classifier labels only; this does not calibrate unknown rejection or decision thresholds.'}
    photo_scores = ensemble_probabilities(logits, temperatures)
    group_scores, target, _ = grouped(photo_scores, truth, rows)
    report['ensemble_validation_metrics'] = metrics(group_scores, target, labels)
    report['ensemble_validation_calibration'] = confidence_metrics(group_scores, target)
    report['per_model_validation_metrics'] = []
    for values, temperature, checkpoint in zip(logits, temperatures, checkpoints):
        scores, target, _ = grouped(probabilities(values, temperature), truth, rows)
        report['per_model_validation_metrics'].append(dict(checkpoint, metrics=metrics(scores, target, labels),
                                                          confidence_calibration=confidence_metrics(scores, target)))
    save_json(args.output, report); print(json.dumps({k: report[k] for k in ('temperatures', 'groups', 'validation_only')}, ensure_ascii=False), flush=True)


def stress(args):
    """Development diagnostics on transformed validation pixels, never a new field holdout."""
    labels = read_labels(args.labels); all_rows = read_rows(args.val_csv, args.data_root, labels)
    rows = evaluation_rows(all_rows)
    calibration = json.loads(Path(args.calibration).read_text(encoding='utf-8'))
    if (not calibration.get('validation_only') or calibration['labels'] != labels or
            calibration['validation_sha256'] != digest(args.val_csv) or
            [digest(p) for p in args.checkpoints] != [p['sha256'] for p in calibration['checkpoints']] or
            len(calibration['temperatures']) != len(args.checkpoints) or
            any(not isinstance(t, (int, float)) or not 0.3 <= t <= 5 for t in calibration['temperatures'])):
        raise ValueError('Stress diagnostics require the frozen validation-only calibration')
    report = {'schema': 'shikuang-validation-stress-v1', 'validation_only': True,
              'validation_sha256': digest(args.val_csv), 'calibration_sha256': digest(args.calibration),
              'scope': 'Controlled transformations of the same reviewed validation photographs. Not independent lab, phone or field photographs; ROI may exclude the labelled target.',
              'variants': {}, 'test_inferred': False}
    baseline = None; per_model_baselines = []
    for variant in VALIDATION_VARIANTS:
        args.variant = variant
        outputs, truth, checkpoints = predict_checkpoints(args, rows)
        scores, targets, groups = grouped(ensemble_probabilities(outputs, calibration['temperatures']), truth, rows)
        predictions = scores.argmax(axis=1)
        if baseline is None: baseline = predictions
        report['variants'][variant] = {'metrics': metrics(scores, targets, labels),
                                       'groups': len(groups), 'top1_stability_to_original': float((predictions == baseline).mean()),
                                       'confidence_calibration': confidence_metrics(scores, targets)}
        single = []
        for index, (values, temperature, checkpoint) in enumerate(zip(outputs, calibration['temperatures'], checkpoints)):
            model_scores, model_targets, _ = grouped(probabilities(values, temperature), truth, rows)
            predicted = model_scores.argmax(axis=1)
            if variant == 'original': per_model_baselines.append(predicted)
            single.append(dict(checkpoint, metrics=metrics(model_scores, model_targets, labels),
                               top1_stability_to_original=float((predicted == per_model_baselines[index]).mean())))
        report['variants'][variant]['per_model_metrics'] = single
        print(json.dumps({'validation_variant': variant, 'kappa': report['variants'][variant]['metrics']['kappa'],
                          'top1_stability_to_original': report['variants'][variant]['top1_stability_to_original']}), flush=True)
    report['checkpoints'] = checkpoints
    save_json(args.output, report)


def evaluate(args):
    labels = read_labels(args.labels); all_rows = read_rows(args.test_csv, args.data_root, labels)
    rows = evaluation_rows(all_rows)
    calibration = json.loads(Path(args.calibration).read_text(encoding='utf-8'))
    if calibration['labels'] != labels: raise ValueError('Calibration label order differs')
    if not calibration.get('validation_only') or calibration['validation_sha256'] == digest(args.test_csv):
        raise ValueError('Test cannot be used for temperature calibration')
    if len(calibration['temperatures']) != len(args.checkpoints) or any(not 0.3 <= t <= 5 for t in calibration['temperatures']):
        raise ValueError('Each frozen classifier needs a valid validation-only temperature')
    expected = [digest(p) for p in args.checkpoints]
    if expected != [p['sha256'] for p in calibration['checkpoints']]: raise ValueError('Calibrated checkpoints changed')
    frozen_audit = None
    for path in args.checkpoints:
        checkpoint = torch.load(path, map_location='cpu', weights_only=False)
        if checkpoint['labels'] != labels:
            raise ValueError('Checkpoint label order differs')
        frozen_audit = frozen_partitions(checkpoint, args, labels)
        if (checkpoint['partition_hashes']['val'] != calibration['validation_sha256'] or
                checkpoint['partition_hashes']['test'] != digest(args.test_csv)):
            raise ValueError('Calibration/test differs from the checkpoint frozen partitions')
        del checkpoint
    # Written before inference. A second attempt must be explicitly investigated, not used to choose different weights.
    lock = acquire_test_lock(args.data_root, digest(args.test_csv), expected, digest(args.calibration))
    outputs, truth, checkpoints = predict_checkpoints(args, rows)
    photo_scores = ensemble_probabilities(outputs, calibration['temperatures'])
    ensemble, target, group_ids = grouped(photo_scores, truth, rows)
    result = metrics(ensemble, target, labels)
    result['confidence_calibration'] = confidence_metrics(ensemble, target)
    result['scenario_metrics'] = scenario_metrics(ensemble, target, group_ids, rows, labels)
    result['per_model_test_metrics'] = []
    for values, temperature, checkpoint in zip(outputs, calibration['temperatures'], checkpoints):
        scores, targets, _ = grouped(probabilities(values, temperature), truth, rows)
        result['per_model_test_metrics'].append(dict(checkpoint, metrics=metrics(scores, targets, labels),
                                                    confidence_calibration=confidence_metrics(scores, targets)))
    result.update(bootstrap_kappa(ensemble, target, labels, args.seed))
    result.update({'schema': 'shikuang-grouped-test-v1', 'unit': 'specimen/source-duplicate group',
                   'photos': len(rows), 'reviewed_photos': len(all_rows), 'groups': len(group_ids), 'labels': labels,
                   'checkpoints': checkpoints, 'test_sha256': digest(args.test_csv),
                   'dataset_test_lock': str(lock), 'partition_audit': frozen_audit,
                   'evaluation_view_policy': {'maximum_photos_per_group': MAX_VIEWS,
                                              'selection': 'ascending reviewed SHA256 before inference'},
                   'test_used_for_selection': False, 'temperature_calibration_split': 'validation',
                   'kappa_target': 0.95, 'target_reached_on_this_dataset': result['kappa'] is not None and result['kappa'] >= 0.95,
                   'target_supported_by_kappa_ci': bool(result['kappa_bootstrap_95_ci'] and result['kappa_bootstrap_95_ci'][0] >= 0.95),
                   'independent_laboratory_accuracy_validated': False,
                   'physical_specimen_partition_proven': False,
                   'mobile_end_to_end_accuracy_validated': False,
                   'evaluation_preprocessing': 'PIL EXIF transpose, RGB, center square, bilinear 224 resize; Canvas score/ranking parity still needs real validation photographs.',
                   'unknown_rejection_validated': False,
                   'app_decision_policy_validated': False,
                   'scope_warning': 'Source-labelled photographs; grouping is only as reliable as retained specimen IDs and duplicate audit. This is not independent lab/field certification.'})
    save_json(args.output, result)
    print(json.dumps({k: result[k] for k in ('kappa', 'accuracy', 'macro_f1_all_labels', 'groups', 'kappa_bootstrap_95_ci', 'target_reached_on_this_dataset')}, ensure_ascii=False), flush=True)


def export(args):
    import onnx
    import onnxruntime as ort
    model, ck = model_from_checkpoint(args.checkpoint, torch.device('cpu'))
    model.eval(); torch.manual_seed(args.seed); sample = torch.randn(1, 3, SIZE, SIZE)
    torch.onnx.export(model, sample, str(args.output), input_names=['input'], output_names=['logits'],
                      opset_version=17, dynamo=False, dynamic_axes={'input': {0: 'batch'}, 'logits': {0: 'batch'}})
    proto = onnx.load(str(args.output), load_external_data=True); onnx.checker.check_model(proto)
    onnx.save_model(proto, str(args.output), save_as_external_data=False)
    session = ort.InferenceSession(str(args.output), providers=['CPUExecutionProvider'])
    with torch.no_grad(): reference = model(sample).numpy()
    actual = session.run(None, {'input': sample.numpy()})[0]
    error = float(np.max(np.abs(actual - reference)))
    if not np.allclose(actual, reference, rtol=2e-4, atol=2e-4): raise ValueError('ONNX export numerical mismatch')
    result = {'checkpoint_sha256': digest(args.checkpoint), 'onnx_sha256': digest(args.output),
              'bytes': Path(args.output).stat().st_size, 'max_export_absolute_error': error,
              'input': {'name': session.get_inputs()[0].name, 'shape': session.get_inputs()[0].shape, 'type': session.get_inputs()[0].type},
              'output': {'name': session.get_outputs()[0].name, 'shape': session.get_outputs()[0].shape, 'type': session.get_outputs()[0].type},
              'labels': ck['labels'], 'quantized': False}
    result['export_check_scope'] = 'PyTorch/ONNX graph agreement on one fixed random input tensor; not photo decoding, resizing or field accuracy.'
    result['browser_preprocessing_score_parity_validated'] = False
    save_json(Path(args.output).with_suffix('.export.json'), result); print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest='command', required=True)
    train_parser = sub.add_parser('train')
    for name in ('train-csv', 'val-csv', 'test-csv', 'labels', 'data-root', 'imagenet-weights', 'output'):
        train_parser.add_argument('--' + name, type=Path, required=True)
    train_parser.add_argument('--dataset-report', type=Path)
    train_parser.add_argument('--imagenet-source-url', required=True, help='Official full ImageNet checkpoint source; preserve acquisition/hash evidence separately')
    train_parser.add_argument('--backbone', default='efficientnet_b0')
    train_parser.add_argument('--epochs', type=int, default=30)
    train_parser.add_argument('--warmup-epochs', type=int, default=2)
    train_parser.add_argument('--lr', type=float, default=3e-4)
    train_parser.add_argument('--weight-decay', type=float, default=4e-4)
    train_parser.add_argument('--dropout', type=float, default=0.25)
    train_parser.add_argument('--label-smoothing', type=float, default=0.03)
    train_parser.add_argument('--patience', type=int, default=6)
    train_parser.add_argument('--min-delta', type=float, default=0.001)
    train_parser.add_argument('--augmentation', choices=['moderate', 'field'], default='moderate')
    train_parser.set_defaults(action=train)
    for name, action in [('calibrate', calibration), ('stress', stress), ('evaluate', evaluate)]:
        p = sub.add_parser(name)
        p.add_argument('--' + ('test-csv' if name == 'evaluate' else 'val-csv'), type=Path, required=True)
        for field in ('labels', 'data-root', 'output'): p.add_argument('--' + field, type=Path, required=True)
        p.add_argument('--checkpoints', nargs='+', type=Path, required=True)
        if name in ('stress', 'evaluate'): p.add_argument('--calibration', type=Path, required=True)
        p.set_defaults(action=action)
    p = sub.add_parser('export')
    p.add_argument('--checkpoint', type=Path, required=True); p.add_argument('--output', type=Path, required=True); p.set_defaults(action=export)
    for p in sub.choices.values():
        p.add_argument('--seed', type=int, default=25010)
        p.add_argument('--device', choices=['cpu', 'cuda', 'mps'])
        p.add_argument('--batch-size', type=int, default=32); p.add_argument('--workers', type=int, default=3)
    args = parser.parse_args(); args.action(args)


if __name__ == '__main__': main()

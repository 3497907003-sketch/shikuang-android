"""Algorithm/contract fixtures only: these tests never train or evaluate a model."""
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
import torch
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'train.py'
spec = importlib.util.spec_from_file_location('shikuang_training', SCRIPT)
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)


def row(identity, label='quartz', **extra):
    return dict(group_id='group:' + identity, **{'class': label},
                sha256=hashlib.sha256(identity.encode()).hexdigest(),
                source_url='https://example.test/photos/' + identity, **extra)


def partitions():
    return {split: [row(f'{label}-{i}', label) for label in ('quartz', 'pyrite') for i in indices]
            for split, indices in [('train', range(8)), ('val', [8]), ('test', [9])]}


class PartitionTests(unittest.TestCase):
    def test_linear_probe_keeps_pretrained_parameters_and_bn_statistics_frozen(self):
        model = torch.nn.Sequential(torch.nn.Linear(4, 4), torch.nn.BatchNorm1d(4), torch.nn.Linear(4, 2))
        model.train()
        original_mean = model[1].running_mean.clone()
        original_weights = model[0].weight.detach().clone()
        training.configure_training_layers(model, {'2.weight', '2.bias'}, head_only=True)
        optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
        optimizer.zero_grad()
        torch.nn.functional.cross_entropy(model(torch.ones(3, 4)), torch.tensor([0, 1, 0])).backward()
        optimizer.step()
        self.assertTrue(torch.equal(model[0].weight, original_weights))
        self.assertTrue(torch.equal(model[1].running_mean, original_mean))
        self.assertIsNone(model[0].weight.grad)
        self.assertIsNotNone(model[2].weight.grad)
        model.train()
        training.configure_training_layers(model, {'2.weight', '2.bias'}, head_only=False)
        self.assertTrue(model[1].training)
        self.assertTrue(all(parameter.requires_grad for parameter in model.parameters()))

    def test_group_ratios_count_groups_not_duplicate_angles(self):
        data = partitions()
        for rows in data.values():
            original = rows[0]
            rows.append(dict(original, sha256=hashlib.sha256(b'other angle' + original['sha256'].encode()).hexdigest()))
        audit = training.partition_audit(data, ['quartz', 'pyrite'], True)
        self.assertEqual([audit[s]['groups'] for s in ('train', 'val', 'test')], [16, 2, 2])
        self.assertEqual([audit[s]['group_fraction'] for s in ('train', 'val', 'test')], [0.8, 0.1, 0.1])
        self.assertEqual(audit['train']['source_proxy_groups'], 16)

    def test_known_specimen_cannot_change_group_to_cross_partitions(self):
        data = {'train': [row('a', specimen_id='42', specimen_namespace='museum-A')],
                'test': [row('b', specimen_id='42', specimen_namespace='museum-A')]}
        with self.assertRaisesRegex(ValueError, 'identity'):
            training.partition_audit(data)
        data['test'][0]['specimen_namespace'] = 'museum-B'
        self.assertEqual(training.partition_audit(data)['test']['known_specimen_groups'], 1)

    def test_known_specimen_cannot_gain_multiple_evaluation_votes_in_one_split(self):
        with self.assertRaisesRegex(ValueError, 'identity'):
            training.partition_audit({'test': [row('a', specimen_id='RRUFF:42'), row('b', specimen_id='RRUFF:42')]})

    def test_missing_specimen_namespace_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'namespace'):
            training.partition_audit({'train': [row('a', specimen_id='42')]})

    def test_distinct_known_specimens_cannot_be_averaged_as_one(self):
        a, b = row('a', specimen_id='Museum:42'), row('b', specimen_id='Museum:43')
        b['group_id'] = a['group_id']
        with self.assertRaisesRegex(ValueError, 'merged'):
            training.partition_audit({'test': [a, b]})

    def test_photo_source_and_duplicate_cluster_cannot_cross_groups(self):
        for field in ('source_url', 'source_asset_id', 'video_id', 'duplicate_group_id'):
            data = {'train': [row('a')], 'test': [row('b')]}
            for rows in data.values():
                rows[0][field] = 'https://example.test/shared' if field == 'source_url' else 'shared:' + field
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'identity'):
                training.partition_audit(data)

    def test_exact_repeats_and_conflicting_labels_cannot_enter_training(self):
        for label in ('quartz', 'pyrite'):
            a, b = row('a'), row('b', label)
            b['sha256'] = a['sha256']
            with self.subTest(label=label), self.assertRaisesRegex(ValueError, 'Identical'):
                training.partition_audit({'train': [a, b]})
        a, b = row('a'), row('b', 'pyrite')
        b['group_id'] = a['group_id']
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            training.partition_audit({'train': [a, b]})

    def test_missing_support_small_sets_and_bad_split_ratios_fail(self):
        for data in [{'train': [row('a')], 'val': [row('b')], 'test': [row('c')]},
                     dict(train=[row(str(i)) for i in range(2)], val=[row(str(i)) for i in range(2, 6)],
                          test=[row(str(i)) for i in range(6, 10)])]:
            with self.assertRaises(ValueError):
                training.partition_audit(data, ['quartz'], True)

    def test_fixed_views_are_bound_to_app_limit_and_independent_of_row_order(self):
        rows = [row(str(i)) for i in range(5)]
        for item in rows:
            item['group_id'] = 'one-specimen'
        selected = training.evaluation_rows(rows)
        self.assertEqual(len(selected), 3)
        self.assertEqual(selected, training.evaluation_rows(list(reversed(rows))))
        self.assertEqual([r['sha256'] for r in selected], sorted(r['sha256'] for r in rows)[:3])
        with self.assertRaises(ValueError):
            training.evaluation_rows(rows, 4)

    def test_training_monitor_keeps_last_classes_and_whole_groups(self):
        # More than 1024 rows ordered by class reproduces the former lost-class path.
        labels = ['first', 'middle', 'last']
        rows = []
        for label in labels:
            for group in range(150):
                for angle in range(3):
                    item = row(f'{label}-{group}-{angle}', label)
                    item['group_id'] = f'{label}:{group}'
                    rows.append(item)
        selected = training.training_audit_rows(rows, labels)
        self.assertLessEqual(len(selected), 1024)
        self.assertEqual({item['class'] for item in selected}, set(labels))
        self.assertEqual(selected, training.training_audit_rows(list(reversed(rows)), labels))
        counts = training.Counter(item['group_id'] for item in selected)
        self.assertEqual(set(counts.values()), {3})
        class_counts = training.Counter(item['class'] for item in selected)
        self.assertEqual(len(set(class_counts.values())), 1)
        short = rows[:3] + rows[450:453] + rows[900:903]
        self.assertEqual(len(training.training_audit_rows(short, labels)), 9)

    def test_dataset_test_lock_survives_report_filename_and_checkpoint_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = training.acquire_test_lock(temporary, 'a' * 64, ['first'], 'calibration')
            self.assertEqual(json.loads(lock.read_text())['checkpoints'], ['first'])
            with self.assertRaises(FileExistsError):
                training.acquire_test_lock(temporary, 'a' * 64, ['other-weights'], 'other-report')

    def test_calibration_reaudits_frozen_identity_and_image_bytes(self):
        # Byte fixtures verify the registry contract; no PhotoDataset/model is invoked.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, paths, hashes = partitions(), {}, {}
            for split, rows in data.items():
                path = root / (split + '.csv')
                for item in rows:
                    file = root / (item['group_id'].replace(':', '_') + '.bin')
                    file.write_bytes(item['group_id'].encode())
                    item.update(path=str(file), sha256=training.digest(file), training_ready='true',
                                license='CC0', license_url='https://example.test/cc0', author='Registry fixture')
                with path.open('w', newline='', encoding='utf-8') as handle:
                    writer = csv.DictWriter(handle, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
                paths[split], hashes[split] = str(path), training.digest(path)
            checkpoint = dict(partition_paths=paths, partition_hashes=hashes)
            args = SimpleNamespace(data_root=root)
            training.frozen_partitions(checkpoint, args, ['quartz', 'pyrite'])
            victim = Path(data['train'][0]['path']); victim.write_bytes(b'changed after approval')
            with self.assertRaisesRegex(ValueError, 'bytes changed'):
                training.frozen_partitions(checkpoint, args, ['quartz', 'pyrite'])
            victim.write_bytes(data['train'][0]['group_id'].encode())
            path = Path(paths['val']); path.write_text(path.read_text() + '\n')
            with self.assertRaisesRegex(ValueError, 'partitions changed'):
                training.frozen_partitions(checkpoint, args, ['quartz', 'pyrite'])
            # Even newly matching CSV hashes cannot bypass known specimen identity.
            data['train'][0].update(specimen_id='Museum:42')
            data['test'][0].update(specimen_id='Museum:42')
            for split, rows in data.items():
                for item in rows:
                    item.setdefault('specimen_id', '')
                path = Path(paths[split])
                with path.open('w', newline='', encoding='utf-8') as handle:
                    writer = csv.DictWriter(handle, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
                hashes[split] = training.digest(path)
            with self.assertRaisesRegex(ValueError, 'identity'):
                training.frozen_partitions(checkpoint, args, ['quartz', 'pyrite'])

    def test_unreviewed_data_and_image_hash_changes_stop_before_model_loading(self):
        with patch.object(training, 'read_labels', return_value=['a', 'b']), \
                patch.object(training, 'read_rows', side_effect=ValueError('unreviewed')), \
                patch.object(training.timm, 'create_model') as create_model:
            args = SimpleNamespace(seed=1, imagenet_source_url='https://example.test/weights',
                                   labels='labels', train_csv='train', val_csv='val', test_csv='test', data_root='root')
            with self.assertRaisesRegex(ValueError, 'unreviewed'):
                training.train(args)
            create_model.assert_not_called()


class MetricTests(unittest.TestCase):
    def test_inherited_mineral_head_cannot_be_stripped_and_declared_imagenet(self):
        class Backbone(torch.nn.Module):
            def __init__(self):
                super().__init__(); self.classifier = torch.nn.Linear(4, 2)
            def get_classifier(self):
                return self.classifier
        model = Backbone()
        for output_classes in (2, 98):
            with self.subTest(classes=output_classes), self.assertRaisesRegex(ValueError, '1000'):
                training.imagenet_feature_weights({'classifier.weight': torch.zeros(output_classes, 4),
                                                  'classifier.bias': torch.zeros(output_classes)}, model)
        weights, keys = training.imagenet_feature_weights({'classifier.weight': torch.zeros(1000, 4),
                                                          'classifier.bias': torch.zeros(1000), 'features': torch.ones(1)}, model)
        self.assertEqual(set(weights), {'features'})
        self.assertEqual(keys, {'classifier.weight', 'classifier.bias'})

    def test_kappa_macro_f1_and_confidence_have_known_values(self):
        result = training.metrics(np.array([[2, 0]] * 4 + [[0, 2]] + [[0, 2]] * 4 + [[2, 0]]),
                                  np.array([0] * 5 + [1] * 5), ['a', 'b'])
        self.assertAlmostEqual(result['accuracy'], 0.8)
        self.assertAlmostEqual(result['kappa'], 0.6)
        self.assertAlmostEqual(result['macro_f1_all_labels'], 0.8)
        result = training.confidence_metrics(np.eye(2), np.array([0, 1]))
        self.assertEqual(result['brier_score'], 0)
        self.assertEqual(result['expected_calibration_error_10_bins'], 0)

    def test_nonfinite_outputs_bad_truth_and_nonprobability_calibration_fail(self):
        for outputs, truth in [(np.array([[np.nan, 0]]), np.array([0])),
                               (np.array([[0, 1]]), np.array([2])),
                               (np.array([[0, 1]]), np.array([0.0]))]:
            with self.subTest(outputs=outputs), self.assertRaises(ValueError):
                training.metrics(outputs, truth, ['a', 'b'])
        with self.assertRaises(ValueError):
            training.confidence_metrics(np.array([[0.8, 0.8]]), np.array([0]))
        with self.assertRaises(ValueError):
            training.probabilities(np.array([[0, np.inf]]))
        with self.assertRaises(ValueError):
            training.ensemble_probabilities([np.array([[0, 1]])], [])

    def test_scene_coverage_does_not_invent_background_device_or_lab_conditions(self):
        rows = [dict(group_id='a', background='complex', lighting='unknown'),
                dict(group_id='b'), dict(group_id='c', background='clean'), dict(group_id='c')]
        report = training.scenario_metrics(np.array([[0.8, 0.2], [0.2, 0.8], [0.6, 0.4]]),
                                           np.array([0, 1, 0]), ['a', 'b', 'c'], rows, ['a', 'b'])['fields']
        self.assertEqual(report['background']['complex']['groups'], 1)
        self.assertIsNone(report['background']['mixed_or_incomplete']['metrics'])
        self.assertEqual(report['lighting']['not_recorded']['groups'], 3)
        self.assertEqual(report['lab_scene_confirmed']['not_recorded']['groups'], 3)
        self.assertEqual(report['device_id']['not_recorded']['groups'], 3)

    def test_tiny_perfect_test_does_not_publish_spuriously_precise_kappa_interval(self):
        result = training.bootstrap_kappa(np.eye(2), np.array([0, 1]), ['a', 'b'], 1, repeats=100)
        self.assertIsNone(result['kappa_bootstrap_95_ci'])
        self.assertGreater(result['kappa_bootstrap_undefined_resamples'], 5)
        self.assertEqual(result['kappa_bootstrap_undefined_resamples'] + result['kappa_bootstrap_defined_resamples'], 100)
        result = training.bootstrap_kappa(np.tile(np.eye(2), (10, 1)), np.tile([0, 1], 10), ['a', 'b'], 1, repeats=100)
        self.assertIsNone(result['kappa_bootstrap_95_ci'])
        self.assertIn('No observed errors', result['kappa_interval_withheld_reason'])
        self.assertLess(result['accuracy_wilson_95_ci'][0], 0.9)
        self.assertAlmostEqual(result['accuracy_wilson_95_ci'][1], 1)

    @unittest.skipUnless(shutil.which('node'), 'Node is required to compare the real Core implementation')
    def test_temperature_models_views_and_group_scores_match_real_core(self):
        # Arithmetic fixtures, deliberately unequal temperatures and nonlinear logits.
        outputs = [np.array([[8, 2, -3], [0, 2, 5], [1, 3, 2]], dtype=float),
                   np.array([[0, 2, 4], [3, 2, 0], [4, 1, 0]], dtype=float)]
        temperatures, rows, truth = [0.7, 2.1], [dict(group_id='one') for _ in range(3)], np.array([0, 0, 0])
        scores, _, _ = training.grouped(training.ensemble_probabilities(outputs, temperatures), truth, rows)
        runs = [dict(photo=i, model=str(m), values=values.tolist(), output='logits', temperature=temperatures[m])
                for m, model in enumerate(outputs) for i, values in enumerate(model)]
        core = SCRIPT.parents[2] / 'core.js'
        result = subprocess.run(['node', '-e', 'const c=require(process.argv[1]);const runs=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(c.summarize(runs,["a","b","c"]).scores));',
                                 str(core), json.dumps(runs)], check=True, capture_output=True, text=True)
        np.testing.assert_allclose(scores[0], json.loads(result.stdout), rtol=0, atol=1e-12)


if __name__ == '__main__':
    unittest.main()

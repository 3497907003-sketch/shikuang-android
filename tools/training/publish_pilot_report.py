#!/usr/bin/env python3
"""Publish source-photo pilot evidence without local paths or photo bytes.

This exports completed diagnostics, never runs a test or promotes a model.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
read = lambda path: json.loads(Path(path).read_text(encoding='utf-8'))


def publish(run, splits, output):
    selection = read(run / 'frozen-selection.json')
    test = read(run / 'grouped-test.json')
    calibration = read(run / 'calibration.json')
    stress = read(run / 'validation-stress.json')
    parity = read(run / 'validation-parity-report.json')
    for file, field in [('calibration.json', 'calibration_sha256'),
                        ('validation-stress.json', 'validation_stress_sha256'),
                        ('validation-parity-report.json', 'validation_browser_parity_sha256')]:
        if sha(run / file) != selection[field]:
            raise ValueError('Frozen development evidence changed')
    if (test['test_used_for_selection'] or not calibration['validation_only'] or
            selection['test_csv_sha256'] != sha(splits / 'test.csv') or
            test['test_sha256'] != selection['test_csv_sha256']):
        raise ValueError('Pilot evidence does not match the frozen test identity')
    for checkpoint in test['checkpoints']:
        name = Path(checkpoint['path']).stem
        if sha(run / checkpoint['path']) != selection['selected_checkpoint_sha256'][name]:
            raise ValueError('Selected checkpoint changed')
    test = dict(test)
    test['dataset_test_lock'] = Path(test['dataset_test_lock']).name
    attempts = []
    for directory in ('pilot8-v1', 'pilot8-v2'):
        folder = run.parent / directory
        if sha(folder / 'protocol.json') != selection['protocols_sha256'][directory]:
            raise ValueError('A declared training protocol changed')
        models = []
        for name in selection['selected_checkpoint_sha256']:
            v = read(folder / (name + '.validation.json'))
            history = read(folder / (name + '.history.json'))
            models.append({'backbone':name,'checkpoint_sha256':v['checkpoint_sha256'],
                'selected_epoch':v['epoch'],'validation_kappa':v['kappa'],
                'training_audit_kappa':v['train_audit']['kappa'],
                'training_validation_kappa_gap':v['train_validation_kappa_gap'],
                'pretraining_source_url':history['pretraining_source_url'],
                'pretraining_sha256':history['pretraining_sha256'],
                'hyperparameters':history['hyperparameters'],
                'epoch_history':history['history']})
        attempts.append({'run':directory,'protocol_sha256':sha(folder/'protocol.json'),'models':models})
    photos = []
    fields = ('id','class','group_id','sha256','source_asset_id','source_url','author','license',
              'license_url','source_sha1','source_file_sha256','crop_sha256','specimen_id',
              'specimen_namespace','source_catalog_identity','source_label_basis','label_scope')
    for split in ('train','val','test'):
        with (splits / (split + '.csv')).open(encoding='utf-8', newline='') as handle:
            for row in csv.DictReader(handle):
                photos.append(dict(split=split, **{key:row.get(key,'') for key in fields}))
    report = {'schema':'shikuang-real-photo-retraining-pilot-v1','evaluated_at':'2026-10-11',
        'scope':'Eight predeclared source-labelled mineral classes; not all production labels, independent laboratory scenes, unknown rejection, or Android accuracy.',
        'training_target_kappa':0.95,'training_target_verified':False,
        'production_model_replaced':False,'production_output_labels':98,
        'image_source':'Real Wikimedia Commons specimen photos with retained per-image permissions and source-labelled dominant mineral; no generated training photos.',
        'known_physical_specimen_grouping_proven':False,
        'data_hashes':{split:sha(splits/(split+'.csv'))for split in ('train','val','test')},
        'training_attempts':attempts,'frozen_selection':selection,'validation_calibration':calibration,
        'validation_transform_stress':stress,'validation_browser_preprocessing':parity,
        'locked_source_photo_test':test,'reviewed_photo_source_registry':photos,
        'limitations':['The holdout has only 14 source/duplicate groups with 1–5 groups per class.',
            'Most groups are conservative source-photo proxies, not independently confirmed physical specimen IDs.',
            'Validation was used for development, early stopping, loss feedback and temperature fitting.',
            'Canvas and PIL gave the same top choice for these 18 validation groups, but scores differ materially.',
            'The new candidates were rejected for production before the test because validation performance and rotation robustness were insufficient.',
            'This published test is consumed; future development cannot call its repeated evaluation a new blind test.']}
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'output':str(output),'sha256':sha(output),'photos':len(photos),
                      'test_kappa':test['kappa'],'production_model_replaced':False}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('run','splits','output'):parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args();publish(args.run,args.splits,args.output)

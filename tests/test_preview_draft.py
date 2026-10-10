"""Portable draft-uploader gate tests using controlled fixtures, never acceptance evidence.

Run with: python3 -m unittest discover -s tests -p test_preview_draft.py -v
Uses only the standard library and does not call GitHub, download, or upload.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

REPO_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('preview_draft', REPO_ROOT / 'tools/publish_preview_draft.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
COMMIT, TAG = 'a' * 40, 'v2.5.0-preview.1'


def run_fixture():
    return {'status': 'completed', 'conclusion': 'success', 'head_sha': COMMIT,
            'head_repository': {'full_name': g.REPO}, 'workflow_id': 42,
            'path': '.github/workflows/android.yml', 'event': 'workflow_dispatch'}


def jobs_fixture():
    def job(name, steps):
        return {'name': name, 'status': 'completed', 'conclusion': 'success',
                'steps': [{'name': s, 'conclusion': 'success'} for s in steps]}
    build, runtime = [job('build', g.BUILD_STEPS)], []
    for key, (sdk, page, tag) in g.MATRICES.items():
        j = job(f'runtime ({sdk}, {key}, {tag}, {page})', g.RUNTIME_STEPS)
        j['steps'].append({'name': 'Probe disconnected networking throughout the original build interval', 'conclusion': 'skipped'})
        runtime.append(j)
    return build, runtime


def artifact_job_fixture():
    return {'id': 9, 'run_id': 123, 'head_sha': COMMIT, 'run_attempt': 2, 'status': 'completed', 'conclusion': 'success',
            'started_at': '2026-10-10T00:00:00Z', 'completed_at': '2026-10-10T00:10:00Z',
            'steps': [{'name': 'Run actions/upload-artifact@v4', 'status': 'completed', 'conclusion': 'success',
                       'started_at': '2026-10-10T00:05:00Z', 'completed_at': '2026-10-10T00:06:00Z'}]}


def artifact_fixture():
    return {'id': 7, 'name': 'apk', 'expired': False, 'size_in_bytes': 100, 'workflow_run': {'id': 123, 'head_sha': COMMIT},
            'digest': 'sha256:' + 'a' * 64, 'created_at': '2026-10-10T00:05:30Z', 'updated_at': '2026-10-10T00:05:30Z'}


def runtime_fixture(root, key):
    """Minimal controlled schema, visibly unrelated to any real run/artifact."""
    sdk, page, tag = g.MATRICES[key]
    manifest = {'version': 'controlled-test-fixture', 'models': [{'id': str(i), 'sha256': str(i) * 64} for i in range(4)],
                'modes': {'ensemble': ['0', '1', '2']}}
    manifest_sha, photo_sha = 'a' * 64, 'b' * 64
    photos = {'assets': [{'path': f'controlled-fixture/{i}.jpg', 'bytes': i + 1, 'sha256': 'c' * 64} for i in range(117)]}
    reference = {'counts': {'source_image_records': 871, 'species_with_records': 3430}, 'files': [{}, {}, {}]}
    device = {'sdk': sdk, 'pageSize': page, 'packageName': g.PACKAGE, 'versionCode': g.VERSION_CODE,
              'versionName': g.VERSION, 'activeNetwork': None, 'connected': False}
    images = [{**row, 'decoded': True, 'complete': True, 'blobUrl': f'controlled-fixture:first:{i}'} for i, row in enumerate(photos['assets'][:3])]
    runtime = {'phase': 'passed', 'errors': [], 'network': {'native': device}, 'networkAfterCatalog': {'native': copy.deepcopy(device)},
               'quartz': {'key': 'quartz', 'engine': 'onnx-native-android', 'modelCount': 3, 'manifestSha256': manifest_sha, 'modelVersion': manifest['version']},
               'fast': {'modelCount': 1, 'engine': 'onnx-native-android', 'manifestSha256': manifest_sha, 'diagnostics': {'residentSessionCount': 2}},
               'cancelTrigger': 'native-progress', 'cancelError': {'name': 'AbortError'}, 'lastError': {'message': g.NON_MINERAL},
               'savedRecords': [{'id': 'controlled-fixture-record'}], 'recordsAfterRejection': [{'id': 'controlled-fixture-record'}],
               'visibleVersion': '2.5', 'initialReferenceRequests': [],
               'catalog': {'imaSpecies': 6239, 'imageReferences': 871, 'crystalSpecies': 3430, 'online': False, 'localFetches': 4},
               'photoGeometry': {'exifOrientation': 6, 'crops': [{}, {}, {}]}, 'screenshots': [{'visualStateSynchronized': True} for _ in range(6)],
               'galleryPhotos': images, 'galleryReopened': [{**image, 'blobUrl': f'controlled-fixture:repeat:{i}'} for i, image in enumerate(images)], 'galleryRevokedCount': 3}
    if key == '24':
        runtime = {'phase': 'unsupported-webview-recovery-passed', 'network': {'native': device}, 'photoRecognitionVerified': False,
                   'boot': {'supported': False, 'missing': ['controlled fixture API']}, 'recovery': '本机标本和历史记录会保留'}
    native = {'phase': 'passed', 'sdk': sdk, 'pageSize': page, 'runtimeVersion': '1.24.3',
              'graphs': [{**m, 'finiteOutput': True} for m in manifest['models']]}
    decoded = {**device, 'phase': 'passed', 'activeNetworkBefore': None, 'activeNetworkAfter': None, 'photoManifestSha256': photo_sha,
               'photosDecoded': 117, 'sourceRecords': 871,
               'photos': [{**row, 'actualNativeDecode': True, 'width': 224, 'height': 512} for row in photos['assets']]}
    migration = {'phase': 'migration-passed', 'historyPreserved': True, 'controller': False, 'registrationCount': 0,
                 'poisonedPage': False, 'cacheSeeded': True, 'registration_supported': True, 'controllerSeeded': True}
    docs = {'runtime-report.json': runtime, 'native-contract-runtime.json': native,
            'reviewed-photo-runtime.json': decoded, 'asset-migration-report.json': migration}
    (root / 'device-page-size.txt').write_text(str(page))
    (root / 'system-image.txt').write_text(f'system-images;android-{sdk};{tag};x86_64')
    for name, data in docs.items():
        (root / name).write_text(json.dumps(data))
    return (manifest, manifest_sha, reference, photos, photo_sha), docs


class DraftGateTests(unittest.TestCase):
    def test_manual_draft_workflow(self):
        source = (REPO_ROOT / '.github/workflows/publish-preview-draft.yml').read_text()
        self.assertIn('  workflow_dispatch:', source)
        for event in ('push:', 'pull_request:', 'schedule:', 'workflow_run:'):
            self.assertNotIn(event, source)
        self.assertIn('--upload-draft', source)
        self.assertIn('--preflight-only', source)
        self.assertIn('persist-credentials: false', source)
        self.assertNotIn('gh release edit', source)

    def test_valid_identity(self):
        g.identity(g.REPO, '123', '456', COMMIT, TAG)

    def test_valid_run(self):
        g.validate_run(run_fixture(), {'id': 42}, '.github/workflows/android.yml', COMMIT, True)

    def test_valid_jobs(self):
        g.validate_jobs(*jobs_fixture())

    def test_wrong_existing_tag(self):
        result = SimpleNamespace(returncode=0, stdout=json.dumps({'object': {'type': 'commit', 'sha': 'b' * 40}}), stderr='')
        with patch.object(g, 'api_pages', return_value=[]), patch.object(g.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'different Android head'):
                g.release_state(TAG, COMMIT)

    def test_published_during_upload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'controlled-fixture.txt').write_text('fixture, never release evidence')
            existing = {'id': 1, 'draft': True, 'prerelease': True, 'target_commitish': COMMIT}
            with patch.object(g, 'release_state', return_value=existing), patch.object(g, 'api', return_value={**existing, 'draft': False, 'assets': []}), patch.object(g, 'command') as cmd:
                with self.assertRaisesRegex(ValueError, 'published or changed'):
                    g.upload_draft(SimpleNamespace(tag=TAG, source_commit=COMMIT, output=root), root, {})
                cmd.assert_not_called()

    def test_different_existing_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); file = root / 'controlled-fixture.txt'; file.write_text('fixture, never release evidence')
            existing = {'id': 1, 'draft': True, 'prerelease': True, 'target_commitish': COMMIT,
                        'assets': [{'name': file.name, 'digest': 'sha256:' + 'f' * 64}]}
            with patch.object(g, 'release_state', return_value=existing), patch.object(g, 'api', return_value=existing), patch.object(g, 'command') as cmd:
                with self.assertRaisesRegex(ValueError, 'never clobber'):
                    g.upload_draft(SimpleNamespace(tag=TAG, source_commit=COMMIT, output=root), root, {})
                cmd.assert_not_called()

    def test_conflicting_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'a').mkdir(); (root / 'b').mkdir()
            (root / 'a/evidence.json').write_text('one'); (root / 'b/evidence.json').write_text('two')
            with self.assertRaisesRegex(ValueError, 'conflicting'):
                g.one_file(root, 'evidence.json')

    def test_non_png_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'fixture.png').write_bytes(b'x' * 2048)
            with self.assertRaisesRegex(ValueError, 'genuine PNG'):
                g.png(root, 'fixture.png')


    def preflight_fixture(self, root, case):
        b, r = jobs_fixture()
        for j in b: j.update(run_id=123, head_sha=COMMIT, id=1, run_attempt=1)
        for i, j in enumerate(r): j.update(run_id=456, head_sha=COMMIT, id=i+2, run_attempt=2)
        if case == 'wrong_job_head': r[0]['head_sha'] = 'b' * 40
        build = {**run_fixture(), 'id': 123, 'run_attempt': 1, 'html_url': 'https://example.invalid/build'}
        runtime = {**run_fixture(), 'id': 456, 'workflow_id': 43, 'path': '.github/workflows/android-runtime.yml', 'run_attempt': 2, 'html_url': 'https://example.invalid/runtime'}
        previous = {**runtime, 'run_attempt': 1, 'conclusion': 'failure'}
        if case == 'wrong_prior_head': previous['head_sha'] = 'b' * 40
        sync = {'source_repository': 'https://github.com/' + g.WEB_REPO, 'source_commit': COMMIT, 'applicationVersion': g.VERSION,
                'androidVersionCode': g.VERSION_CODE, 'packageName': g.PACKAGE, 'assetCount': 157, 'publishedPhotos': 117,
                'assets': [{'path': f'controlled-fixture/{i}.bin', 'bytes': 1, 'sha256': 'a' * 64} for i in range(157)]}
        def api(endpoint):
            if endpoint.endswith('/runs/123'): return build
            if endpoint.endswith('/runs/456'): return runtime
            if endpoint.endswith('/workflows/android.yml'): return {'id': 42}
            if endpoint.endswith('/workflows/android-runtime.yml'): return {'id': 43}
            if endpoint.endswith('/runs/456/attempts/1'): return previous
            if '/commits/' in endpoint: return {'sha': COMMIT}
            raise AssertionError('Unexpected API call: ' + endpoint)
        args = SimpleNamespace(repo=g.REPO, build_run='123', runtime_run='456', source_commit=COMMIT, tag=TAG, output=root)
        with patch.object(g, 'api', side_effect=api), patch.object(g, 'api_pages', side_effect=lambda endpoint, key: b if '/runs/123/' in endpoint else r), patch.object(g, 'artifact_rows', return_value=[]), patch.object(g, 'release_state', return_value=None), patch.object(g, 'command'), patch.object(g, 'source_json', return_value=sync), patch.object(g, 'source_bytes', return_value=b'controlled-fixture-source'):
            return g.preflight(args)

    def test_same_head_retry_preserves_failed_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, _, _ = self.preflight_fixture(Path(tmp), 'valid')
        self.assertEqual(report['prior_runtime_attempts'][0]['conclusion'], 'failure')
        self.assertEqual(len(report['runtime_jobs']), 4)
        self.assertTrue(all(job['head_sha'] == COMMIT for job in report['runtime_jobs']))

    def test_retry_different_job_source_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'different source'):
                self.preflight_fixture(Path(tmp), 'wrong_job_head')

    def test_retry_different_prior_source_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'Prior runtime attempt'):
                self.preflight_fixture(Path(tmp), 'wrong_prior_head')


def add_case(name, fn):
    setattr(DraftGateTests, 'test_' + name, fn)


for index, value in [(0, 'attacker/fork'), (1, '-3'), (1, '1;echo hacked'), (1, '0'), (2, '123'),
                     (3, 'main'), (3, 'A' * 40), (3, 'a' * 39), (4, 'v2.5.0'), (4, 'v2.5.0-preview.1;echo hacked')]:
    def check(self, index=index, value=value):
        args = [g.REPO, '123', '456', COMMIT, TAG]; args[index] = value
        with self.assertRaises(ValueError): g.identity(*args)
    add_case(f'identity_reject_{index}_{len(DraftGateTests.__dict__)}', check)

for field, value in [('status', 'in_progress'), ('conclusion', 'failure'), ('conclusion', 'cancelled'), ('head_sha', 'b' * 40),
                     ('workflow_id', 43), ('path', '.github/workflows/unrelated.yml'), ('event', 'pull_request'), ('head_repository', {'full_name': 'attacker/fork'})]:
    def check(self, field=field, value=value):
        data = run_fixture(); data[field] = value
        with self.assertRaises(ValueError): g.validate_run(data, {'id': 42}, '.github/workflows/android.yml', COMMIT, True)
    add_case('run_reject_' + field + '_' + str(len(DraftGateTests.__dict__)), check)

for case in ['missing_matrix', 'failed_matrix', 'skipped_native', 'probe', 'missing_signer', 'extra_job']:
    def check(self, case=case):
        b, r = jobs_fixture()
        if case == 'missing_matrix': r.pop()
        if case == 'failed_matrix': r[-1]['conclusion'] = 'failure'
        if case == 'skipped_native': r[0]['steps'][1]['conclusion'] = 'skipped'
        if case == 'probe': r[2]['steps'][-1]['conclusion'] = 'success'
        if case == 'missing_signer': b[0]['steps'].pop(0)
        if case == 'extra_job': r.append(copy.deepcopy(r[0]))
        with self.assertRaises(ValueError): g.validate_jobs(b, r)
    add_case('jobs_reject_' + case, check)

for case in ['public', 'not_prerelease', 'wrong_head']:
    def check(self, case=case):
        row = {'tag_name': TAG, 'draft': True, 'prerelease': True, 'target_commitish': COMMIT}
        row[{'public': 'draft', 'not_prerelease': 'prerelease', 'wrong_head': 'target_commitish'}[case]] = 'b' * 40 if case == 'wrong_head' else False
        with patch.object(g, 'api_pages', return_value=[row]):
            with self.assertRaises(ValueError): g.release_state(TAG, COMMIT)
    add_case('release_reject_' + case, check)

for case in ['expired', 'empty', 'wrong_head', 'wrong_run', 'no_digest', 'ambiguous']:
    def check(self, case=case):
        row = artifact_fixture()
        if case == 'expired': row['expired'] = True
        if case == 'empty': row['size_in_bytes'] = 0
        if case == 'wrong_head': row['workflow_run']['head_sha'] = 'b' * 40
        if case == 'wrong_run': row['workflow_run']['id'] = 124
        if case == 'no_digest': row.pop('digest')
        with patch.object(g, 'api_pages', return_value=[row, row] if case == 'ambiguous' else [row]):
            with self.assertRaises(ValueError): g.artifact_rows({'id': 123, 'head_sha': COMMIT}, {'apk': artifact_job_fixture()})
    add_case('artifact_reject_' + case, check)

for case in ['same_window_ambiguous', 'missing_job_time', 'missing_upload_time', 'duplicate_upload_step', 'upload_failed',
             'upload_outside_job', 'reversed_upload_window', 'missing_artifact_time', 'artifact_outside_step', 'bad_utc_time']:
    def check(self, case=case):
        job, row = artifact_job_fixture(), artifact_fixture()
        rows = [row]
        if case == 'same_window_ambiguous': rows.append({**row, 'id': 8})
        if case == 'missing_job_time': job.pop('started_at')
        if case == 'missing_upload_time': job['steps'][0].pop('completed_at')
        if case == 'duplicate_upload_step': job['steps'].append(copy.deepcopy(job['steps'][0]))
        if case == 'upload_failed': job['steps'][0]['conclusion'] = 'failure'
        if case == 'upload_outside_job': job['completed_at'] = '2026-10-10T00:05:15Z'
        if case == 'reversed_upload_window': job['steps'][0]['completed_at'] = '2026-10-10T00:04:59Z'
        if case == 'missing_artifact_time': row.pop('created_at')
        if case == 'artifact_outside_step': row['created_at'] = '2026-10-10T00:09:00Z'
        if case == 'bad_utc_time': job['started_at'] = '2026-10-10T00:00:00'
        with patch.object(g, 'api_pages', return_value=rows):
            with self.assertRaises(ValueError): g.artifact_rows({'id': 123, 'head_sha': COMMIT}, {'apk': job})
    add_case('artifact_window_reject_' + case, check)

for created in ['2026-10-10T00:05:00Z', '2026-10-10T00:06:00Z']:
    def check(self, created=created):
        row = artifact_fixture(); row['created_at'] = created
        with patch.object(g, 'api_pages', return_value=[row]):
            selected = g.artifact_rows({'id': 123, 'head_sha': COMMIT}, {'apk': artifact_job_fixture()})
        self.assertEqual(selected[0]['id'], 7)
    add_case('artifact_closed_window_' + created[11:19].replace(':', '_'), check)


def check_retained_previous_failure(self):
    current = artifact_fixture()
    old = {**current, 'id': 6, 'created_at': '2026-10-09T23:00:00Z', 'digest': 'sha256:' + 'f' * 64}
    with patch.object(g, 'api_pages', return_value=[old, current]):
        selected = g.artifact_rows({'id': 123, 'head_sha': COMMIT}, {'apk': artifact_job_fixture()})
    self.assertEqual(selected[0]['id'], current['id'])
    previous = selected[0]['selection_evidence']['excluded_same_name_artifacts'][0]
    for field in ['id', 'digest', 'created_at']:
        self.assertEqual(previous[field], old[field])
    self.assertIn('outside-successful-upload-window', previous['exclusion_reasons'])
add_case('retained_previous_failure_artifact', check_retained_previous_failure)

for key in g.MATRICES:
    def check(self, key=key):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); contract, _ = runtime_fixture(root, key)
            with patch.object(g, 'png', side_effect=lambda _root, name: {'file': name, 'controlledFixture': True}):
                report = g.validate_runtime(root, key, *contract)
            self.assertEqual(report['photosDecoded'], 117)
            self.assertEqual(len(report['nativeGraphs']), 4)
            if key == '24': self.assertIn('photo UI recognition is not claimed', report['limitation'])
    add_case('controlled_schema_' + key.replace('-', '_'), check)

for case in ['native_failure', 'graph_hash', 'native_nonfinite', 'photo_hash', 'photo_count', 'wrong_pagesize', 'online',
             'wrong_package', 'failed_main', 'visible_old', 'visible_missing', 'cancel_not_native', 'bad_dog', 'bad_gallery', 'history_lost']:
    def check(self, case=case):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); contract, docs = runtime_fixture(root, '30')
            native, decoded, runtime, migration = [docs[n] for n in ['native-contract-runtime.json', 'reviewed-photo-runtime.json', 'runtime-report.json', 'asset-migration-report.json']]
            if case == 'native_failure': native['phase'] = 'failed'
            if case == 'graph_hash': native['graphs'][0]['sha256'] = 'f' * 64
            if case == 'native_nonfinite': native['graphs'][0]['finiteOutput'] = False
            if case == 'photo_hash': decoded['photos'][0]['sha256'] = 'f' * 64
            if case == 'photo_count': decoded['photosDecoded'] = 116
            if case == 'wrong_pagesize': decoded['pageSize'] = 16384
            if case == 'online': runtime['network']['native']['connected'] = True
            if case == 'wrong_package': runtime['network']['native']['packageName'] = 'wrong.app'
            if case == 'failed_main': runtime['phase'] = 'quartz-saved'
            if case == 'visible_old': runtime['visibleVersion'] = '2.0'
            if case == 'visible_missing': runtime.pop('visibleVersion')
            if case == 'cancel_not_native': runtime['cancelTrigger'] = 'timer'
            if case == 'bad_dog': runtime['lastError']['message'] = 'unsupported'
            if case == 'bad_gallery': runtime['galleryPhotos'][0]['sha256'] = 'f' * 64
            if case == 'history_lost': migration['historyPreserved'] = False
            for name, data in docs.items(): (root / name).write_text(json.dumps(data))
            with patch.object(g, 'png', side_effect=lambda _root, name: {'file': name, 'controlledFixture': True}):
                with self.assertRaises(ValueError): g.validate_runtime(root, '30', *contract)
    add_case('runtime_reject_' + case, check)

for case, message in [('certificate', 'certificate pin'), ('package', 'package/version'), ('elf', 'ELF16KB'),
                      ('resource_hash', 'asset SHA'), ('resource_length', 'asset length')]:
    def check(self, case=case, message=message):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); tools = root / '35.0.0'; tools.mkdir(); release = root / 'release'; release.mkdir()
            for name in ('apksigner', 'aapt', 'zipalign'): (tools / name).write_text('controlled fixture only')
            assets = [{'path': f'controlled-fixture/{i}.bin', 'bytes': 1, 'sha256': hashlib.sha256(b'x').hexdigest()} for i in range(157)]
            sync = {'source_repository': 'https://github.com/' + g.WEB_REPO, 'source_commit': COMMIT, 'applicationVersion': g.VERSION,
                    'androidVersionCode': g.VERSION_CODE, 'packageName': g.PACKAGE, 'assetCount': 157, 'publishedPhotos': 117, 'assets': assets}
            apk = root / 'controlled-fixture.apk'
            with zipfile.ZipFile(apk, 'w') as z:
                for i, asset in enumerate(assets):
                    data = b'y' if case == 'resource_hash' and i == 0 else b'xx' if case == 'resource_length' and i == 0 else b'x'
                    z.writestr('assets/public/' + asset['path'], data)
            def command(argv, **kwargs):
                out = ''
                if str(argv[0]).endswith('apksigner'):
                    out = 'Signer #1 certificate SHA-256 digest: ' + ('0' * 64 if case == 'certificate' else g.CERT_SHA256) + '\n'
                elif str(argv[0]).endswith('aapt'):
                    package = 'wrong.app' if case == 'package' else g.PACKAGE
                    out = f"package: name='{package}' versionCode='{g.VERSION_CODE}' versionName='{g.VERSION}'\nsdkVersion:'24'\n"
                elif '--require-16k' in argv:
                    Path(argv[argv.index('--output') + 1]).write_text(json.dumps({'apkSha256': g.sha(apk), 'structuralFailures': ['bad ELF'] if case == 'elf' else []}))
                return SimpleNamespace(stdout=out, stderr='', returncode=0)
            with patch.object(g, 'command', side_effect=command):
                with self.assertRaisesRegex(ValueError, message): g.inspect_package(SimpleNamespace(build_tools=tools), apk, sync, release)
    add_case('package_reject_' + case, check)


if __name__ == '__main__':
    unittest.main()

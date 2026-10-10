#!/usr/bin/env python3
"""Fail-closed Android artifact validation and optional DRAFT-ONLY upload.

No option publishes a release. No signing key is accessed. Without --upload-draft,
the only GitHub operations are read-only API/artifact requests. source_commit is
the common Android Actions head; ANDROID_SOURCE_SYNC binds the web revision.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import zipfile

REPO = '3497907003-sketch/shikuang-android'
WEB_REPO = '3497907003-sketch/shikuang-app'
CERT_SHA256 = 'DC81C921827B7BBDAA9E0C7FD8C8492CA2239AAAB9795421698313025A6B99B6'
PACKAGE = 'com.shikuang.app.preview'
VERSION = '2.5.0-preview.1'
VERSION_CODE = 25001
MATRICES = {'24': (24, 4096, 'google_apis'), '30': (30, 4096, 'google_apis'),
            '35': (35, 4096, 'google_apis'), '35-16k': (35, 16384, 'google_apis_ps16k')}
BUILD_STEPS = ['Prepare persistent preview signing key', 'Build and lint Android preview',
               'Verify APK signature with the official Android SDK',
               'Check four ABI libraries and 16 KB ELF and ZIP compatibility']
RUNTIME_STEPS = ['Boot emulator and disconnect device networking',
                 'Run packaged WebView with actual native ONNX inference',
                 'Require screenshots and JSON from successful runtime tests']
NON_MINERAL = '这不是矿物，请您放入清晰的矿物照片。'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def command(args, **kwargs):
    # argv is structured: no shell interpolation, input IDs never become code.
    return subprocess.run(args, check=True, timeout=900, **kwargs)


def api(endpoint):
    return json.loads(command(['gh', 'api', endpoint], capture_output=True, text=True).stdout)


def api_pages(endpoint, key=None):
    pages = json.loads(command(['gh', 'api', '--paginate', '--slurp', endpoint],
                               capture_output=True, text=True).stdout)
    return [row for page in pages for row in (page[key] if key else page)]


def identity(repo, build_id, runtime_id, commit, tag):
    require(repo == REPO, 'Only the established Android repository is permitted')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', str(build_id)), 'Invalid build run ID')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', str(runtime_id)), 'Invalid runtime run ID')
    require(str(build_id) != str(runtime_id), 'Build and runtime runs must be distinct')
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'source_commit must be a full lowercase Android SHA')
    require(re.fullmatch(r'v2\.5\.0-preview\.1(?:[-.][A-Za-z0-9][A-Za-z0-9._-]{0,63})?', tag),
            'Tag must be an explicit 2.5.0-preview.1 prerelease tag')


def validate_run(run, workflow, path, commit, dispatch=False):
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Actions run did not complete successfully')
    require(run['head_sha'] == commit, 'Run source differs from the approved Android head')
    require(run['head_repository']['full_name'] == REPO, 'Fork source is not permitted')
    require(run['workflow_id'] == workflow['id'] and run['path'] == path, 'Incorrect workflow identity')
    if dispatch:
        require(run['event'] == 'workflow_dispatch', 'Distributable build must use workflow_dispatch persistent signing')
    else:
        require(run['event'] in {'workflow_dispatch', 'pull_request'}, 'Unexpected runtime event')


def successful_steps(job, names):
    require(job['status'] == 'completed' and job['conclusion'] == 'success', 'Job is not successful')
    steps = {row['name']: row['conclusion'] for row in job['steps']}
    require(all(steps.get(name) == 'success' for name in names), 'A required gate step was absent, skipped or failed')


def validate_jobs(build_jobs, runtime_jobs):
    require(len(build_jobs) == 1 and build_jobs[0]['name'] == 'build', 'Unexpected build job set')
    successful_steps(build_jobs[0], BUILD_STEPS)
    expected = {f'runtime ({api}, {key}, {tag}, {page})' for key, (api, page, tag) in MATRICES.items()}
    require(len(runtime_jobs) == 4 and {job['name'] for job in runtime_jobs} == expected,
            'All four real API24/API30/API35/API35-16k matrices are mandatory; network probe is rejected')
    for job in runtime_jobs:
        successful_steps(job, RUNTIME_STEPS)
        probe = [step for step in job['steps'] if step['name'] == 'Probe disconnected networking throughout the original build interval']
        require(len(probe) == 1 and probe[0]['conclusion'] == 'skipped', 'Probe run is not a packaged runtime acceptance')


def artifact_rows(run, required):
    rows = api_pages(f'repos/{REPO}/actions/runs/{run["id"]}/artifacts?per_page=100', 'artifacts')
    chosen = []
    for name in required:
        matches = [row for row in rows if row['name'] == name]
        require(len(matches) == 1, 'Missing or ambiguous required artifact: ' + name)
        row = matches[0]
        require(row['expired'] is False and row['size_in_bytes'] > 0, 'Expired/empty artifact')
        require(row['workflow_run']['id'] == run['id'] and row['workflow_run']['head_sha'] == run['head_sha'], 'Artifact source/run mismatch')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', row.get('digest', '')), 'Official artifact digest is required')
        chosen.append(row)
    return chosen


def release_state(tag, commit):
    rows = [row for row in api_pages(f'repos/{REPO}/releases?per_page=100') if row['tag_name'] == tag]
    require(len(rows) <= 1, 'Ambiguous release tag')
    release = rows[0] if rows else None
    if release:
        require(release['draft'] is True and release['prerelease'] is True, 'Published or non-prerelease release must never be overwritten')
        require(release['target_commitish'] == commit, 'Existing draft targets another source')
    # Inspect any existing Git tag too; an annotated tag is resolved explicitly.
    result = subprocess.run(['gh', 'api', f'repos/{REPO}/git/ref/tags/{tag}'], capture_output=True, text=True, timeout=60)
    if result.returncode:
        require('HTTP 404' in result.stderr, 'Cannot verify existing tag identity')
    else:
        obj = json.loads(result.stdout)['object']
        for _ in range(5):
            if obj['type'] == 'commit':
                break
            require(obj['type'] == 'tag', 'Unexpected Git tag object')
            obj = api(f'repos/{REPO}/git/tags/{obj["sha"]}')['object']
        require(obj['type'] == 'commit' and obj['sha'] == commit, 'Existing tag points to a different Android head')
    return release


def source_bytes(commit, path):
    return command(['git', 'show', f'{commit}:{path}'], capture_output=True).stdout


def source_json(commit, path):
    return json.loads(source_bytes(commit, path))


def validate_sync(sync):
    require(sync['source_repository'] == 'https://github.com/' + WEB_REPO and
            re.fullmatch(r'[0-9a-f]{40}', sync['source_commit']), 'Invalid source sync web identity')
    require(sync['applicationVersion'] == VERSION and sync['androidVersionCode'] == VERSION_CODE and
            sync['packageName'] == PACKAGE, 'Source sync package version mismatch')
    rows = sync['assets']
    require(sync['assetCount'] == len(rows) == 157 and sync['publishedPhotos'] == 117, 'Expected complete157 assets and117 photos')
    require(len({row['path'] for row in rows}) == 157, 'Duplicate sync asset path')
    for row in rows:
        require(safe_path(row['path']) and isinstance(row['bytes'], int) and row['bytes'] > 0 and
                re.fullmatch(r'[0-9a-f]{64}', row['sha256']), 'Invalid asset hash/size/path')
    return {row['path']: row for row in rows}


def safe_path(name):
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and '..' not in path.parts and '\\' not in name and '\x00' not in name


def preflight(args):
    identity(args.repo, args.build_run, args.runtime_run, args.source_commit, args.tag)
    build = api(f'repos/{REPO}/actions/runs/{args.build_run}')
    runtime = api(f'repos/{REPO}/actions/runs/{args.runtime_run}')
    validate_run(build, api(f'repos/{REPO}/actions/workflows/android.yml'), '.github/workflows/android.yml', args.source_commit, True)
    validate_run(runtime, api(f'repos/{REPO}/actions/workflows/android-runtime.yml'), '.github/workflows/android-runtime.yml', args.source_commit)
    build_jobs = api_pages(f'repos/{REPO}/actions/runs/{build["id"]}/attempts/{build["run_attempt"]}/jobs?per_page=100', 'jobs')
    runtime_jobs = api_pages(f'repos/{REPO}/actions/runs/{runtime["id"]}/attempts/{runtime["run_attempt"]}/jobs?per_page=100', 'jobs')
    validate_jobs(build_jobs, runtime_jobs)
    require(all(job['run_id'] == build['id'] and job['head_sha'] == args.source_commit for job in build_jobs) and
            all(job['run_id'] == runtime['id'] and job['head_sha'] == args.source_commit for job in runtime_jobs),
            'A job belongs to a different source or Actions run')
    prior_attempts = []
    for attempt in range(1, runtime['run_attempt']):
        previous = api(f'repos/{REPO}/actions/runs/{runtime["id"]}/attempts/{attempt}')
        require(previous['id'] == runtime['id'] and previous['head_sha'] == args.source_commit,
                'Prior runtime attempt source identity mismatch')
        prior_attempts.append({key: previous[key] for key in ['run_attempt', 'status', 'conclusion', 'html_url']})
    artifacts = artifact_rows(build, ['shikuang-2.5-preview-apk']) + artifact_rows(runtime,
        ['shikuang-runtime-api-' + key for key in MATRICES])
    release_state(args.tag, args.source_commit)
    command(['git', 'fetch', '--no-tags', 'origin', args.source_commit], capture_output=True)
    sync = source_json(args.source_commit, 'docs/ANDROID_SOURCE_SYNC.json')
    validate_sync(sync)
    web_commit = api(f'repos/{WEB_REPO}/commits/{sync["source_commit"]}')
    require(web_commit['sha'] == sync['source_commit'], 'Web source commit resolution differs from source sync')
    report = {'schema_version': 1, 'repository': REPO, 'android_source_commit': args.source_commit,
              'web_source_commit': sync['source_commit'], 'tag': args.tag,
              'build_run_id': build['id'], 'runtime_run_id': runtime['id'],
              'build_run_attempt': build['run_attempt'], 'runtime_run_attempt': runtime['run_attempt'],
              'build_url': build['html_url'], 'runtime_url': runtime['html_url'],
              'artifact_identity': [{key: row[key] for key in ('id', 'name', 'digest', 'size_in_bytes')} for row in artifacts],
              'build_steps_verified': BUILD_STEPS, 'runtime_steps_verified': RUNTIME_STEPS,
              'runtime_jobs': [{key: row[key] for key in ['id', 'name', 'run_attempt', 'head_sha', 'conclusion']} for row in runtime_jobs],
              'prior_runtime_attempts': prior_attempts, 'source_sync_sha256': hashlib.sha256(source_bytes(args.source_commit, 'docs/ANDROID_SOURCE_SYNC.json')).hexdigest(),
              'source_asset_count': sync['assetCount'], 'preflight_passed': True}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'preflight.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return report, artifacts, sync


def extract_artifact(row, destination):
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination.parent / (row['name'] + '.zip')
    with archive.open('wb') as output:
        command(['gh', 'api', f'repos/{REPO}/actions/artifacts/{row["id"]}/zip'], stdout=output)
    require('sha256:' + sha(archive) == row['digest'], 'Downloaded artifact digest mismatch')
    with zipfile.ZipFile(archive) as files:
        require(len(files.infolist()) < 30000 and sum(row.file_size for row in files.infolist()) < 2 * 1024**3,
                'Artifact exceeds extraction bounds')
        require(len(files.namelist()) == len(set(files.namelist())), 'Duplicate archive paths')
        for entry in files.infolist():
            require(safe_path(entry.filename), 'Unsafe archive path')
            mode = stat.S_IFMT(entry.external_attr >> 16)
            require(mode in {0, stat.S_IFREG, stat.S_IFDIR} and entry.file_size < 600 * 1024**2,
                    'Symlink/special or oversized artifact entry')
        files.extractall(destination)


def one_file(root, name):
    files = sorted(root.rglob(name))
    require(files and len({sha(file) for file in files}) == 1, 'Missing or conflicting genuine artifact evidence: ' + name)
    return files[0]


def evidence_json(root, name):
    return json.loads(one_file(root, name).read_text())


def png(root, name):
    file = one_file(root, name)
    require(file.stat().st_size > 1024 and file.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), 'Missing genuine PNG evidence')
    return {'file': name, 'sha256': sha(file), 'bytes': file.stat().st_size}


def same_package(obj):
    require(obj['packageName'] == PACKAGE and obj['versionCode'] == VERSION_CODE and obj['versionName'] == VERSION,
            'Runtime package/version mismatch')


def offline(network):
    require(network['activeNetwork'] is None and network['connected'] is False, 'Runtime networking was not disconnected')


def validate_runtime(root, key, manifest, manifest_sha, reference, photos, photo_sha):
    sdk, page, tag = MATRICES[key]
    runtime = evidence_json(root, 'runtime-report.json')
    native = evidence_json(root, 'native-contract-runtime.json')
    decoded = evidence_json(root, 'reviewed-photo-runtime.json')
    require(native['phase'] == 'passed' and native['sdk'] == sdk and native['pageSize'] == page and
            native['runtimeVersion'] == '1.24.3', 'Native graph runtime identity mismatch')
    expected_graphs = {row['id']: row['sha256'] for row in manifest['models']}
    require(len(native['graphs']) == 4 and {row['id']: row['sha256'] for row in native['graphs']} == expected_graphs
            and all(row['finiteOutput'] is True for row in native['graphs']), 'Not all four exact graphs passed real native inference')
    require(decoded['phase'] == 'passed' and decoded['sdk'] == sdk and decoded['pageSize'] == page,
            'Genuine native photo decode runtime mismatch')
    same_package(decoded)
    require(decoded['activeNetworkBefore'] is None and decoded['activeNetworkAfter'] is None,
            'Native photo decode was not offline')
    expected = {row['path']: (row['sha256'], row['bytes']) for row in photos['assets']}
    require(decoded['photoManifestSha256'] == photo_sha and decoded['photosDecoded'] == len(expected) == 117 and
            decoded['sourceRecords'] == reference['counts']['source_image_records'] == 871, 'Photo/reference manifest mismatch')
    require(len(decoded['photos']) == 117 and {row['path']: (row['sha256'], row['bytes']) for row in decoded['photos']} == expected
            and all(row['actualNativeDecode'] is True and min(row['width'], row['height']) >= 224 and
                    max(row['width'], row['height']) <= 512 for row in decoded['photos']), 'All117 exact photos must decode on genuine native runtime')
    require(int(one_file(root, 'device-page-size.txt').read_text().strip()) == page, 'Recorded actual device page size mismatch')
    require(one_file(root, 'system-image.txt').read_text().strip() == f'system-images;android-{sdk};{tag};x86_64',
            'Wrong genuine emulator system image')
    offline(runtime['network']['native'])
    require(runtime['network']['native']['sdk'] == sdk and runtime['network']['native']['pageSize'] == page,
            'Main runtime device/page identity mismatch')
    screenshots = []
    if runtime['phase'] == 'unsupported-webview-recovery-passed':
        require(sdk == 24 and runtime['photoRecognitionVerified'] is False and runtime['boot']['supported'] is False
                and runtime['boot']['missing'] and '本机标本和历史记录会保留' in runtime['recovery'], 'Invalid factory-WebView recovery gate')
        screenshots.append(png(root, 'legacy-webview-recovery.png'))
        limitation = 'API24 factory WebView recovery,actual four Java graphs and117 JPEG decodes passed; photo UI recognition is not claimed.'
    else:
        require(runtime['phase'] == 'passed' and not runtime['errors'], 'Incomplete/errored WebView runtime report')
        same_package(runtime['network']['native'])
        offline(runtime['networkAfterCatalog']['native'])
        require(runtime['quartz']['key'] == 'quartz' and runtime['quartz']['engine'] == 'onnx-native-android'
                and runtime['quartz']['modelCount'] == len(manifest['modes']['ensemble'])
                and runtime['quartz']['manifestSha256'] == manifest_sha
                and runtime['quartz']['modelVersion'] == manifest['version'], 'Packaged photo inference contract mismatch')
        require(runtime['fast']['modelCount'] == 1 and runtime['fast']['engine'] == 'onnx-native-android'
                and runtime['fast']['manifestSha256'] == manifest_sha
                and runtime['fast']['diagnostics']['residentSessionCount'] <= 2, 'Fast/cached native retry gate mismatch')
        require(runtime['cancelTrigger'] == 'native-progress' and runtime['cancelError']['name'] == 'AbortError', 'Actual native cancellation not verified')
        require(runtime['lastError']['message'] == NON_MINERAL and len(runtime['recordsAfterRejection']) == len(runtime['savedRecords']) == 1
                and runtime['savedRecords'][0]['id'] == runtime['recordsAfterRejection'][0]['id'], 'Dog rejection/history preservation gate mismatch')
        require(runtime.get('visibleVersion') == '2.5' and runtime['initialReferenceRequests'] == [], 'Visible version or deferred resource gate mismatch')
        require(runtime['catalog']['imaSpecies'] == 6239 and runtime['catalog']['imageReferences'] == 871 and
                runtime['catalog']['crystalSpecies'] == reference['counts']['species_with_records'] and
                runtime['catalog']['online'] is False and runtime['catalog']['localFetches'] == 1 + len(reference['files']),
                'Offline catalog coverage mismatch')
        require(runtime['photoGeometry']['exifOrientation'] == 6 and len(runtime['photoGeometry']['crops']) == 3,
                'Preprocessing geometry gate missing')
        require(len(runtime['screenshots']) == 6 and all(row['visualStateSynchronized'] for row in runtime['screenshots']),
                'Genuine stable screenshots missing')
        migration = evidence_json(root, 'asset-migration-report.json')
        require(migration['phase'] == 'migration-passed' and migration['historyPreserved'] is True
                and migration['controller'] is False and migration['registrationCount'] == 0
                and migration['poisonedPage'] is False and migration['cacheSeeded'] is True, 'History/cache migration gate failed')
        if migration['registration_supported']:
            require(migration['controllerSeeded'] is True, 'Controlled-page migration was not actually tested')
        else:
            require(migration['controllerSeeded'] is False and migration['registration_error'], 'SW-unavailable limitation not preserved')
        for name in ['quartz-result.png', 'dog-rejection.png', 'library-offline-overview.png',
                     'quartz-reference-details.png', 'quartz-image-references.png', 'abellaite-reference-details.png']:
            screenshots.append(png(root, name))
        gallery, reopened = runtime['galleryPhotos'], runtime['galleryReopened']
        require(len(gallery) == len(reopened) == runtime['galleryRevokedCount'] == 3, 'Photo dialog lifecycle mismatch')
        for current, repeat in zip(gallery, reopened):
            require(current['decoded'] is True and current['complete'] is True and repeat['decoded'] is True and
                    (current['sha256'], current['bytes']) == expected[current['path']] and
                    (repeat['sha256'], repeat['bytes']) == expected[repeat['path']] and
                    current['blobUrl'] != repeat['blobUrl'], 'Decoded photo lifecycle/hash mismatch')
        limitation = 'Regression fixtures and runtime compatibility only; real-scene accuracy/Kappa not established.'
    return {'matrix': key, 'sdk': sdk, 'pageSize': page, 'phase': runtime['phase'],
            'nativeGraphs': native['graphs'], 'photosDecoded': decoded['photosDecoded'],
            'evidence_sha256': {name: sha(one_file(root, name)) for name in
                ['runtime-report.json', 'native-contract-runtime.json', 'reviewed-photo-runtime.json']},
            'screenshots': screenshots, 'limitation': limitation}


def inspect_package(args, apk, sync, release):
    tools = args.build_tools
    require(tools and tools.name == '35.0.0' and all((tools / tool).is_file() for tool in ['apksigner', 'aapt', 'zipalign']),
            'Official SDK35 build-tools binaries are required')
    signer = command([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], capture_output=True, text=True)
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9A-Fa-f:]+)$', signer.stdout, re.M)
    require([value.replace(':', '').upper() for value in certs] == [CERT_SHA256], 'APK persistent preview certificate pin mismatch')
    (release / 'apk-signature-verification.txt').write_text(signer.stdout + signer.stderr)
    badging = command([str(tools / 'aapt'), 'dump', 'badging', str(apk)], capture_output=True, text=True).stdout
    match = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    require(match and match.groups() == (PACKAGE, str(VERSION_CODE), VERSION), 'Official aapt package/version mismatch')
    require("sdkVersion:'24'" in badging, 'Expected Android API24 minimum')
    (release / 'apk-package-verification.txt').write_text(badging)
    aligned = command([str(tools / 'zipalign'), '-v', '-c', '-P', '16', '4', str(apk)], capture_output=True, text=True)
    (release / 'apk-zipalign-16k.txt').write_text(aligned.stdout + aligned.stderr)
    command([sys.executable, str(Path(__file__).with_name('inspect_apk.py')), str(apk), '--require-16k',
             '--output', str(release / 'apk-native-compatibility.json')], capture_output=True)
    structural = json.loads((release / 'apk-native-compatibility.json').read_text())
    require(not structural['structuralFailures'] and structural['apkSha256'] == sha(apk), 'Four ABI / ELF16KB check failed')
    structural['apk'] = apk.name
    (release / 'apk-native-compatibility.json').write_text(json.dumps(structural, indent=2) + '\n')
    expected = validate_sync(sync)
    checked = []
    with zipfile.ZipFile(apk) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), 'APK has duplicate ZIP entries')
        prefix = 'assets/public/'
        public = {name[len(prefix):] for name in archive.namelist() if name.startswith(prefix) and not name.endswith('/')}
        require(public >= set(expected) and public - set(expected) <= {'cordova.js', 'cordova_plugins.js'},
                'Packaged source has missing or unexpected public assets')
        for path, row in expected.items():
            require(archive.getinfo(prefix + path).file_size == row['bytes'], 'Packaged asset length mismatch: ' + path)
            data = archive.read(prefix + path)
            require(hashlib.sha256(data).hexdigest() == row['sha256'], 'Packaged asset SHA mismatch: ' + path)
            checked.append(row)
        read = lambda name: json.loads(archive.read(prefix + name))
        manifest, photos, reference = read('model-manifest.json'), read('data/reviewed-photo-assets.json'), read('data/reference-manifest.json')
        require(len(manifest['models']) == 4 and len(manifest['labels']) == len(set(manifest['labels'])) == 98 and
                manifest['version'] == sync['activeModelVersion'] == 'inherited-2.0-audited', 'Released model manifest mismatch')
        require(len(photos['assets']) == 117 and reference['counts']['local_reviewed_photos'] == 117 and
                len(read('data/image-sources.json')['records']) == reference['counts']['source_image_records'] == 871,
                'Photo/reference counts mismatch')
        for row in manifest['models'] + photos['assets'] + reference['files']:
            require(row['path'] in expected and row['sha256'] == expected[row['path']]['sha256'] and
                    row['bytes'] == expected[row['path']]['bytes'], 'Model/photo/reference manifest differs from source sync')
        require({path for path in public if path.startswith('models/')} == {row['path'] for row in manifest['models']} and
                {path for path in public if path.startswith('images/')} == {row['path'] for row in photos['assets']},
                'APK contains stale model/photo assets')
        manifest_sha = hashlib.sha256(archive.read(prefix + 'model-manifest.json')).hexdigest()
        photo_sha = hashlib.sha256(archive.read(prefix + 'data/reviewed-photo-assets.json')).hexdigest()
    return {'packageName': PACKAGE, 'versionCode': VERSION_CODE, 'versionName': VERSION,
            'certificateSha256': CERT_SHA256, 'apkSha256': sha(apk), 'apkBytes': apk.stat().st_size,
            'sourceAssetsVerified': len(checked), 'sourceAssetManifest': checked,
            'modelManifestSha256': manifest_sha, 'reviewedPhotoManifestSha256': photo_sha,
            'officialSdkBuildTools': '35.0.0', 'elf16kVerified': True, 'zip16kVerified': True}, (manifest, manifest_sha, reference, photos, photo_sha)


def upload_draft(args, release, gate):
    existing = release_state(args.tag, args.source_commit)
    files = sorted(file for file in release.iterdir() if file.is_file())
    if existing is None:
        notes = args.output / 'draft-notes.md'
        notes.write_text(f'Android {VERSION}, {PACKAGE}, versionCode {VERSION_CODE}.\n\n'
                         f'Android source `{args.source_commit}`; web source `{gate["web_source_commit"]}`.\n'
                         f'Validated build: {gate["build_url"]}\nValidated runtime: {gate["runtime_url"]}\n\n'
                         'Draft only: release publication requires a separate human action. Four ABI/ELF+ZIP16KB checks, '
                         '157 source assets, four native graphs and117 licensed reference photo decodes verified. '
                         'API24 factory WebView may only pass the supported recovery screen; see runtime gate limitations. '
                         'Regression checks do not establish mineral accuracy or Kappa0.95.\n')
        command(['gh', 'release', 'create', args.tag, '--repo', REPO, '--target', args.source_commit,
                 '--draft', '--prerelease', '--title', f'识矿 {VERSION} Android preview', '--notes-file', str(notes)],
                capture_output=True, text=True)
        existing = release_state(args.tag, args.source_commit)
    require(existing is not None, 'Cannot identify created draft')
    for file in files:
        current = api(f'repos/{REPO}/releases/{existing["id"]}')
        require(current['draft'] is True and current['prerelease'] is True and current['target_commitish'] == args.source_commit,
                'Release was published or changed during upload; stopping')
        matches = [asset for asset in current['assets'] if asset['name'] == file.name]
        require(len(matches) <= 1, 'Ambiguous existing draft asset')
        if matches:
            require(matches[0].get('digest') == 'sha256:' + sha(file), 'Existing asset differs; never clobber published/draft bytes automatically')
            continue
        # No --clobber, no release edit, no delete and no publishing endpoint.
        command(['gh', 'release', 'upload', args.tag, str(file), '--repo', REPO], capture_output=True, text=True)
    final = release_state(args.tag, args.source_commit)
    require(final and final['draft'] is True and final['prerelease'] is True, 'Release must remain a draft prerelease')
    for file in files:
        matches = [row for row in final['assets'] if row['name'] == file.name]
        require(len(matches) == 1 and matches[0].get('digest') == 'sha256:' + sha(file), 'Uploaded draft asset digest mismatch')
    print('Verified draft only: ' + final['html_url'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--build-run', required=True)
    parser.add_argument('--runtime-run', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build-tools', type=Path)
    parser.add_argument('--preflight-only', action='store_true')
    parser.add_argument('--upload-draft', action='store_true')
    args = parser.parse_args()
    require(not (args.preflight_only and args.upload_draft), 'Preflight cannot upload')
    pre, artifacts, sync = preflight(args)
    if args.preflight_only:
        print('All run/source/draft preflight gates passed; no upload performed.')
        return
    downloads = args.output / 'downloads'
    for artifact in artifacts:
        extract_artifact(artifact, downloads / artifact['name'])
    apk = one_file(downloads / 'shikuang-2.5-preview-apk', 'app-debug.apk')
    release = args.output / 'release'
    release.mkdir(parents=True, exist_ok=True)
    published_apk = release / f'shikuang-{VERSION}-android.apk'
    shutil.copyfile(apk, published_apk)
    package, runtime_contract = inspect_package(args, published_apk, sync, release)
    runtime = [validate_runtime(downloads / ('shikuang-runtime-api-' + key), key, *runtime_contract) for key in MATRICES]
    gate = {**pre, 'package': package, 'runtimeMatrices': runtime, 'gatePassed': True,
            'releaseMode': 'draft-prerelease-only', 'productionAccuracyClaim': False,
            'limitations': 'Native/fixture/offline regression only; source-photo pilot Kappa remains0.6564 and was not deployed. API24 factory WebView recovery is explicitly distinguished from photo UI inference.'}
    (release / 'ANDROID_SOURCE_SYNC.json').write_bytes(source_bytes(args.source_commit, 'docs/ANDROID_SOURCE_SYNC.json'))
    (release / 'android-preview-gate.json').write_text(json.dumps(gate, ensure_ascii=False, indent=2) + '\n')
    sums = ''.join(f'{sha(file)}  {file.name}\n' for file in sorted(release.iterdir()) if file.is_file() and file.name != 'SHA256SUMS')
    (release / 'SHA256SUMS').write_text(sums)
    if args.upload_draft:
        upload_draft(args, release, gate)
    else:
        print('Complete APK and genuine runtime gates passed; no upload performed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.SubprocessError, OSError, zipfile.BadZipFile) as error:
        print('Draft gate rejected: ' + str(error), file=sys.stderr)
        raise SystemExit(1)

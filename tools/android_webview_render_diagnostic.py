"""Debug drawing evidence from bounded, write-once log snapshots, never App repair."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

CASES = {'accelerated': ('false', True), 'software': ('true', False)}
MAX_LOG_BYTES = 32 * 1024 * 1024
MAX_OBSERVATIONS = 256


def need(condition, message):
    if not condition:
        raise ValueError(message)


def profile_from_environment(env, actual_head):
    case = env.get('SHIKUANG_RENDER_CASE', '')
    need(env.get('SHIKUANG_RENDER_DIAGNOSTIC') == 'true' and case in CASES,
         'explicit drawing diagnostic and exact case required')
    prop, expected = CASES[case]
    need(env.get('ORG_GRADLE_PROJECT_shikuangSoftwareDrawProbe') == prop,
         'drawing case and actual Gradle property differ')
    source = env.get('SHIKUANG_RENDER_EXPECTED_SOURCE', '')
    nonce = env.get('SHIKUANG_RENDER_UNIT_NONCE', '')
    need(re.fullmatch('[a-f0-9]{40}', source) and source == actual_head == env.get('GITHUB_SHA'),
         'exact reviewed checkout/source required')
    need(re.fullmatch('[a-f0-9]{32}', nonce) and env.get('GITHUB_RUN_ATTEMPT') == '1'
         and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'one explicit fresh dispatch required')
    return {'schema': 'android-debug-drawing-profile-v1', 'source_commit': source,
            'unit_nonce': nonce, 'case': case, 'software_draw_Gradle_property': prop,
            'desired_activity_hardware_acceleration': expected,
            'requested_sdk': 35, 'requested_page_size': 16384,
            'requested_configured_memory_MiB': 4096,
            'product_acceptance': False, 'GPU_thread_absence_claim': False,
            'requested_configuration_is_not_actual_draw_observation': True}


def validate_profile(profile):
    case = profile.get('case')
    need(profile.get('schema') == 'android-debug-drawing-profile-v1' and case in CASES,
         'fixed drawing diagnostic profile')
    prop, expected = CASES[case]
    need(profile.get('software_draw_Gradle_property') == prop
         and profile.get('desired_activity_hardware_acceleration') is expected
         and profile.get('product_acceptance') is False, 'profile does not select exact diagnostic case')
    need(re.fullmatch('[a-f0-9]{40}', profile.get('source_commit', ''))
         and re.fullmatch('[a-f0-9]{32}', profile.get('unit_nonce', '')),
         'profile source/nonce missing')


def parse_observations(paths):
    """Only the exact debug tag/schema becomes structured drawing observations."""
    rows, inputs, errors = {}, [], []
    for path in paths:
        if not path.exists():
            inputs.append({'path': str(path), 'present': False})
            continue
        need(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_LOG_BYTES,
             'bounded regular original log required')
        digest = hashlib.sha256(); byte_count = 0
        with path.open('rb') as stream:
            for number, raw in enumerate(stream, 1):
                byte_count += len(raw)
                need(byte_count <= MAX_LOG_BYTES, 'bounded log parsing required')
                digest.update(raw)
                if b'ShikuangRendering' not in raw:
                    continue
                match = re.search(r'\bShikuangRendering\s*:\s*(\{.*\})\s*$', raw.decode('utf-8', 'replace'))
                try:
                    need(match is not None, 'malformed tagged drawing JSON')
                    event = json.loads(match.group(1))
                    need(event.get('schema') == 'debug-first-draw-v1', 'unexpected drawing schema')
                    need(event.get('phase') in ('enter', 'exit'), 'drawing phase')
                    keys = {'schema', 'phase', 'pid', 'elapsedRealtimeNanos', 'viewIdentity'}
                    if event['phase'] == 'enter':
                        keys |= {'viewHardwareAccelerated', 'canvasHardwareAccelerated', 'layerType'}
                        need(type(event.get('viewHardwareAccelerated')) is bool
                             and type(event.get('canvasHardwareAccelerated')) is bool
                             and type(event.get('layerType')) is int and event['layerType'] in (0, 1, 2),
                             'actual drawing booleans/layer type required')
                    need(set(event) == keys and all(type(event.get(k)) is int and event[k] > 0
                         for k in ('pid', 'elapsedRealtimeNanos', 'viewIdentity')), 'drawing identity fields')
                    key = (event['pid'], event['viewIdentity'], event['phase'], event['elapsedRealtimeNanos'])
                    origin = {'log': str(path), 'line_1based': number,
                              'raw_line_sha256': hashlib.sha256(raw).hexdigest()}
                    if key in rows:
                        need(rows[key]['facts'] == event, 'conflicting duplicate drawing facts')
                        rows[key]['origins'].append(origin)
                    else:
                        need(len(rows) < MAX_OBSERVATIONS, 'bounded drawing observations')
                        rows[key] = {'facts': event, 'origins': [origin]}
                except (ValueError, TypeError, KeyError) as error:
                    errors.append({'log': str(path), 'line_1based': number,
                                   'raw_line_sha256': hashlib.sha256(raw).hexdigest(), 'reason': str(error)})
        inputs.append({'path': str(path), 'present': True, 'bytes': byte_count,
                       'sha256': digest.hexdigest()})
    return sorted(rows.values(), key=lambda r: (r['facts']['pid'], r['facts']['elapsedRealtimeNanos'])), inputs, errors


def snapshot_logs(paths, folder):
    """Copy only opened-file size bytes; never stop, truncate, or modify live logs.

    A streaming log can append immediately after this copy.  Its path therefore
    has no whole-live-file hash claim.  Parsing and hashes refer to fresh,
    exclusive snapshot files sealed read-only after writing, not the live file.
    """
    folder.mkdir(parents=True, exist_ok=False)
    records, snapshots = [], []
    for number, source in enumerate(paths):
        record = {'path': str(source), 'present': source.exists(),
                  'live_file_may_append': True, 'whole_live_file_hashed': False}
        if not record['present']:
            records.append(record)
            continue
        need(source.is_file() and not source.is_symlink(), 'regular live log required')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(source, flags), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            need(stat.S_ISREG(opened.st_mode) and opened.st_size <= MAX_LOG_BYTES,
                 'bounded regular live log required')
            limit = opened.st_size
            target = folder / ('%02d-' % number + source.name)
            # Capture exactly the initial opened-file boundary.  Additional
            # bytes belong to the still-live source and remain there untouched.
            remaining, count, digest = limit, 0, hashlib.sha256()
            with target.open('xb') as output:
                try:
                    while remaining:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        need(bool(chunk), 'live log truncated during snapshot')
                        output.write(chunk); digest.update(chunk)
                        count += len(chunk); remaining -= len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                finally:
                    os.fchmod(output.fileno(), 0o444)
            record['capture_limit_from_open_file_size'] = limit
            record['snapshot'] = {'path': str(target), 'bytes': count,
                                  'sha256': digest.hexdigest(), 'read_only': True,
                                  'created_exclusively': True}
            snapshots.append(target)
        records.append(record)
    return snapshots, records


def collect(profile, root, native_outcome, cold_outcome, *, snapshot_folder=None):
    validate_profile(profile)
    if snapshot_folder is None:
        snapshot_folder = root/'drawing-diagnostic/input-log-snapshots'
    paths, logs = snapshot_logs([root/'logcat.txt', root/'logcat-final.txt'], snapshot_folder)
    observations, parsed, errors = parse_observations(paths)
    expected = [row['snapshot'] for row in logs if row['present']]
    need([(p['path'], p['bytes'], p['sha256']) for p in parsed]
         == [(p['path'], p['bytes'], p['sha256']) for p in expected],
         'snapshot parse bytes differ from capture hashes')
    failures = ['malformed drawing observations'] if errors else []
    groups = {}
    for row in observations:
        fact = row['facts']; key = (fact['pid'], fact['viewIdentity'])
        groups.setdefault(key, {'enter': [], 'exit': []})[fact['phase']].append(fact)
    expected = profile['desired_activity_hardware_acceleration']
    for key, phases in groups.items():
        if len(phases['enter']) != 1 or len(phases['exit']) != 1:
            failures.append('incomplete or repeated first draw: ' + str(key))
            continue
        enter, leave = phases['enter'][0], phases['exit'][0]
        if enter['elapsedRealtimeNanos'] >= leave['elapsedRealtimeNanos']:
            failures.append('first draw did not exit after entry: ' + str(key))
        if enter['viewHardwareAccelerated'] is not expected:
            failures.append('actual attached-window acceleration disagrees with case: ' + str(key))
        # A hardware window can legitimately draw into a software bitmap Canvas.
        # Record that actual value; do not pretend every control Canvas is GPU-backed.
        if expected is False and enter['canvasHardwareAccelerated'] is not False:
            failures.append('software-Activity case observed a hardware Canvas: ' + str(key))
    actual = {}
    for filename, key in [('device-page-size.txt', 'page_size'),
                          ('emulator-configured-memory-mib.txt', 'configured_memory_MiB')]:
        path = root/filename
        if path.is_file() and path.stat().st_size <= 64:
            try:
                actual[key] = int(path.read_text().strip())
            except ValueError:
                failures.append('invalid actual platform record: ' + filename)
    mem = root/'guest-meminfo-before-install.txt'
    if mem.is_file() and mem.stat().st_size <= 65536:
        match = re.search(r'^MemTotal:\s+(\d+) kB', mem.read_text(), re.M)
        if match:
            actual['MemTotal_kB'] = int(match.group(1))
    if not (actual.get('page_size') == 16384 and actual.get('configured_memory_MiB') == 4096
            and 3900000 <= actual.get('MemTotal_kB', 0) <= 4194304):
        failures.append('actual 16K/4096MiB platform evidence missing or differs')
    report = root/'runtime-smoke/runtime-report.json'; ordinary_pid = None
    if report.is_file() and report.stat().st_size <= 2 * 1024 * 1024:
        runtime = json.loads(report.read_bytes())
        ordinary_pid = runtime.get('coldProcessBaseline', {}).get('firstPhasePid')
        if type(ordinary_pid) is not int or runtime.get('phase') != 'passed':
            ordinary_pid = None
    if native_outcome == 'success' and not any(k[0] == ordinary_pid for k in groups):
        failures.append('no actual draw pair tied to successful ordinary runtime PID')
    if not observations:
        failures.append('no actual first-draw observations retained')
    return {'schema': 'android-debug-drawing-observations-v2', 'profile': profile,
            'native_tests_outcome': native_outcome, 'cold_process_outcome': cold_outcome,
            'actual_platform': actual, 'ordinary_runtime_pid': ordinary_pid,
            'original_logs': logs, 'observations': observations, 'parse_errors': errors,
            'observation_log_paths_refer_to_fixed_snapshots': True,
            'live_log_streams_stopped_or_modified': False,
            'diagnostic_failures': failures,
            'diagnostic_status': 'observed' if not failures else 'partial_or_invalid',
            'product_acceptance': False, 'GPU_thread_absence_claim': False,
            'runtime_failure_reclassified': False}


def write_fresh(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    make = sub.add_parser('profile'); make.add_argument('--out', type=Path, required=True)
    take = sub.add_parser('collect'); take.add_argument('--profile', type=Path, required=True)
    take.add_argument('--root', type=Path, required=True); take.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'profile':
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=5).strip()
        write_fresh(args.out, profile_from_environment(os.environ, head))
    else:
        need(args.profile.stat().st_size <= 8192, 'bounded exact diagnostic profile')
        native = os.environ.get('SHIKUANG_NATIVE_OUTCOME', '')
        cold = os.environ.get('SHIKUANG_COLD_OUTCOME', '')
        result = collect(json.loads(args.profile.read_bytes()), args.root, native, cold,
                         snapshot_folder=args.out.parent/'input-log-snapshots')
        write_fresh(args.out, result)
        # Failed/skipped runtime remains a failure through its original step.
        # A green runtime cannot pass this diagnostic without genuine draw proof.
        if native == 'success':
            need(not result['diagnostic_failures'], 'successful runtime lacks valid actual drawing evidence')
    print(json.dumps({'mode': args.mode, 'product_acceptance': False}))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""One declared two-arm native-lifecycle diagnostic, never product acceptance.

Each arm starts exactly once on the same ephemeral CI emulator/boot/provider.
Failures are retained; no reboot, retry, provider replacement or package clear.
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import time
from pathlib import Path

from android_cold_restart import Host, need

PACKAGE = 'com.shikuang.app.preview'
CLASS = 'com.shikuang.app.NativeLifecycleDiagnosticInstrumentedTest'
ARMS = (('plain', 'plainWebViewSingleRecreateAndClose', 90),
        ('packaged', 'packagedMigrationSingleRecreateAndClose', 240))


def terminal(raw, stderr, code, method):
    need(code == 0 and stderr == b'', 'instrumentation_host_exit')
    need(re.findall(rb'(?m)^INSTRUMENTATION_CODE: (-?[0-9]+)\s*$', raw) == [b'-1'], 'instrumentation_terminal_code')
    need(re.findall(rb'(?m)^INSTRUMENTATION_STATUS_CODE: (-?[0-9]+)\s*$', raw) == [b'1', b'0'], 'one_test_start_and_success')
    need(len(re.findall(rb'(?m)^OK \(1 test\)\s*$', raw)) == 1, 'one_test_OK')
    need(not any(word in raw for word in (b'FAILURES!!!', b'INSTRUMENTATION_FAILED', b'Process crashed',
        b'INSTRUMENTATION_ABORTED', b'shortMsg=')), 'instrumentation_failure_retained')
    for key, expected in ((b'class', CLASS.encode()), (b'test', method.encode())):
        rows = re.findall(rb'(?m)^INSTRUMENTATION_STATUS: ' + key + rb'=(.+)\r?$', raw)
        need(rows and all(row.rstrip(b'\r') == expected for row in rows), 'exact_selected_' + key.decode())


def command(serial, arm, method, nonce):
    need(serial == 'emulator-5554' and (arm, method) in [(a, m) for a, m, _ in ARMS], 'fixed_diagnostic_selection')
    need(re.fullmatch(r'[a-f0-9]{32}', nonce) is not None, 'fresh_nonce_format')
    return ['adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
        '-e', 'useTestStorageService', 'true', '-e', 'nativeLifecycleDiagnostic', 'true',
        '-e', 'diagnosticArm', arm, '-e', 'diagnosticNonce', nonce,
        '-e', 'class', CLASS + '#' + method,
        PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner']


def environment(host, label, expected_boot=None, expected_fingerprint=None):
    devices = host.command(label + '-devices', ['devices']).splitlines()
    need(devices and devices[0] == b'List of devices attached'
         and [r.split() for r in devices[1:] if r.strip()] == [[b'emulator-5554', b'device']], 'one_exact_device')
    qemu = host.command(label + '-qemu', ['shell', 'getprop', 'ro.kernel.qemu']).strip()
    need(qemu == b'1', 'official_emulator_only')
    need(host.command(label + '-sdk', ['shell', 'getprop', 'ro.build.version.sdk']).strip() == b'35', 'actual_SDK35')
    need(host.command(label + '-abi', ['shell', 'getprop', 'ro.product.cpu.abi']).strip() == b'x86_64', 'actual_x86_64')
    need(host.command(label + '-page', ['shell', 'getconf', 'PAGE_SIZE']).strip() == b'16384', 'actual_16K_pages')
    need(host.command(label + '-root', ['shell', 'id', '-u']).strip() == b'0', 'root_required_for_offline_fixture')
    fingerprint = host.command(label + '-image-fingerprint', ['shell', 'getprop', 'ro.build.fingerprint']).strip()
    need(0 < len(fingerprint) <= 1024, 'actual_image_fingerprint_missing')
    need(expected_fingerprint is None or fingerprint == expected_fingerprint, 'same_image_fingerprint_required')
    need(host.command(label + '-avd', ['emu', 'avd', 'name']).splitlines() == [b'shikuang-api35-16k', b'OK'], 'exact_workflow_AVD')
    boot = host.command(label + '-boot', ['shell', 'cat', '/proc/sys/kernel/random/boot_id']).strip()
    need(re.fullmatch(rb'[a-f0-9-]{36}', boot) is not None and (expected_boot is None or boot == expected_boot), 'same_boot_required')
    provider = host.command(label + '-provider', ['shell', 'dumpsys', 'webviewupdate'])
    need(re.search(rb'Current WebView package \(name, version\):\s*\(com\.google\.android\.webview,\s*124\.0\.6367\.219\)', provider) is not None,
         'same_stock_WebView124_required')
    package = host.command(label + '-provider-package', ['shell', 'dumpsys', 'package', 'com.google.android.webview'])
    need(re.search(rb'\bversionCode=636771938\b', package) is not None, 'same_stock_provider_code')
    host.network(label + '-offline')
    return boot


def verify_report(report, arm, nonce, actual_pid):
    need(report.get('schema') == 'shikuang-native-lifecycle-diagnostic-v1' and report.get('arm') == arm,
         'correct_current_report')
    need(report.get('nonce') == nonce and report.get('completed') is True and report.get('plannedAttempts') == 1,
         'stale_failed_or_duplicate_report')
    need(report.get('fullProductAcceptance') is False and report.get('originalFailureRemainsRecorded') is True,
         'diagnostic_not_acceptance')
    env = report['environment']
    need(env == {'sdk': 35, 'pageSize': 16384, 'providerPackage': 'com.google.android.webview',
        'providerVersion': '124.0.6367.219', 'providerVersionCode': 636771938,
        'pid': actual_pid, 'activeNetwork': None}, 'actual_native_environment_or_PID_mismatch')
    start, end = report['startedElapsedRealtimeNanos'], report['endedElapsedRealtimeNanos']
    need(type(start) is int and type(end) is int and 0 < start < end, 'native_monotonic_time')
    snap = report['lifecycle']; events = snap['events']
    need(snap.get('pid') == actual_pid and snap.get('droppedEvents') == 0 and 0 < len(events) <= 256,
         'untruncated_current_process_receipts')
    last_seq, last_time = 0, start
    phases, plugin_owners, created, destroyed, detached, views = {}, set(), set(), set(), set(), set()
    activity_views = {}
    prefix = 'plain-' if arm == 'plain' else ''
    for row in events:
        seq, tick = row['sequence'], row['elapsedRealtimeNanos']
        need(type(seq) is int and seq > last_seq and type(tick) is int and last_time <= tick <= end,
             'monotonic_ordered_event_receipts')
        need(row['pid'] == actual_pid and type(row['tid']) is int and row['tid'] > 0, 'event_process_thread')
        last_seq, last_time = seq, tick
        owner, phase = row['ownerIdentity'], row['phase']
        owner_phases = phases.setdefault(owner, {})
        need(phase not in owner_phases, 'duplicate_lifecycle_phase')
        owner_phases[phase] = row
        if phase.startswith('plugin-'):
            need(arm == 'packaged' and row['ownerKind'] == 'plugin', 'plain_must_have_no_plugin')
            plugin_owners.add(owner)
        else:
            need(row['ownerKind'] == 'activity' and row['activityIdentity'] == owner, 'activity_owner_identity')
            if phase == prefix + 'create-exit':
                created.add(owner); views.add(row['webViewIdentity']); activity_views[owner] = row['webViewIdentity']
            if phase == prefix + 'destroy-exit': destroyed.add(owner)
            if phase == prefix + 'detach-exit': detached.add(owner)
    need(len(created) == len(views) == 2 and 0 not in views and created == destroyed == detached, 'two_distinct_activities_views_closed')
    for owner in created:
        rows = phases[owner]
        for stage in ('create', 'resume', 'pause', 'stop', 'destroy', 'detach'):
            enter, exit = rows.get(prefix + stage + '-enter'), rows.get(prefix + stage + '-exit')
            need(enter is not None and exit is not None and enter['sequence'] < exit['sequence'], 'lifecycle_enter_exit_' + stage)
        need(rows[prefix + 'create-exit']['sequence'] < rows[prefix + 'resume-enter']['sequence']
             < rows[prefix + 'pause-enter']['sequence'] < rows[prefix + 'stop-enter']['sequence']
             < rows[prefix + 'destroy-enter']['sequence'], 'activity_transition_order')
    if arm == 'packaged':
        need(len(plugin_owners) == 2, 'two_plugin_owners')
        for owner in plugin_owners:
            rows = phases[owner]
            required = ('plugin-destroy-enter', 'plugin-cancel-complete', 'plugin-cleanup-enter',
                        'plugin-cleanup-complete', 'plugin-shutdown-requested', 'plugin-destroy-exit')
            need(set(rows) == set(required), 'plugin_cleanup_complete')
            need(rows['plugin-cleanup-enter']['sequence'] < rows['plugin-cleanup-complete']['sequence'], 'queued_cleanup_order')
            need(all(r['activityIdentity'] in created and r['webViewIdentity'] == activity_views[r['activityIdentity']]
                     for r in rows.values()), 'plugin_known_owner_view')
    return {'actualPid': actual_pid, 'events': len(events), 'activities': 2, 'views': 2, 'fullProductAcceptance': False}


def capture(host, label):
    # Every diagnostic failure remains recorded even when later capture fails.
    problems = []
    for suffix, argv in (
        ('logcat', ['logcat', '-b', 'all', '-d', '-v', 'threadtime']),
        ('exit-info', ['shell', 'dumpsys', 'activity', 'exit-info', PACKAGE]),
        ('processes', ['shell', 'ps', '-A'])):
        try: host.command(label + '-' + suffix, argv)
        except Exception as error: problems.append(suffix + ':' + str(error))
    return problems


def reject_observed_crash(exit_info, logcat, pid):
    """Old crash records cannot be substituted for the current arm's PID."""
    for block in re.split(rb'ApplicationExitInfo #[0-9]+:', exit_info):
        if re.search(rb'\bpid=' + str(pid).encode() + rb'\b', block):
            need(re.search(rb'\breason=(4|5|6)\b', block) is None, 'current_PID_crash_or_ANR_retained')
    need(re.search(rb'Fatal signal[^\n]*\bpid\s+' + str(pid).encode() + rb'\b', logcat) is None,
         'current_PID_native_signal_retained')


def run_arm(out, arm, method, timeout, boot, fingerprint, seen_pids):
    out.mkdir(exist_ok=False)
    host = Host('emulator-5554', out)
    result = {'arm': arm, 'method': method, 'passed': False, 'attempts': 0,
              'fullProductAcceptance': False, 'originalFailureRemainsRecorded': True}
    proc = None
    try:
        environment(host, 'before', boot, fingerprint)
        result['beforeForceStopPid'] = host.pid('before-stop-pid')
        host.command('force-stop-once', ['shell', 'am', 'force-stop', PACKAGE])
        need(host.pid('after-stop-pid') is None, 'force_stop_PID_must_be_absent')
        nonce = secrets.token_hex(16); result['nonce'] = nonce
        argv = command('emulator-5554', arm, method, nonce)
        receipt = result['instrumentation'] = {'argv': argv, 'process_exited': False, 'return_code': None}
        with (out / 'instrumentation.stdout.bin').open('wb') as stdout, (out / 'instrumentation.stderr.bin').open('wb') as stderr:
            started = time.monotonic(); result['attempts'] += 1
            proc = subprocess.Popen(argv, stdout=stdout, stderr=stderr)
            receipt.update(started_monotonic_seconds=started, host_adb_pid=proc.pid)
            actual_pid = None
            while time.monotonic() - started < 20 and proc.poll() is None:
                pid = host.pid('live-pid-' + str(len(host.receipts)))
                if pid is not None: actual_pid = pid; break
                time.sleep(.1)
            need(actual_pid is not None and actual_pid not in seen_pids
                 and actual_pid != result['beforeForceStopPid'], 'new_distinct_live_PID_required')
            seen_pids.add(actual_pid); result['actualPid'] = actual_pid
            code = proc.wait(timeout=max(1, timeout - (time.monotonic() - started)))
        terminal((out / 'instrumentation.stdout.bin').read_bytes(), (out / 'instrumentation.stderr.bin').read_bytes(), code, method)
        raw = host.command('current-native-report', ['exec-out', 'content', 'read', '--uri',
            'content://androidx.test.services.storage.outputfiles/native-lifecycle-' + arm + '.json'])
        need(0 < len(raw) <= 256 * 1024, 'report_bound')
        result['verifiedNativeReport'] = verify_report(json.loads(raw), arm, nonce, actual_pid)
        (out / ('native-lifecycle-' + arm + '.json')).write_bytes(raw)
        environment(host, 'after', boot, fingerprint)
        result['passed'] = True
    except Exception as error:
        result['failure'] = type(error).__name__ + ': ' + str(error)
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.kill(); proc.wait(timeout=10)
                result['hostProcessTerminatedAfterFailure'] = True
                result['guestTerminationConfirmed'] = False
            result['instrumentation'].update(return_code=proc.returncode, process_exited=proc.poll() is not None,
                finished_monotonic_seconds=time.monotonic())
            for stream in ('stdout', 'stderr'):
                result['instrumentation'][stream + '_sha256'] = hashlib.sha256((out / ('instrumentation.' + stream + '.bin')).read_bytes()).hexdigest()
        result['captureProblems'] = capture(host, 'final')
        if result['captureProblems']: result['passed'] = False
        if result['passed']:
            try:
                reject_observed_crash((out / 'final-exit-info.stdout.bin').read_bytes(),
                    (out / 'final-logcat.stdout.bin').read_bytes(), result['actualPid'])
            except Exception as error:
                result['passed'] = False; result['failure'] = type(error).__name__ + ': ' + str(error)
        (out / 'arm-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    p = argparse.ArgumentParser(); p.add_argument('--out', type=Path, required=True)
    p.add_argument('--source-sha', required=True); p.add_argument('--unit-nonce', required=True)
    args = p.parse_args()
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_only_no_physical_device')
    need(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'reruns_are_not_authorized')
    need(re.fullmatch(r'[a-f0-9]{40}', args.source_sha) is not None, 'exact_source_SHA')
    need(subprocess.check_output(['git', 'rev-parse', 'HEAD']).strip().decode() == args.source_sha, 'checkout_SHA_mismatch')
    need(re.fullmatch(r'[a-f0-9]{32}', args.unit_nonce) is not None, 'explicit_fresh_unit_nonce')
    args.out.mkdir(parents=True, exist_ok=False)
    result = {'schema': 'shikuang-host-native-lifecycle-pair-v1', 'sourceSha': args.source_sha,
        'unitNonce': args.unit_nonce, 'passed': False, 'maximumArms': 2, 'maximumAttemptsPerArm': 1,
        'fullProductAcceptance': False, 'rootCauseConfirmed': False, 'originalFailingRun': 39246792540,
        'arms': []}
    try:
        host = Host('emulator-5554', args.out)
        boot = environment(host, 'initial'); result['bootId'] = boot.decode()
        fingerprint = (args.out / 'initial-image-fingerprint.stdout.bin').read_bytes().strip()
        result['imageFingerprint'] = fingerprint.decode('utf-8', errors='strict')
        for arm, method, timeout in ARMS:
            # A failed arm is retained. Revalidate without reconnect/repair/reboot
            # before deciding whether the other declared arm can still execute.
            environment(host, 'pre-' + arm, boot, fingerprint)
            arm_result = run_arm(args.out / arm, arm, method, timeout, boot, fingerprint,
                                 {r['actualPid'] for r in result['arms'] if 'actualPid' in r})
            result['arms'].append(arm_result)
        result['passed'] = len(result['arms']) == 2 and all(r['passed'] for r in result['arms'])
    except Exception as error:
        result['environmentFailure'] = type(error).__name__ + ': ' + str(error)
    finally:
        (args.out / 'pair-result.json').write_text(json.dumps(result, indent=2) + '\n')
    if not result['passed']: raise SystemExit(1)


if __name__ == '__main__': main()

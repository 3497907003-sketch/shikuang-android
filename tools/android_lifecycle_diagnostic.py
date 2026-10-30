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
CASE_SETS = {
    'migration-v1': {'arms': ARMS, 'delegatedMethod': 'legacyNativeAssetMigrationPreservesSpecimens',
        'auxiliaryKind': 'asset-migration', 'auxiliaryFilename': 'asset-migration-report.json',
        'auxiliaryPhase': 'migration-passed'},
    'missing-capability-v1': {'arms': (ARMS[0], ('packaged', 'packagedMissingCapabilitySingleRecreateAndClose', 240)),
        'delegatedMethod': 'explicitlyMissingCapabilityRecoveryDoesNotReplaceProductAcceptance',
        'auxiliaryKind': 'missing-capability', 'auxiliaryFilename': 'missing-capability-recovery-report.json',
        'auxiliaryPhase': 'expected-missing-capability-recovery-verified'},
}
FAILED_IMAGE = b'google/sdk_gphone16k_x86_64/emu64xa16k:15/AE3A.240806.043/12960925:userdebug/dev-keys'


def case_selection(case_set):
    need(case_set in CASE_SETS, 'fixed_diagnostic_case_set')
    return CASE_SETS[case_set]


def configured_memory(path):
    raw = path.read_bytes()
    need(raw in (b'4096', b'4096\n'), 'explicit_4096MiB_emulator_configuration_record_required')
    return {'configuredMemoryMiB': 4096, 'recordPath': str(path), 'recordSha256': hashlib.sha256(raw).hexdigest()}


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


def command(serial, arm, method, nonce, case_set='migration-v1'):
    selection = case_selection(case_set)
    need(serial == 'emulator-5554' and (arm, method) in [(a, m) for a, m, _ in selection['arms']], 'fixed_diagnostic_selection')
    need(re.fullmatch(r'[a-f0-9]{32}', nonce) is not None, 'fresh_nonce_format')
    return ['adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
        '-e', 'useTestStorageService', 'true', '-e', 'nativeLifecycleDiagnostic', 'true',
        '-e', 'diagnosticArm', arm, '-e', 'diagnosticNonce', nonce, '-e', 'diagnosticCaseSet', case_set,
        '-e', 'class', CLASS + '#' + method,
        PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner']


def environment(host, label, expected_boot=None, expected_fingerprint=None, *, expected_context=None, configured_memory_mib=None):
    need(configured_memory_mib == 4096, 'explicit_4096MiB_configuration_required')
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
    need(fingerprint == FAILED_IMAGE, 'exact_failed_image_fingerprint_required')
    need(expected_fingerprint is None or fingerprint == expected_fingerprint, 'same_image_fingerprint_required')
    need(host.command(label + '-avd', ['emu', 'avd', 'name']).splitlines() == [b'shikuang-api35-16k', b'OK'], 'exact_workflow_AVD')
    boot = host.command(label + '-boot', ['shell', 'cat', '/proc/sys/kernel/random/boot_id']).strip()
    need(re.fullmatch(rb'[a-f0-9-]{36}', boot) is not None and (expected_boot is None or boot == expected_boot), 'same_boot_required')
    meminfo = host.command(label + '-guest-meminfo', ['shell', 'cat', '/proc/meminfo'])
    totals = re.findall(rb'(?m)^MemTotal:\s*([1-9][0-9]*)\s+kB\s*$', meminfo)
    need(len(totals) == 1 and 3 * 1024 * 1024 <= int(totals[0]) <= 4096 * 1024, 'actual_4GiB_profile_MemTotal_required')
    system_pid = host.command(label + '-system-server-pid', ['shell', 'pidof', 'system_server']).strip()
    need(re.fullmatch(rb'[1-9][0-9]*', system_pid) is not None, 'one_live_system_server_required')
    service = host.command(label + '-package-service', ['shell', 'service', 'check', 'package']).strip()
    need(service == b'Service package: found', 'package_service_required')
    provider = host.command(label + '-provider', ['shell', 'dumpsys', 'webviewupdate'])
    need(re.search(rb'Current WebView package \(name, version\):\s*\(com\.google\.android\.webview,\s*124\.0\.6367\.219\)', provider) is not None,
         'same_stock_WebView124_required')
    package = host.command(label + '-provider-package', ['shell', 'dumpsys', 'package', 'com.google.android.webview'])
    need(re.search(rb'\bversionCode=636771938\b', package) is not None, 'same_stock_provider_code')
    host.network(label + '-offline')
    context = {'bootId': boot.decode('ascii'), 'imageFingerprint': fingerprint.decode('ascii'),
        'configuredMemoryMiB': configured_memory_mib, 'memTotalKiB': int(totals[0]),
        'systemServerPid': int(system_pid), 'packageServiceFound': True,
        'providerPackage': 'com.google.android.webview', 'providerVersion': '124.0.6367.219',
        'providerVersionCode': 636771938, 'offlineVerified': True}
    need(expected_context is None or context == expected_context, 'same_boot_RAM_system_server_provider_offline_required')
    return context


def evidence_report(report, arm, nonce, actual_pid, case_set='migration-v1'):
    """Validate current partial evidence without turning a failed probe green."""
    selection = case_selection(case_set)
    need(report.get('schema') == 'shikuang-native-lifecycle-diagnostic-v3' and report.get('arm') == arm,
         'correct_current_v3_report')
    need(report.get('caseSet') == case_set and report.get('delegatedMethod') ==
         (selection['delegatedMethod'] if arm == 'packaged' else None), 'exact_case_set_and_delegated_method')
    need(report.get('nonce') == nonce and type(report.get('completed')) is bool and report.get('plannedAttempts') == 1,
         'stale_or_duplicate_report')
    need(report.get('fullProductAcceptance') is False and report.get('originalFailureRemainsRecorded') is True,
         'diagnostic_not_acceptance')
    need(report['environment'] == {'sdk': 35, 'pageSize': 16384, 'providerPackage': 'com.google.android.webview',
        'providerVersion': '124.0.6367.219', 'providerVersionCode': 636771938,
        'pid': actual_pid, 'activeNetwork': None}, 'actual_native_environment_or_PID_mismatch')
    start, end = report['startedElapsedRealtimeNanos'], report['endedElapsedRealtimeNanos']
    need(type(start) is int and type(end) is int and 0 < start < end, 'native_monotonic_time')
    snap = report['lifecycle']; events = snap['events']
    need(snap.get('schema') == 'shikuang-debug-lifecycle-snapshot-v2' and snap.get('pid') == actual_pid
         and snap.get('droppedEvents') == 0 and 0 < len(events) <= 256, 'untruncated_current_process_receipts')
    last_seq, last_time = 0, start
    for row in events:
        seq, tick = row['sequence'], row['elapsedRealtimeNanos']
        need(row.get('schema') == 'shikuang-debug-lifecycle-v2' and type(seq) is int and seq == last_seq + 1
             and type(tick) is int and last_time <= tick <= end, 'monotonic_ordered_event_receipts')
        need(row['pid'] == actual_pid and type(row['tid']) is int and row['tid'] > 0, 'event_process_thread')
        need(row['ownerKind'] in ('activity', 'view', 'plugin', 'decor'), 'known_observer_kind')
        for key in ('ownerIdentity', 'activityIdentity', 'webViewIdentity', 'windowIdentity', 'decorIdentity'):
            need(type(row.get(key)) is int, 'cached_identity_number')
        need(row['changingConfigurations'] is None or type(row['changingConfigurations']) is bool,
             'cached_configuration_flag')
        last_seq, last_time = seq, tick
    ownership = report.get('ownership')
    need(isinstance(ownership, dict) and ownership.get('schema') == 'shikuang-direct-WebView-ownership-v2'
         and type(ownership.get('ownershipComplete')) is bool, 'explicit_native_ownership_or_unknown')
    return {'currentNativeEvidenceIntegrityValid': True, 'actualPid': actual_pid, 'events': len(events),
            'nativeCompleted': report['completed'], 'nativeOwnershipCompleteClaim': ownership['ownershipComplete'],
            'fullProductAcceptance': False}


def direct_ownership(report, arm):
    """Independently check actual per-view destroy, separate from Window callback."""
    prefix = 'plain-' if arm == 'plain' else ''
    events = report['lifecycle']['events']
    by_kind = {k: {} for k in ('activity', 'view', 'plugin', 'decor')}
    for row in events:
        by_kind[row['ownerKind']].setdefault(row['ownerIdentity'], {}).setdefault(row['phase'], []).append(row)
    births = [r for r in events if r['ownerKind'] == 'activity' and r['phase'] == prefix + 'create-exit']
    need(len(births) == 2 and len({r['ownerIdentity'] for r in births}) == 2, 'two_distinct_activities')
    activity_views = {r['ownerIdentity']: r['webViewIdentity'] for r in births}
    need(len(set(activity_views.values())) == 2 and 0 not in activity_views.values(), 'two_distinct_WebViews')
    for birth in births:
        phases = by_kind['activity'][birth['ownerIdentity']]
        need(birth['windowIdentity'] != 0 and birth['decorIdentity'] != 0, 'alive_Window_Decor_identity')
        for stage in ('create', 'resume', 'pause', 'stop', 'destroy'):
            enters, exits = phases.get(prefix + stage + '-enter', []), phases.get(prefix + stage + '-exit', [])
            need(enters and len(enters) == len(exits) and (stage not in ('create', 'destroy') or len(enters) == 1),
                 'activity_lifecycle_complete_' + stage)
            need(all(a['sequence'] < b['sequence'] for a, b in zip(enters, exits)), 'activity_enter_before_exit')
        need(phases[prefix + 'create-exit'][0]['sequence'] < phases[prefix + 'destroy-enter'][0]['sequence'],
             'activity_create_before_destroy')
        for row in phases[prefix + 'destroy-enter'] + phases[prefix + 'destroy-exit']:
            need(type(row['changingConfigurations']) is bool and row['windowIdentity'] == birth['windowIdentity']
                 and row['decorIdentity'] == birth['decorIdentity'], 'cached_destruction_context')
    need(set(by_kind['view']) == set(activity_views.values()), 'only_two_known_observed_views')
    for view, phases in by_kind['view'].items():
        for phase in ('view-create', 'view-destroy-enter', 'view-destroy-exit'):
            need(len(phases.get(phase, [])) == 1, 'exactly_once_actual_' + phase)
        birth, enter, exit = [phases[k][0] for k in ('view-create', 'view-destroy-enter', 'view-destroy-exit')]
        need(birth['sequence'] < enter['sequence'] < exit['sequence'], 'actual_WebView_destroy_order')
        need(all(r['webViewIdentity'] == view and activity_views.get(r['activityIdentity']) == view
                 for rows in phases.values() for r in rows), 'view_exact_known_owner')
        for stage in ('attach', 'detach'):
            enters, exits = phases.get('view-' + stage + '-enter', []), phases.get('view-' + stage + '-exit', [])
            need(len(enters) == len(exits) and all(a['sequence'] < b['sequence'] for a, b in zip(enters, exits)),
                 'actual_view_callback_complete_' + stage)
        need(phases.get('view-attach-enter'), 'each_probe_view_was_attached')
    last = births[-1]; final_phases = by_kind['activity'][last['ownerIdentity']]
    need(len(final_phases.get(prefix + 'detach-enter', [])) == len(final_phases.get(prefix + 'detach-exit', [])) == 1,
         'final_Activity_Window_detach')
    decor_events = [r for r in events if r['ownerKind'] == 'decor' and r['phase'] == 'decor-detach'
                    and r['decorIdentity'] == last['decorIdentity']]
    need(decor_events, 'actual_final_Decor_detach_callback')
    # A preserved Decor may notify the listeners registered by both Activities;
    # they are not two physical detaches, and no Window-identity equality is assumed.
    if arm == 'plain': need(not by_kind['plugin'], 'plain_has_no_mineral_plugin')
    else:
        need(len(by_kind['plugin']) == 2, 'two_plugin_owners')
        plugin_activity_owners = []
        for phases in by_kind['plugin'].values():
            for phase in ('plugin-destroy-enter', 'plugin-cancel-complete', 'plugin-cleanup-enter',
                          'plugin-cleanup-complete', 'plugin-shutdown-requested', 'plugin-destroy-exit'):
                need(len(phases.get(phase, [])) == 1, 'exact_plugin_cleanup_phase')
            need(phases['plugin-cleanup-enter'][0]['sequence'] < phases['plugin-cleanup-complete'][0]['sequence'],
                 'serialized_plugin_cleanup_returned')
            need(all(activity_views.get(r['activityIdentity']) == r['webViewIdentity']
                     for rows in phases.values() for r in rows), 'plugin_exact_owner_view')
            complete = phases['plugin-cleanup-complete'][0]
            need(complete['sessions'] == 0 and complete['environmentPresent'] is False, 'plugin_references_closed_not_RSS_claim')
            plugin_activity_owners.append(phases['plugin-destroy-enter'][0]['activityIdentity'])
        need(len(set(plugin_activity_owners)) == 2 and set(plugin_activity_owners) == set(activity_views),
             'one_actual_plugin_closure_for_each_Activity')
    return {'activities': 2, 'views': 2, 'actualViewDestroyPairs': 2,
            'finalDecorDetachObserved': True, 'ownershipComplete': True, 'nativeMemoryFullyReleased': None}


def verify_report(report, arm, nonce, actual_pid, case_set='migration-v1'):
    proof = evidence_report(report, arm, nonce, actual_pid, case_set)
    need(report['completed'] is True and report['ownership']['ownershipComplete'] is True,
         'failed_or_unknown_native_ownership_not_success')
    proof.update(direct_ownership(report, arm))
    if arm == 'plain':
        need(all(report.get(k) is True for k in ('initialPageReady', 'recreatedPageReady', 'scenarioCloseReturned')),
             'actual_plain_probe_checkpoints')
    elif case_set == 'migration-v1': need(report.get('legacyMethodReturned') is True, 'exact_legacy_method_returned')
    else: need(report.get('delegatedMethodReturned') is True, 'exact_missing_capability_method_returned')
    return proof


def verify_auxiliary(entry, case_set):
    selection = case_selection(case_set)
    need(entry.get('collected') is True and entry.get('filename') == selection['auxiliaryFilename']
         and entry.get('contextualOnlyNoOwnNonce') is True and entry.get('phase') == selection['auxiliaryPhase'],
         'current_contextual_' + selection['auxiliaryKind'] + '_report_required')
    if case_set == 'missing-capability-v1':
        need(entry.get('historyPreserved') is True and entry.get('fullProductAcceptance') is False
             and entry.get('intentionalMissingCapability') == 'AbortController', 'exact_recovery_negative_not_acceptance')


def collect_fixed_reports(host, out, result, arm, nonce, actual_pid, case_set='migration-v1'):
    """Called after every terminal, including failure. Never sets passed=True."""
    selection = case_selection(case_set)
    files = [('native', 'native-lifecycle-' + arm + '.json')]
    if arm == 'packaged': files.append((selection['auxiliaryKind'], selection['auxiliaryFilename']))
    collected = result.setdefault('collectedReports', {})
    for kind, filename in files:
        label = 'current-' + kind + '-report'
        try:
            raw = host.command(label, ['exec-out', 'content', 'read', '--uri',
                'content://androidx.test.services.storage.outputfiles/' + filename])
            need(0 < len(raw) <= 256 * 1024, 'fixed_native_report_bound')
            (out / filename).write_bytes(raw)
            entry = collected[kind] = {'filename': filename, 'bytes': len(raw),
                'sha256': hashlib.sha256(raw).hexdigest(), 'receiptLabel': label, 'collected': True}
            body = json.loads(raw)
            if kind == 'native':
                result['nativeEvidence'] = evidence_report(body, arm, nonce, actual_pid, case_set)
                entry['currentNoncePidIntegrityValid'] = True
            else:
                # Original product JSON has no nonce. Preserve it as auxiliary
                # evidence; only the current wrapper can attest its method returned.
                need(isinstance(body, dict), 'auxiliary_JSON_object')
                entry['contextualOnlyNoOwnNonce'] = True
                entry['phase'] = body.get('phase')
                if case_set == 'missing-capability-v1':
                    for key in ('historyPreserved', 'fullProductAcceptance', 'intentionalMissingCapability'):
                        entry[key] = body.get(key)
        except Exception as error:
            collected.setdefault(kind, {'filename': filename, 'collected': False})['failure'] = type(error).__name__ + ': ' + str(error)
            result.setdefault('evidenceCollectionProblems', []).append(kind + ':' + str(error))


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


def run_arm(out, arm, method, timeout, boot, fingerprint, seen_pids, *, case_set='migration-v1', expected_context=None,
            configured_memory_mib=None):
    out.mkdir(exist_ok=False)
    host = Host('emulator-5554', out)
    result = {'arm': arm, 'method': method, 'caseSet': case_set,
              'delegatedMethod': case_selection(case_set)['delegatedMethod'] if arm == 'packaged' else None,
              'passed': False, 'attempts': 0,
              'junitTerminalPassed': False, 'postEnvironmentVerified': False,
              'fullProductAcceptance': False, 'originalFailureRemainsRecorded': True}
    proc = None
    actual_pid, nonce = None, None
    def failure(label, error):
        text = label + ':' + type(error).__name__ + ': ' + str(error)
        result.setdefault('failure', text)
        result.setdefault('failureDetails', []).append(text)
    try:
        result['beforeEnvironment'] = environment(host, 'before', boot, fingerprint,
            expected_context=expected_context, configured_memory_mib=configured_memory_mib)
        result['beforeForceStopPid'] = host.pid('before-stop-pid')
        host.command('force-stop-once', ['shell', 'am', 'force-stop', PACKAGE])
        need(host.pid('after-stop-pid') is None, 'force_stop_PID_must_be_absent')
        nonce = secrets.token_hex(16); result['nonce'] = nonce
        argv = command('emulator-5554', arm, method, nonce, case_set)
        receipt = result['instrumentation'] = {'argv': argv, 'process_exited': False, 'return_code': None}
        with (out / 'instrumentation.stdout.bin').open('wb') as stdout, (out / 'instrumentation.stderr.bin').open('wb') as stderr:
            started = time.monotonic(); result['attempts'] += 1
            proc = subprocess.Popen(argv, stdout=stdout, stderr=stderr)
            receipt.update(started_monotonic_seconds=started, host_adb_pid=proc.pid)
            while time.monotonic() - started < 20 and proc.poll() is None:
                pid = host.pid('live-pid-' + str(len(host.receipts)))
                if pid is not None: actual_pid = pid; break
                time.sleep(.1)
            need(actual_pid is not None and actual_pid not in seen_pids
                 and actual_pid != result['beforeForceStopPid'], 'new_distinct_live_PID_required')
            seen_pids.add(actual_pid); result['actualPid'] = actual_pid
            code = proc.wait(timeout=max(1, timeout - (time.monotonic() - started)))
        terminal((out / 'instrumentation.stdout.bin').read_bytes(), (out / 'instrumentation.stderr.bin').read_bytes(), code, method)
        result['junitTerminalPassed'] = True
    except Exception as error:
        failure('primary', error)
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
        # Recovery of partial evidence is independent of the authoritative JUnit
        # outcome. Native crashes can leave no finally report; absence stays missing.
        if proc is not None and nonce is not None:
            collect_fixed_reports(host, out, result, arm, nonce, actual_pid, case_set)
            if result['junitTerminalPassed']:
                try:
                    raw = (out / ('native-lifecycle-' + arm + '.json')).read_bytes()
                    result['verifiedNativeReport'] = verify_report(json.loads(raw), arm, nonce, actual_pid, case_set)
                    if arm == 'packaged':
                        verify_auxiliary(result['collectedReports'].get(case_selection(case_set)['auxiliaryKind'], {}), case_set)
                except Exception as error: failure('native-success-gate', error)
        try:
            result['afterEnvironment'] = environment(host, 'after', boot, fingerprint,
                expected_context=expected_context, configured_memory_mib=configured_memory_mib)
            result['postEnvironmentVerified'] = True
        except Exception as error: failure('post-environment', error)
        result['captureProblems'] = capture(host, 'final')
        if result['captureProblems']: failure('capture', ValueError(';'.join(result['captureProblems'])))
        if actual_pid is not None and not result['captureProblems']:
            try:
                reject_observed_crash((out / 'final-exit-info.stdout.bin').read_bytes(),
                    (out / 'final-logcat.stdout.bin').read_bytes(), actual_pid)
            except Exception as error: failure('current-native-crash', error)
        result['passed'] = bool(result['junitTerminalPassed'] and result.get('verifiedNativeReport')
            and result['postEnvironmentVerified'] and not result.get('failureDetails')
            and not result.get('evidenceCollectionProblems'))
        (out / 'arm-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    p = argparse.ArgumentParser(); p.add_argument('--out', type=Path, required=True)
    p.add_argument('--source-sha', required=True); p.add_argument('--unit-nonce', required=True)
    p.add_argument('--case-set', choices=tuple(CASE_SETS), default='migration-v1')
    p.add_argument('--configured-memory-record', type=Path, required=True)
    args = p.parse_args()
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_only_no_physical_device')
    need(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'reruns_are_not_authorized')
    need(re.fullmatch(r'[a-f0-9]{40}', args.source_sha) is not None, 'exact_source_SHA')
    need(subprocess.check_output(['git', 'rev-parse', 'HEAD']).strip().decode() == args.source_sha, 'checkout_SHA_mismatch')
    need(re.fullmatch(r'[a-f0-9]{32}', args.unit_nonce) is not None, 'explicit_fresh_unit_nonce')
    args.out.mkdir(parents=True, exist_ok=False)
    result = {'schema': 'shikuang-host-native-lifecycle-pair-v3', 'sourceSha': args.source_sha, 'caseSet': args.case_set,
        'unitNonce': args.unit_nonce, 'passed': False, 'maximumArms': 2, 'maximumAttemptsPerArm': 1,
        'fullProductAcceptance': False, 'rootCauseConfirmed': False,
        'originalFailingRun': 40832483897 if args.case_set == 'missing-capability-v1' else 39246792540,
        'arms': []}
    try:
        host = Host('emulator-5554', args.out)
        result['memoryConfiguration'] = configured_memory(args.configured_memory_record)
        memory_mib = result['memoryConfiguration']['configuredMemoryMiB']
        context = result['initialEnvironment'] = environment(host, 'initial', configured_memory_mib=memory_mib)
        boot = context['bootId'].encode('ascii'); result['bootId'] = context['bootId']
        fingerprint = context['imageFingerprint'].encode('ascii'); result['imageFingerprint'] = context['imageFingerprint']
        for arm, method, timeout in case_selection(args.case_set)['arms']:
            # A failed arm is retained. Revalidate without reconnect/repair/reboot
            # before deciding whether the other declared arm can still execute.
            environment(host, 'pre-' + arm, boot, fingerprint, expected_context=context, configured_memory_mib=memory_mib)
            arm_result = run_arm(args.out / arm, arm, method, timeout, boot, fingerprint,
                                 {r['actualPid'] for r in result['arms'] if 'actualPid' in r},
                                 case_set=args.case_set, expected_context=context, configured_memory_mib=memory_mib)
            result['arms'].append(arm_result)
        result['passed'] = len(result['arms']) == 2 and all(r['passed'] for r in result['arms'])
    except Exception as error:
        result['environmentFailure'] = type(error).__name__ + ': ' + str(error)
    finally:
        (args.out / 'pair-result.json').write_text(json.dumps(result, indent=2) + '\n')
    if not result['passed']: raise SystemExit(1)


if __name__ == '__main__': main()

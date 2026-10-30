"""Synthetic evidence counterexamples; no Android, images or model execution."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from android_lifecycle_diagnostic import (CASE_SETS, CLASS, FAILED_IMAGE, collect_fixed_reports, command,
    configured_memory, environment, reject_observed_crash, run_arm, terminal, verify_auxiliary, verify_report)

NONCE = 'a' * 32
PID = 2345


def synthetic_report(arm, old_view_destroy=True, old_activity_detach=False, completed=True, case_set='migration-v1'):
    events = []
    def row(phase, owner, view, kind='activity', activity=None, window=None, decor=None):
        seq = len(events) + 1
        owner_activity = owner if activity is None else activity
        events.append({'schema': 'shikuang-debug-lifecycle-v2', 'sequence': seq,
            'elapsedRealtimeNanos': 100 + seq, 'phase': phase,
            'ownerIdentity': owner, 'ownerKind': kind, 'activityIdentity': owner_activity,
            'webViewIdentity': view, 'windowIdentity': (owner_activity + 300) if window is None else window,
            'decorIdentity': 900 if decor is None else decor,
            'changingConfigurations': bool(owner == 100 and 'destroy' in phase) if kind == 'activity' else None,
            'jobs': 0 if kind == 'plugin' else -1, 'sessions': 0 if kind == 'plugin' else -1,
            'environmentPresent': False if kind == 'plugin' else None,
            'pid': PID, 'tid': 24 if kind != 'plugin' else 25})
    prefix = 'plain-' if arm == 'plain' else ''
    for owner, view in ((100, 200), (101, 201)):
        row(prefix + 'create-enter', owner, view)
        row('view-create', view, view, 'view', owner)
        row(prefix + 'create-exit', owner, view)
        row('view-attach-enter', view, view, 'view', owner)
        row('view-attach-exit', view, view, 'view', owner)
        for stage in ('resume', 'pause', 'stop', 'destroy'):
            row(prefix + stage + '-enter', owner, view)
            if stage == 'destroy' and arm == 'packaged':
                for phase in ('plugin-destroy-enter', 'plugin-cancel-complete', 'plugin-cleanup-enter',
                              'plugin-cleanup-complete', 'plugin-shutdown-requested', 'plugin-destroy-exit'):
                    row(phase, owner + 1000, view, 'plugin', owner, 0, 0)
            row(prefix + stage + '-exit', owner, view)
        row('view-detach-enter', view, view, 'view', owner)
        row('view-detach-exit', view, view, 'view', owner)
        if owner == 101 or old_view_destroy:
            row('view-destroy-enter', view, view, 'view', owner)
            row('view-destroy-exit', view, view, 'view', owner)
        if owner == 101 or old_activity_detach:
            row(prefix + 'detach-enter', owner, view)
            row(prefix + 'detach-exit', owner, view)
        if owner == 101: row('decor-detach', 900, 0, 'decor', owner)
    return {'schema': 'shikuang-native-lifecycle-diagnostic-v3', 'arm': arm, 'nonce': NONCE,
        'caseSet': case_set, 'delegatedMethod': CASE_SETS[case_set]['delegatedMethod'] if arm == 'packaged' else None,
        'completed': completed, 'plannedAttempts': 1, 'fullProductAcceptance': False,
        'originalFailureRemainsRecorded': True, 'startedElapsedRealtimeNanos': 100,
        'endedElapsedRealtimeNanos': 1000, 'initialPageReady': True,
        'recreatedPageReady': True, 'scenarioCloseReturned': True, 'legacyMethodReturned': True,
        'delegatedMethodReturned': True,
        'ownership': {'schema': 'shikuang-direct-WebView-ownership-v2', 'ownershipComplete': old_view_destroy},
        'environment': {'sdk': 35, 'pageSize': 16384, 'providerPackage': 'com.google.android.webview',
            'providerVersion': '124.0.6367.219', 'providerVersionCode': 636771938,
            'pid': PID, 'activeNetwork': None},
        'lifecycle': {'schema': 'shikuang-debug-lifecycle-snapshot-v2', 'pid': PID, 'droppedEvents': 0, 'events': events}}


def synthetic_terminal(method='plainWebViewSingleRecreateAndClose'):
    return ('INSTRUMENTATION_STATUS: class=' + CLASS + '\nINSTRUMENTATION_STATUS: test=' + method
        + '\nINSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS: class=' + CLASS
        + '\nINSTRUMENTATION_STATUS: test=' + method
        + '\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()


class DiagnosticEvidenceTests(unittest.TestCase):
    def test_failed_JUnit_finally_collects_JSON_and_post_environment(self):
        report = synthetic_report('packaged', old_view_destroy=False, completed=False)
        probes = []
        class FixtureHost:
            def __init__(self, serial, out): self.receipts = []
            def pid(self, label): return PID if label.startswith('live-pid-') else None
            def command(self, label, argv):
                if label == 'force-stop-once': return b''
                return json.dumps(report if label == 'current-native-report' else {'phase': 'migration-passed'}).encode()
        class FixtureProcess:
            pid = 98765
            returncode = None
            def poll(self): return self.returncode
            def wait(self, timeout): self.returncode = 0; return 0
        def popen(argv, stdout, stderr):
            raw = synthetic_terminal('packagedMigrationSingleRecreateAndClose').replace(
                b'INSTRUMENTATION_STATUS_CODE: 0', b'INSTRUMENTATION_STATUS_CODE: -2').replace(
                b'OK (1 test)', b'FAILURES!!!\nTests run: 1,  Failures: 1')
            stdout.write(raw); stdout.flush()
            return FixtureProcess()
        def fake_environment(host, label, *args, **kwargs): probes.append(label)
        def fake_capture(host, label):
            (folder / 'final-exit-info.stdout.bin').write_bytes(b'')
            (folder / 'final-logcat.stdout.bin').write_bytes(b'')
            return []
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'packaged'
            with patch('android_lifecycle_diagnostic.Host', FixtureHost), patch('android_lifecycle_diagnostic.environment', fake_environment), \
                    patch('android_lifecycle_diagnostic.subprocess.Popen', popen), patch('android_lifecycle_diagnostic.capture', fake_capture), \
                    patch('android_lifecycle_diagnostic.secrets.token_hex', return_value=NONCE):
                result = run_arm(folder, 'packaged', 'packagedMigrationSingleRecreateAndClose', 240, b'boot', b'fingerprint', set())
            self.assertTrue((folder / 'native-lifecycle-packaged.json').is_file())
            self.assertTrue((folder / 'asset-migration-report.json').is_file())
        self.assertEqual(probes, ['before', 'after'])
        self.assertTrue(result['postEnvironmentVerified'])
        self.assertTrue(result['nativeEvidence']['currentNativeEvidenceIntegrityValid'])
        self.assertFalse(result['passed']); self.assertFalse(result['junitTerminalPassed'])
        self.assertIn('one_test_start_and_success', result['failure'])

    def test_AOSP_recreated_Decor_no_old_Activity_detach_needs_both_actual_destroys(self):
        for arm in ('plain', 'packaged'):
            valid = synthetic_report(arm, old_view_destroy=True, old_activity_detach=False)
            self.assertTrue(verify_report(valid, arm, NONCE, PID)['ownershipComplete'])
            for misleading_claim in (False, True):
                missing = synthetic_report(arm, old_view_destroy=False, old_activity_detach=False)
                missing['ownership']['ownershipComplete'] = misleading_claim
                with self.assertRaises(ValueError): verify_report(missing, arm, NONCE, PID)

    def test_two_Activity_detaches_do_not_substitute_for_missing_actual_destroy(self):
        report = synthetic_report('packaged', old_view_destroy=False, old_activity_detach=True)
        report['ownership']['ownershipComplete'] = True
        with self.assertRaises(ValueError): verify_report(report, 'packaged', NONCE, PID)

    def test_duplicate_or_reversed_destroy_dispatch_fails(self):
        for mode in ('duplicate', 'reversed'):
            report = synthetic_report('plain'); events = report['lifecycle']['events']
            target = next(r for r in events if r['phase'] == 'view-destroy-enter')
            if mode == 'duplicate':
                position = events.index(target); events.insert(position, dict(target))
                for i, event in enumerate(events): event['sequence'] = i + 1; event['elapsedRealtimeNanos'] = 101 + i
            else:
                target['phase'] = 'view-destroy-exit'
                next(r for r in events if r['phase'] == 'view-destroy-exit' and r is not target)['phase'] = 'view-destroy-enter'
            with self.assertRaises(ValueError): verify_report(report, 'plain', NONCE, PID)

    def test_failed_JUnit_still_collects_current_native_and_auxiliary_JSON(self):
        report = synthetic_report('packaged', old_view_destroy=False, completed=False)
        class FixtureHost:
            calls = []
            def command(self, label, argv):
                self.calls.append((label, argv))
                return json.dumps(report if label == 'current-native-report' else {'phase': 'migration-passed'}).encode()
        host = FixtureHost()
        result = {'passed': False, 'junitTerminalPassed': False, 'failure': 'actual JUnit assertion failure'}
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp); collect_fixed_reports(host, out, result, 'packaged', NONCE, PID)
            self.assertEqual({p.name for p in out.iterdir()}, {'native-lifecycle-packaged.json', 'asset-migration-report.json'})
        self.assertEqual(len(host.calls), 2)
        self.assertFalse(result['passed']); self.assertFalse(result['junitTerminalPassed'])
        self.assertEqual(result['failure'], 'actual JUnit assertion failure')
        self.assertTrue(result['nativeEvidence']['currentNativeEvidenceIntegrityValid'])
        self.assertFalse(result['nativeEvidence']['nativeCompleted'])
        self.assertTrue(result['collectedReports']['asset-migration']['contextualOnlyNoOwnNonce'])

    def test_environment_rejects_changed_boot_image_provider_or_extra_device(self):
        boot = b'12345678-1234-1234-1234-123456789abc'
        class FixtureHost:
            replacements = {}
            def command(self, label, argv):
                fixture = {
                    'devices': b'List of devices attached\nemulator-5554\tdevice\n',
                    'qemu': b'1', 'sdk': b'35', 'abi': b'x86_64', 'page': b'16384',
                    'root': b'0', 'image-fingerprint': FAILED_IMAGE,
                    'avd': b'shikuang-api35-16k\nOK\n', 'boot': boot,
                    'guest-meminfo': b'MemTotal: 4014396 kB\nMemAvailable: 2000000 kB\n',
                    'system-server-pid': b'548', 'package-service': b'Service package: found\n',
                    'provider': b'Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)',
                    'provider-package': b'versionCode=636771938 minSdk=29',
                }
                key = label.removeprefix('test-')
                return self.replacements.get(key, fixture[key])
            def network(self, label): pass
        host = FixtureHost()
        context = environment(host, 'test', boot, FAILED_IMAGE, configured_memory_mib=4096)
        self.assertEqual(context['bootId'], boot.decode())
        self.assertEqual(context['memTotalKiB'], 4014396)
        self.assertEqual(context['configuredMemoryMiB'], 4096)
        for memory in (None, 3072):
            with self.assertRaises(ValueError): environment(host, 'test', configured_memory_mib=memory)
        for replacement in ({'boot': b'99999999-1234-1234-1234-123456789abc'},
                            {'image-fingerprint': b'CHANGED'},
                            {'provider': b'Current WebView package (name, version): (com.google.android.webview, 125.0)'},
                            {'provider-package': b'versionCode=9999'},
                            {'guest-meminfo': b''},
                            {'guest-meminfo': b'MemTotal: 4014396 kB\nMemTotal: 4014396 kB\n'},
                            {'guest-meminfo': b'MemTotal: 4014400 kB\n'},
                            {'system-server-pid': b''}, {'system-server-pid': b'548 999'},
                            {'system-server-pid': b'549'}, {'package-service': b'Service package: not found'},
                            {'devices': b'List of devices attached\nemulator-5554\tdevice\nother-device\tdevice\n'}):
            host.replacements = replacement
            with self.assertRaises(ValueError):
                environment(host, 'test', boot, FAILED_IMAGE, expected_context=context, configured_memory_mib=4096)

    def test_configuration_record_cannot_be_missing_or_3072(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'configured-memory.txt'
            with self.assertRaises(FileNotFoundError): configured_memory(path)
            for raw in (b'', b'3072\n', b'4096\n3072\n'):
                path.write_bytes(raw)
                with self.assertRaises(ValueError): configured_memory(path)
            path.write_bytes(b'4096\n')
            self.assertEqual(configured_memory(path)['configuredMemoryMiB'], 4096)

    def test_valid_two_distinct_closed_activities_are_diagnostic_only(self):
        for arm in ('plain', 'packaged'):
            proof = verify_report(synthetic_report(arm), arm, NONCE, PID)
            self.assertEqual(proof['activities'], 2)
            self.assertFalse(proof['fullProductAcceptance'])

    def test_stale_nonce_wrong_PID_or_changed_provider_are_rejected(self):
        for mutate in (lambda r: r.update(nonce='b' * 32),
                       lambda r: r['environment'].update(pid=9999),
                       lambda r: r['environment'].update(providerVersion='newer')):
            report = synthetic_report('plain'); mutate(report)
            with self.assertRaises(ValueError): verify_report(report, 'plain', NONCE, PID)

    def test_missing_destroy_or_dropped_receipt_cannot_pass(self):
        report = synthetic_report('plain')
        report['lifecycle']['events'] = [r for r in report['lifecycle']['events'] if not r['phase'].endswith('detach-exit')]
        with self.assertRaises(ValueError): verify_report(report, 'plain', NONCE, PID)
        report = synthetic_report('plain'); report['lifecycle']['droppedEvents'] = 1
        with self.assertRaises(ValueError): verify_report(report, 'plain', NONCE, PID)

    def test_native_time_sequence_reversal_or_foreign_process_rejected(self):
        for key, value in [('sequence', 0), ('elapsedRealtimeNanos', 1), ('pid', 7777)]:
            report = synthetic_report('plain'); report['lifecycle']['events'][3][key] = value
            with self.assertRaises(ValueError): verify_report(report, 'plain', NONCE, PID)

    def test_missing_queued_cleanup_does_not_become_completed(self):
        report = synthetic_report('packaged')
        report['lifecycle']['events'] = [r for r in report['lifecycle']['events'] if r['phase'] != 'plugin-cleanup-complete']
        with self.assertRaises(ValueError): verify_report(report, 'packaged', NONCE, PID)

    def test_plugin_must_belong_to_known_activity_and_view(self):
        for key, value in [('activityIdentity', 9999), ('webViewIdentity', 201)]:
            report = synthetic_report('packaged')
            next(r for r in report['lifecycle']['events'] if r['ownerKind'] == 'plugin')[key] = value
            with self.assertRaises(ValueError): verify_report(report, 'packaged', NONCE, PID)
        report = synthetic_report('packaged')
        for row in report['lifecycle']['events']:
            if row['ownerKind'] == 'plugin': row['activityIdentity'] = 100; row['webViewIdentity'] = 200
        with self.assertRaises(ValueError): verify_report(report, 'packaged', NONCE, PID)

    def test_exact_single_test_terminal_required(self):
        terminal(synthetic_terminal(), b'', 0, 'plainWebViewSingleRecreateAndClose')
        for raw in (synthetic_terminal() + b'INSTRUMENTATION_CODE: -1\n',
                    synthetic_terminal() + b'Process crashed\n',
                    synthetic_terminal().replace(b'OK (1 test)', b'OK (2 tests)'),
                    synthetic_terminal('wrongMethod')):
            with self.assertRaises(ValueError): terminal(raw, b'', 0, 'plainWebViewSingleRecreateAndClose')

    def test_partial_success_fragment_cannot_hide_failure(self):
        for code, stderr in [(1, b''), (0, b'failure')]:
            with self.assertRaises(ValueError): terminal(synthetic_terminal(), stderr, code, 'plainWebViewSingleRecreateAndClose')

    def test_only_current_PID_crash_invalidates_current_arm(self):
        previous = b'ApplicationExitInfo #1:\n timestamp=x pid=9999 realUid=1\n process=com.shikuang.app.preview reason=5 (APP CRASH(NATIVE))\n'
        reject_observed_crash(previous, b'', PID)
        with self.assertRaises(ValueError): reject_observed_crash(previous.replace(b'pid=9999', b'pid=2345'), b'', PID)
        with self.assertRaises(ValueError): reject_observed_crash(b'', b'Fatal signal 5 (SIGTRAP) in tid 45, pid 2345 (ng.app.preview)\n', PID)

    def test_command_cannot_select_arbitrary_test_or_device(self):
        argv = command('emulator-5554', 'plain', 'plainWebViewSingleRecreateAndClose', NONCE)
        self.assertEqual(argv.count('instrument'), 1)
        self.assertNotIn('clear', argv); self.assertNotIn('reboot', argv)
        for params in [('physical-phone', 'plain', 'plainWebViewSingleRecreateAndClose', NONCE),
                       ('emulator-5554', 'plain', 'otherTest', NONCE),
                       ('emulator-5554', 'plain', 'plainWebViewSingleRecreateAndClose', ';unsafe')]:
            with self.assertRaises(ValueError): command(*params)

    def test_fixed_case_sets_select_exact_plain_then_packaged_methods(self):
        for case_set, expected in (
                ('migration-v1', 'packagedMigrationSingleRecreateAndClose'),
                ('missing-capability-v1', 'packagedMissingCapabilitySingleRecreateAndClose')):
            arms = CASE_SETS[case_set]['arms']
            self.assertEqual([(a, m) for a, m, _ in arms], [
                ('plain', 'plainWebViewSingleRecreateAndClose'), ('packaged', expected)])
            for arm, method, _ in arms:
                argv = command('emulator-5554', arm, method, NONCE, case_set)
                self.assertIn(CLASS + '#' + method, argv)
                self.assertEqual(argv[argv.index('diagnosticCaseSet') + 1], case_set)
            other = 'packagedMissingCapabilitySingleRecreateAndClose' if case_set == 'migration-v1' else 'packagedMigrationSingleRecreateAndClose'
            with self.assertRaises(ValueError): command('emulator-5554', 'packaged', other, NONCE, case_set)
        with self.assertRaises(ValueError): command('emulator-5554', 'plain', 'plainWebViewSingleRecreateAndClose', NONCE, 'arbitrary')

    def test_recovery_requires_exact_wrapper_case_method_and_return(self):
        report = synthetic_report('packaged', case_set='missing-capability-v1')
        self.assertTrue(verify_report(report, 'packaged', NONCE, PID, 'missing-capability-v1')['ownershipComplete'])
        for mutate in (lambda r: r.update(caseSet='migration-v1'),
                       lambda r: r.update(delegatedMethod='legacyNativeAssetMigrationPreservesSpecimens'),
                       lambda r: r.update(delegatedMethodReturned=False),
                       lambda r: r.update(completed=False),
                       lambda r: r.update(nonce='b' * 32),
                       lambda r: r['environment'].update(pid=9999)):
            report = synthetic_report('packaged', case_set='missing-capability-v1'); mutate(report)
            with self.assertRaises(ValueError): verify_report(report, 'packaged', NONCE, PID, 'missing-capability-v1')
        with self.assertRaises(ValueError):
            verify_report(synthetic_report('packaged'), 'packaged', NONCE, PID, 'missing-capability-v1')

    def test_migration_auxiliary_cannot_satisfy_recovery_gate(self):
        valid = {'collected': True, 'filename': 'missing-capability-recovery-report.json',
            'contextualOnlyNoOwnNonce': True, 'phase': 'expected-missing-capability-recovery-verified',
            'historyPreserved': True, 'fullProductAcceptance': False, 'intentionalMissingCapability': 'AbortController'}
        verify_auxiliary(valid, 'missing-capability-v1')
        for replacement in ({'filename': 'asset-migration-report.json', 'phase': 'migration-passed'},
                            {'phase': 'migration-passed'}, {'historyPreserved': None},
                            {'fullProductAcceptance': True}, {'collected': False},
                            {'intentionalMissingCapability': 'other'}, {'contextualOnlyNoOwnNonce': False}):
            with self.assertRaises(ValueError): verify_auxiliary({**valid, **replacement}, 'missing-capability-v1')

    def test_recovery_single_attempt_retains_missing_JSON_crash_and_reused_PID_failures(self):
        case_set = 'missing-capability-v1'; method = 'packagedMissingCapabilitySingleRecreateAndClose'
        for mode in ('success', 'missing-native', 'missing-auxiliary', 'current-crash', 'reused-pid', 'failed-junit'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp) / 'packaged'; starts = []
                report = synthetic_report('packaged', case_set=case_set)
                auxiliary = {'phase': 'expected-missing-capability-recovery-verified',
                    'historyPreserved': True, 'fullProductAcceptance': False, 'intentionalMissingCapability': 'AbortController'}
                class FixtureHost:
                    def __init__(self, serial, out): self.receipts = []
                    def pid(self, label): return PID if label.startswith('live-pid-') else None
                    def command(self, label, argv):
                        if label == 'force-stop-once': return b''
                        if (mode == 'missing-native' and label == 'current-native-report') or (
                                mode == 'missing-auxiliary' and label == 'current-missing-capability-report'):
                            raise ValueError('current report absent after native failure')
                        return json.dumps(report if label == 'current-native-report' else auxiliary).encode()
                class FixtureProcess:
                    pid = 98765
                    returncode = None
                    def poll(self): return self.returncode
                    def kill(self): self.returncode = -9
                    def wait(self, timeout): self.returncode = 0; return 0
                def popen(argv, stdout, stderr):
                    starts.append(argv)
                    raw = synthetic_terminal(method)
                    if mode == 'failed-junit':
                        raw = raw.replace(b'INSTRUMENTATION_STATUS_CODE: 0', b'INSTRUMENTATION_STATUS_CODE: -2')
                    stdout.write(raw); stdout.flush()
                    return FixtureProcess()
                def fake_capture(host, label):
                    (folder / 'final-exit-info.stdout.bin').write_bytes(b'')
                    (folder / 'final-logcat.stdout.bin').write_bytes(
                        b'Fatal signal 5 (SIGTRAP), pid 2345 (ng.app.preview)\n' if mode == 'current-crash' else b'')
                    return []
                with patch('android_lifecycle_diagnostic.Host', FixtureHost), \
                        patch('android_lifecycle_diagnostic.environment', return_value={'offlineVerified': True}), \
                        patch('android_lifecycle_diagnostic.subprocess.Popen', popen), \
                        patch('android_lifecycle_diagnostic.capture', fake_capture), \
                        patch('android_lifecycle_diagnostic.secrets.token_hex', return_value=NONCE):
                    result = run_arm(folder, 'packaged', method, 240, b'boot', FAILED_IMAGE,
                        {PID} if mode == 'reused-pid' else set(), case_set=case_set,
                        expected_context={'offlineVerified': True}, configured_memory_mib=4096)
                self.assertEqual(len(starts), 1); self.assertEqual(result['attempts'], 1)
                self.assertEqual(result['passed'], mode == 'success')
                self.assertFalse(result['fullProductAcceptance'])
                self.assertEqual(result['caseSet'], case_set)
                self.assertTrue(result['postEnvironmentVerified'])
                if mode == 'failed-junit':
                    self.assertTrue(result['nativeEvidence']['currentNativeEvidenceIntegrityValid'])
                    self.assertFalse(result['junitTerminalPassed'])
                if mode == 'current-crash': self.assertIn('current-native-crash', result['failure'])
                if mode.startswith('missing-'): self.assertTrue(result['evidenceCollectionProblems'])


if __name__ == '__main__': unittest.main()

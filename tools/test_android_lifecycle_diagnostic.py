"""Synthetic evidence counterexamples; no Android, images or model execution."""
import unittest

from android_lifecycle_diagnostic import CLASS, command, environment, reject_observed_crash, terminal, verify_report

NONCE = 'a' * 32
PID = 2345


def synthetic_report(arm):
    events = []
    def row(phase, owner, view, kind='activity', activity=None):
        seq = len(events) + 1
        events.append({'sequence': seq, 'elapsedRealtimeNanos': 100 + seq,
            'phase': phase, 'ownerIdentity': owner, 'ownerKind': kind,
            'activityIdentity': owner if activity is None else activity,
            'webViewIdentity': view, 'pid': PID, 'tid': 24 if kind == 'activity' else 25})
    prefix = 'plain-' if arm == 'plain' else ''
    for owner, view in ((100, 200), (101, 201)):
        for stage in ('create', 'resume', 'pause', 'stop', 'destroy', 'detach'):
            row(prefix + stage + '-enter', owner, view)
            if stage == 'destroy' and arm == 'packaged':
                for phase in ('plugin-destroy-enter', 'plugin-cancel-complete', 'plugin-cleanup-enter',
                              'plugin-cleanup-complete', 'plugin-shutdown-requested', 'plugin-destroy-exit'):
                    row(phase, owner + 1000, view, 'plugin', owner)
            row(prefix + stage + '-exit', owner, view)
    return {'schema': 'shikuang-native-lifecycle-diagnostic-v1', 'arm': arm, 'nonce': NONCE,
        'completed': True, 'plannedAttempts': 1, 'fullProductAcceptance': False,
        'originalFailureRemainsRecorded': True, 'startedElapsedRealtimeNanos': 100,
        'endedElapsedRealtimeNanos': 1000,
        'environment': {'sdk': 35, 'pageSize': 16384, 'providerPackage': 'com.google.android.webview',
            'providerVersion': '124.0.6367.219', 'providerVersionCode': 636771938,
            'pid': PID, 'activeNetwork': None},
        'lifecycle': {'pid': PID, 'droppedEvents': 0, 'events': events}}


def synthetic_terminal(method='plainWebViewSingleRecreateAndClose'):
    return ('INSTRUMENTATION_STATUS: class=' + CLASS + '\nINSTRUMENTATION_STATUS: test=' + method
        + '\nINSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS: class=' + CLASS
        + '\nINSTRUMENTATION_STATUS: test=' + method
        + '\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()


class DiagnosticEvidenceTests(unittest.TestCase):
    def test_environment_rejects_changed_boot_image_provider_or_extra_device(self):
        boot = b'12345678-1234-1234-1234-123456789abc'
        class FixtureHost:
            replacements = {}
            def command(self, label, argv):
                fixture = {
                    'devices': b'List of devices attached\nemulator-5554\tdevice\n',
                    'qemu': b'1', 'sdk': b'35', 'abi': b'x86_64', 'page': b'16384',
                    'root': b'0', 'image-fingerprint': b'UNIT_ONLY_FIXED_FINGERPRINT',
                    'avd': b'shikuang-api35-16k\nOK\n', 'boot': boot,
                    'provider': b'Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)',
                    'provider-package': b'versionCode=636771938 minSdk=29',
                }
                key = label.removeprefix('test-')
                return self.replacements.get(key, fixture[key])
            def network(self, label): pass
        host = FixtureHost()
        self.assertEqual(environment(host, 'test', boot, b'UNIT_ONLY_FIXED_FINGERPRINT'), boot)
        for replacement in ({'boot': b'99999999-1234-1234-1234-123456789abc'},
                            {'image-fingerprint': b'CHANGED'},
                            {'provider': b'Current WebView package (name, version): (com.google.android.webview, 125.0)'},
                            {'devices': b'List of devices attached\nemulator-5554\tdevice\nother-device\tdevice\n'}):
            host.replacements = replacement
            with self.assertRaises(ValueError): environment(host, 'test', boot, b'UNIT_ONLY_FIXED_FINGERPRINT')

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


if __name__ == '__main__': unittest.main()

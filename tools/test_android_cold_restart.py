"""UNIT_ONLY metadata/terminal contracts, never Android or persistence evidence."""
import base64
import copy
import json
import tempfile
import unittest
import subprocess
from unittest.mock import patch
from pathlib import Path
from android_cold_restart import CLASS, METHOD, Host, first_phase, identity, instrumentation_command, required_original_junit, sha, terminal, verify_artifacts, verify_cold


def UNIT_ONLY_metadata():
    # Existing public engineering photo bytes; no source/held-out images or inference.
    photo = (Path(__file__).resolve().parents[1] / 'android/app/src/androidTest/assets/quartz.jpg').read_bytes()
    row = {'id': 'UNIT_ONLY-record', 'key': 'quartz', 'modelCount': 3, 'photoCount': 1,
           'photos': ['data:image/jpeg;base64,' + base64.b64encode(photo).decode()],
           'modelVersion': 'UNIT_ONLY_NO_RUNTIME', 'manifestSha256': 'a' * 64}
    record = json.dumps(row, ensure_ascii=False, separators=(',', ':'))
    search = json.dumps([{'kind': 'records', 'query': '石英'}], ensure_ascii=False, separators=(',', ':'))
    baseline = dict(identity(record, search), source='real-ui-native-three-model-record', firstPhasePid=100,
                    origin='https://localhost')
    report = {'phase': 'passed', 'fullOfflineProductVerified': True, 'photoRecognitionVerified': True,
              'origin': 'https://localhost', 'historySnapshot': record, 'searchHistorySnapshot': search,
              'coldProcessBaseline': baseline, 'quartz': {'key': 'quartz', 'engine': 'onnx-native-android', 'modelCount': 3, 'manifestSha256': 'a' * 64},
              'uiCancelRetry': {'cancelled': True, 'photoRetained': True, 'retried': True},
              'history': {'recordId': row['id'], 'activityRecreatePreserved': True},
              'savedRecords': [{'id': row['id']}], 'recordsAfterRejection': [{'id': row['id']}],
              'networkAfterActivityRecreate': {'native': {'sdk': 24, 'pageSize': 4096, 'packageName': 'com.shikuang.app.preview', 'activeNetwork': None, 'connected': False, 'internetCapability': False}}}
    return report


def UNIT_ONLY_artifact_bundle(folder):
    """Inert synthetic bytes only: no actual photo, process, device or inference."""
    record = json.dumps({'id': 'UNIT_ONLY-record', 'key': 'quartz', 'modelCount': 3, 'photoCount': 1,
                         'photos': ['data:image/png;base64,' + base64.b64encode(b'UNIT_ONLY_NOT_A_PHOTO').decode()],
                         'modelVersion': 'UNIT_ONLY_NO_RUNTIME', 'manifestSha256': 'a' * 64}, separators=(',', ':'))
    searches = json.dumps([{'kind': 'records', 'query': '石英'}], ensure_ascii=False, separators=(',', ':'))
    baseline = dict(identity(record, searches), source='real-ui-native-three-model-record', firstPhasePid=100,
                    origin='https://localhost')
    net = {'activeNetwork': None, 'connected': False, 'internetCapability': False, 'sdk': 24,
           'pageSize': 4096, 'packageName': 'com.shikuang.app.preview'}
    source = {'phase': 'passed', 'fullOfflineProductVerified': True, 'photoRecognitionVerified': True,
              'origin': 'https://localhost', 'historySnapshot': record, 'searchHistorySnapshot': searches,
              'coldProcessBaseline': baseline,
              'quartz': {'key': 'quartz', 'engine': 'onnx-native-android', 'modelCount': 3, 'manifestSha256': 'a' * 64},
              'uiCancelRetry': {'cancelled': True, 'photoRetained': True, 'retried': True},
              'history': {'recordId': baseline['recordId'], 'activityRecreatePreserved': True},
              'savedRecords': [{'id': baseline['recordId']}], 'recordsAfterRejection': [{'id': baseline['recordId']}],
              'networkAfterActivityRecreate': {'native': net}}
    raw_source = json.dumps(source, ensure_ascii=False).encode()
    expected = {'baseline': baseline, 'beforePid': 200, 'nonce': 'c' * 32, 'sourceReportSha256': sha(raw_source),
                'expectedSdk': 24, 'expectedPageSize': 4096}
    cold = {'schema': 'android-cold-process-ui-history-v1', 'phase': 'cold-process-history-passed', 'passed': True,
            'coldProcessUiReadVerified': True, 'nonce': expected['nonce'], 'sourceReportSha256': expected['sourceReportSha256'],
            'actualProcessPid': 300, 'hostBeforePid': 200, 'firstPhasePid': 100, 'actualIdentity': baseline,
            'afterUiIdentity': baseline, 'recordUnchanged': True, 'searchHistoryUnchanged': True,
            'photoDecodedInActualUi': True, 'displayedPhotoSha256': baseline['photoByteSha256s'][0],
            'networkBefore': net, 'networkAfter': net, 'navigatorOnlineBefore': False, 'navigatorOnlineAfter': False,
            'screenshots': [{'filename': 'cold-process-' + name + '.png', 'visualStateSynchronized': True}
                            for name in ('records', 'record-detail')]}
    cold_raw = json.dumps(cold).encode()
    receipts = []

    def receipt(label, args, output=b'', code=0, start=None):
        start = len(receipts) * 2 if start is None else start
        (folder / (label + '.stdout.bin')).write_bytes(output)
        (folder / (label + '.stderr.bin')).write_bytes(b'')
        receipts.append({'label': label, 'argv': ['adb', '-s', 'emulator-5554', *args], 'return_code': code,
                         'started_monotonic_seconds': start, 'finished_monotonic_seconds': start + 1,
                         'timed_out': False, 'stdout_sha256': sha(output), 'stderr_sha256': sha(b'')})

    receipt('pre-stop-real-ui-launch', ['shell', 'am', 'start', '-W', '-n',
                                      'com.shikuang.app.preview/com.shikuang.app.MainActivity'], b'Status: ok\n', start=0)
    receipt('before-force-stop-pid', ['shell', 'pidof', 'com.shikuang.app.preview'], b'200\n', start=1)
    receipt('actual-force-stop', ['shell', 'am', 'force-stop', 'com.shikuang.app.preview'], start=3)
    receipt('after-force-stop-pid-0', ['shell', 'pidof', 'com.shikuang.app.preview'], code=1, start=5)
    receipt('new-instrumentation-pid-0', ['shell', 'pidof', 'com.shikuang.app.preview'], b'300\n', start=8)
    boot = b'00000000-0000-0000-0000-000000000000'
    for label in ('before-boot-id', 'after-boot-id'):
        receipt(label, ['shell', 'cat', '/proc/sys/kernel/random/boot_id'], boot)
    for label in ('before-force-stop', 'after-force-stop-before-launch', 'after-cold-ui'):
        receipt(label + '-connectivity', ['shell', 'dumpsys', 'connectivity'], b'Active default network: none\n')
        receipt(label + '-ipv4', ['shell', 'ip', 'route', 'show', 'table', 'all'])
        receipt(label + '-ipv6', ['shell', 'ip', '-6', 'route', 'show', 'table', 'all'])
    bindings = {}
    for name, label, output in (
            ('cold-process-report.json', 'cold-native-report', cold_raw),
            ('cold-process-records.png', 'cold-process-records', b'\x89PNG\r\n\x1a\n' + b'UNIT_ONLY_NOT_A_SCREENSHOT' * 50),
            ('cold-process-record-detail.png', 'cold-process-record-detail', b'\x89PNG\r\n\x1a\n' + b'UNIT_ONLY_NOT_A_SCREENSHOT' * 51)):
        receipt(label, ['exec-out', 'content', 'read', '--uri',
                        'content://androidx.test.services.storage.outputfiles/' + name], output)
        (folder / name).write_bytes(output)
        bindings[name] = {'receiptLabel': label, 'bytes': len(output), 'sha256': sha(output)}
    stdout = (f'INSTRUMENTATION_STATUS: class={CLASS}\nINSTRUMENTATION_STATUS: test={METHOD}\n'
              'INSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS_CODE: 0\n'
              'OK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()
    (folder / 'cold-instrumentation.stdout.bin').write_bytes(stdout)
    (folder / 'cold-instrumentation.stderr.bin').write_bytes(b'')
    host = {'phase': 'host-cold-process-history-passed', 'passed': True, 'forceStopColdProcessVerified': True,
            'firstReportSha256': sha(raw_source), 'firstPhasePid': 100, 'beforeForceStopPid': 200, 'afterLaunchPid': 300,
            'absentPidReceipt': 'after-force-stop-pid-0', 'afterPidReceipt': 'new-instrumentation-pid-0', 'bootId': boot.decode(),
            'actualColdNativeReportSha256': sha(cold_raw), 'contentReadArtifacts': bindings,
            'instrumentation': {'argv': instrumentation_command('emulator-5554', expected), 'process_exited': True,
                                'return_code': 0, 'started_monotonic_seconds': 7,
                                'stdout_sha256': sha(stdout), 'stderr_sha256': sha(b'')}}
    (folder / 'command-receipts.json').write_text(json.dumps(receipts))
    (folder / 'expected-from-actual-first-report.json').write_text(json.dumps(expected))
    (folder / 'host-cold-process-report.json').write_text(json.dumps(host))
    return raw_source, host


class ColdRestartContractTests(unittest.TestCase):
    def test_final_gate_accepts_bound_UNIT_ONLY_copies_without_reading_photos(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); source, _ = UNIT_ONLY_artifact_bundle(folder)
            self.assertIs(verify_artifacts(folder, source, 24, 4096)['forceStopColdProcessVerified'], True)

    def test_final_gate_rejects_replaced_copies_even_with_updated_copy_hashes(self):
        for name in ('cold-process-records.png', 'cold-process-record-detail.png', 'cold-process-report.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
                original = (folder / name).read_bytes()
                replacement = (original + b'\n') if name.endswith('.json') else original[:-1] + b'!'
                (folder / name).write_bytes(replacement)
                # A producer accidentally rebinding the copy to itself must
                # still disagree with the immutable acquisition stdout.
                host['contentReadArtifacts'][name].update(bytes=len(replacement), sha256=sha(replacement))
                if name.endswith('.json'): host['actualColdNativeReportSha256'] = sha(replacement)
                (folder / 'host-cold-process-report.json').write_text(json.dumps(host))
                with self.assertRaisesRegex(ValueError, 'cold_content_read_copy_changed'):
                    verify_artifacts(folder, source, 24, 4096)

    def test_host_timeout_preserves_partial_bytes_and_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = Host('emulator-5554',Path(tmp))
            with patch('android_cold_restart.subprocess.run',side_effect=subprocess.TimeoutExpired(['UNIT_ONLY'],30,output=b'UNIT_ONLY partial stdout',stderr=b'UNIT_ONLY partial stderr')):
                with self.assertRaises(ValueError): host.command('unit-only-timeout',['shell','pidof','com.shikuang.app.preview'])
            self.assertEqual((Path(tmp)/'unit-only-timeout.stdout.bin').read_bytes(),b'UNIT_ONLY partial stdout')
            receipt = json.loads((Path(tmp)/'command-receipts.json').read_bytes())[0]
            self.assertIs(receipt['timed_out'],True); self.assertIsNone(receipt['return_code'])

    def test_UNIT_ONLY_first_metadata_shape_and_real_bytes(self):
        report = UNIT_ONLY_metadata()
        self.assertEqual(first_phase(json.dumps(report).encode(), 24, 4096), report['coldProcessBaseline'])

    def test_first_report_requires_real_complete_product_and_new_baseline(self):
        for key, value in [('phase', 'failed'), ('fullOfflineProductVerified', False), ('photoRecognitionVerified', False)]:
            report = UNIT_ONLY_metadata(); report[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): first_phase(json.dumps(report).encode(), 24, 4096)
        report = UNIT_ONLY_metadata(); report['history']['offlineRestartVerified'] = True
        with self.assertRaises(ValueError): first_phase(json.dumps(report).encode(), 24, 4096)

    def test_first_record_search_photo_or_SHA_change_is_rejected(self):
        for key, value in [('recordSnapshotSha256', '0' * 64), ('searchSnapshotSha256', '0' * 64), ('photoByteSha256s', ['0' * 64]), ('recordId', 'other')]:
            report = UNIT_ONLY_metadata(); report['coldProcessBaseline'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): first_phase(json.dumps(report).encode(), 24, 4096)

    def test_payload_uses_base64_argv_even_for_shell_metacharacters(self):
        report = UNIT_ONLY_metadata(); baseline = report['coldProcessBaseline']; baseline['recordId'] = "'; $(touch UNIT_ONLY); \" 中文"
        expected = {'baseline': baseline, 'beforePid': 200, 'nonce': 'c' * 32, 'sourceReportSha256': 'd' * 64}
        argv = instrumentation_command('emulator-5554', expected)
        encoded = argv[argv.index('coldProcessExpected') + 1]
        self.assertEqual(json.loads(base64.b64decode(encoded)), expected)
        self.assertNotIn(baseline['recordId'], ' '.join(argv))
        self.assertEqual(argv[-1], 'com.shikuang.app.preview.test/androidx.test.runner.AndroidJUnitRunner')

    def test_terminal_does_not_accept_host_zero_crash_wrong_case_or_skip(self):
        raw = (f'INSTRUMENTATION_STATUS: class={CLASS}\nINSTRUMENTATION_STATUS: test={METHOD}\n'
               'INSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS_CODE: 0\n'
               'OK (1 test)\nINSTRUMENTATION_CODE: -1\n').encode()
        terminal(raw, b'', 0)
        for bad in (raw.replace(b'OK (1 test)', b'OK (0 tests)'), raw + b'Process crashed\n', raw.replace(METHOD.encode(), b'otherMethod'), raw.replace(b'-1\n', b'0\n'), raw.replace(b'STATUS_CODE: 0', b'STATUS_CODE: -3')):
            with self.subTest(raw=bad), self.assertRaises(ValueError): terminal(bad, b'', 0)
        with self.assertRaises(ValueError): terminal(raw, b'error', 0)

    def test_original_three_cases_cannot_be_missing_or_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'JUnit.xml'
            names = ['offlinePackagedNativeRecognitionAndRecovery', 'legacyNativeAssetMigrationPreservesSpecimens', 'explicitlyMissingCapabilityRecoveryDoesNotReplaceProductAcceptance']
            body = ''.join(f'<testcase classname="com.shikuang.app.MineralEngineInstrumentedTest" name="{n}"/>' for n in names)
            p.write_text('<testsuite>' + body + '</testsuite>'); required_original_junit(tmp)
            p.write_text('<testsuite>' + body.replace('/>', '><skipped/></testcase>', 1) + '</testsuite>')
            with self.assertRaises(ValueError): required_original_junit(tmp)

    def test_cold_report_requires_nonce_different_PID_and_unchanged_bytes(self):
        baseline = UNIT_ONLY_metadata()['coldProcessBaseline']
        expected = {'baseline': baseline, 'beforePid': 200, 'nonce': 'c' * 32, 'sourceReportSha256': 'd' * 64, 'expectedSdk': 24, 'expectedPageSize': 4096}
        net = {'activeNetwork': None, 'connected': False, 'internetCapability': False, 'sdk': 24, 'pageSize': 4096, 'packageName': 'com.shikuang.app.preview'}
        report = {'schema': 'android-cold-process-ui-history-v1', 'phase': 'cold-process-history-passed', 'passed': True,
                  'coldProcessUiReadVerified': True, 'nonce': expected['nonce'], 'sourceReportSha256': expected['sourceReportSha256'],
                  'actualProcessPid': 300, 'hostBeforePid': 200, 'firstPhasePid': 100, 'actualIdentity': baseline,
                  'afterUiIdentity': baseline,
                  'recordUnchanged': True, 'searchHistoryUnchanged': True, 'photoDecodedInActualUi': True,
                  'displayedPhotoSha256': baseline['photoByteSha256s'][0], 'networkBefore': net, 'networkAfter': net,
                  'navigatorOnlineBefore': False, 'navigatorOnlineAfter': False,
                  'screenshots': [{'filename': f'cold-process-{name}.png', 'visualStateSynchronized': True} for name in ('records', 'record-detail')]}
        verify_cold(report, expected, 300)
        for key, value in [('nonce', 'e' * 32), ('actualProcessPid', 200), ('displayedPhotoSha256', '0' * 64), ('navigatorOnlineAfter', True), ('phase', 'failed')]:
            altered = copy.deepcopy(report); altered[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): verify_cold(altered, expected, 300)
        altered = copy.deepcopy(report); altered['afterUiIdentity']['searchSnapshotSha256'] = '0' * 64
        with self.assertRaises(ValueError): verify_cold(altered, expected, 300)


if __name__ == '__main__': unittest.main()

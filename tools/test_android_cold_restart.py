"""UNIT_ONLY metadata/terminal contracts, never Android or persistence evidence."""
import base64
import copy
import json
import tempfile
import unittest
import subprocess
from unittest.mock import patch
from pathlib import Path
from android_cold_restart import CLASS, METHOD, COLD_SCREENSHOTS, Host, first_phase, identity, instrumentation_command, required_original_junit, sha, terminal, verify_artifacts, verify_cold


def UNIT_ONLY_ui_geometry():
    """Synthetic geometry only. No browser, screenshot, device, or action is exercised."""
    def rect(left, top, width, height):
        return dict(left=left, top=top, right=left + width, bottom=top + height, width=width, height=height)

    def target(name, box):
        return dict(id=name, rect=box, enabled=True, visible=True, hitWithinTarget=True, hitButtonId=name,
                    center=dict(x=(box['left'] + box['right']) / 2, y=(box['top'] + box['bottom']) / 2))

    viewport = dict(width=412, height=660)
    initial = dict(schema='android-cold-record-dialog-geometry-v1', stage='initial', passed=True, dialogOpen=True,
                   viewport=viewport, dialog=dict(rect=rect(16, 50, 380, 560), scrollTop=0, scrollHeight=558, clientHeight=558),
                   body=dict(rect=rect(32, 140, 348, 450), scrollTop=0, scrollHeight=900, clientHeight=450),
                   close=target('closeRecord', rect(336, 66, 44, 44)), actions={})
    end = copy.deepcopy(initial); end.update(stage='end', scrollStart=0, animationFramesWaited=2)
    end['body']['scrollTop'] = 450
    end['actions'] = dict(save=target('updateRecord', rect(40, 530, 150, 44)),
                          delete=target('deleteRecord', rect(200, 530, 150, 44)))
    navigation = dict(passed=True, viewport=viewport, rect=rect(0, 596, 412, 64), columns=[])
    for i, (href, label) in enumerate(zip(('#identify', '#library', '#records', '#settings'), ('识别', '图鉴', '标本', '设置'))):
        navigation['columns'].append(dict(href=href, label=label, rect=rect(12 + i * 97, 605, 97, 47),
                                          labelRect=rect(50 + i * 97, 634, 20, 14)))
    shots = [{'filename': COLD_SCREENSHOTS[0], 'visualStateSynchronized': True}]
    for filename, geometry in ((COLD_SCREENSHOTS[1], initial), (COLD_SCREENSHOTS[2], end)):
        shots.append(dict(filename=filename, visualStateSynchronized=True, selector='#recordBody',
                          viewport=copy.deepcopy(viewport), rect={k: geometry['body']['rect'][k] for k in ('left', 'right', 'top', 'bottom')}))
    return dict(navigationLayout=navigation, recordDetailLayout=initial, recordDetailEnd=end, screenshots=shots)


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
            **UNIT_ONLY_ui_geometry()}
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
            ('cold-process-record-detail.png', 'cold-process-record-detail', b'\x89PNG\r\n\x1a\n' + b'UNIT_ONLY_NOT_A_SCREENSHOT' * 51),
            ('cold-process-record-detail-end.png', 'cold-process-record-detail-end', b'\x89PNG\r\n\x1a\n' + b'UNIT_ONLY_NOT_A_SCREENSHOT' * 52)):
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


def UNIT_ONLY_replace_bound_cold_report(folder, host, mutate):
    """Keep raw/copy hashes consistent to test geometry rejection, not copy corruption."""
    cold = json.loads((folder / 'cold-process-report.json').read_bytes()); mutate(cold)
    raw = json.dumps(cold).encode()
    (folder / 'cold-process-report.json').write_bytes(raw)
    (folder / 'cold-native-report.stdout.bin').write_bytes(raw)
    receipts = json.loads((folder / 'command-receipts.json').read_bytes())
    next(r for r in receipts if r['label'] == 'cold-native-report')['stdout_sha256'] = sha(raw)
    (folder / 'command-receipts.json').write_text(json.dumps(receipts))
    host['actualColdNativeReportSha256'] = sha(raw)
    host['contentReadArtifacts']['cold-process-report.json'].update(bytes=len(raw), sha256=sha(raw))
    (folder / 'host-cold-process-report.json').write_text(json.dumps(host))


class ColdRestartContractTests(unittest.TestCase):
    def test_final_gate_accepts_bound_UNIT_ONLY_copies_without_reading_photos(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); source, _ = UNIT_ONLY_artifact_bundle(folder)
            self.assertIs(verify_artifacts(folder, source, 24, 4096)['forceStopColdProcessVerified'], True)

    def test_final_gate_rejects_replaced_copies_even_with_updated_copy_hashes(self):
        for name in (*COLD_SCREENSHOTS, 'cold-process-report.json'):
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

    def test_final_gate_rejects_actual_API24_body_overflow_even_with_true_passed_and_consistent_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
            def overflow(cold):
                # Exact recorded API24 top/bottom/viewport from run39242587275.
                cold['recordDetailLayout']['body']['rect'].update(top=390, bottom=833.59375, height=443.59375)
            UNIT_ONLY_replace_bound_cold_report(folder, host, overflow)
            with self.assertRaisesRegex(ValueError, 'cold_detail_body_outside_viewport'):
                verify_artifacts(folder, source, 24, 4096)

    def test_final_gate_requires_end_screenshot_metadata_binding_and_original_bytes(self):
        cases = ('metadata', 'binding', 'original-stdout')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
                if case == 'metadata':
                    UNIT_ONLY_replace_bound_cold_report(folder, host, lambda c: c['screenshots'].pop())
                    reason = 'cold_drawn_UI_evidence_missing'
                elif case == 'binding':
                    del host['contentReadArtifacts'][COLD_SCREENSHOTS[2]]
                    (folder / 'host-cold-process-report.json').write_text(json.dumps(host))
                    reason = 'cold_content_read_bindings_missing'
                else:
                    (folder / 'cold-process-record-detail-end.stdout.bin').write_bytes(b'UNIT_ONLY_CORRUPTED')
                    reason = 'raw_host_receipt_hash'
                with self.assertRaisesRegex(ValueError, reason): verify_artifacts(folder, source, 24, 4096)

    def test_geometry_gate_recomputes_targets_scroll_and_navigation_despite_passed_true(self):
        mutations = [
            ('missing-layout', lambda c: c.update(recordDetailLayout=None), 'cold_detail_geometry_missing'),
            ('missing-end', lambda c: c.update(recordDetailEnd=None), 'cold_detail_geometry_missing'),
            ('false-layout', lambda c: c['recordDetailLayout'].update(passed=False), 'cold_detail_geometry_missing'),
            ('false-end', lambda c: c['recordDetailEnd'].update(passed=False), 'cold_detail_geometry_missing'),
            ('dialog-offscreen', lambda c: c['recordDetailLayout']['dialog']['rect'].update(top=-100, bottom=460), 'cold_detail_dialog_outside_viewport'),
            ('end-body-offscreen', lambda c: c['recordDetailEnd']['body']['rect'].update(top=390, bottom=840), 'cold_detail_body_outside_viewport'),
            ('close-disabled', lambda c: c['recordDetailLayout']['close'].update(enabled=False), 'cold_detail_control_unreachable'),
            ('close-covered', lambda c: c['recordDetailEnd']['close'].update(hitWithinTarget=False), 'cold_detail_control_unreachable'),
            ('close-too-small', lambda c: c['recordDetailLayout']['close']['rect'].update(right=379, width=43), 'cold_detail_small_target'),
            ('save-disabled', lambda c: c['recordDetailEnd']['actions']['save'].update(enabled=False), 'cold_detail_control_unreachable'),
            ('delete-covered', lambda c: c['recordDetailEnd']['actions']['delete'].update(hitWithinTarget=False), 'cold_detail_control_unreachable'),
            ('save-invisible', lambda c: c['recordDetailEnd']['actions']['save'].update(visible=False), 'cold_detail_control_unreachable'),
            ('wrong-hit-button', lambda c: c['recordDetailEnd']['actions']['save'].update(hitButtonId='closeRecord'), 'cold_detail_control_unreachable'),
            ('offscreen-save', lambda c: c['recordDetailEnd']['actions']['save']['rect'].update(top=670, bottom=714), 'cold_detail_control_outside_viewport'),
            ('wrong-center', lambda c: c['recordDetailEnd']['actions']['save']['center'].update(y=1), 'cold_detail_control_center'),
            ('not-at-end', lambda c: c['recordDetailEnd']['body'].update(scrollTop=30), 'cold_detail_end_not_reached'),
            ('no-real-frames', lambda c: c['recordDetailEnd'].update(animationFramesWaited=0), 'cold_detail_actual_frames_or_start_missing'),
            ('wrong-scroll-start', lambda c: c['recordDetailEnd'].update(scrollStart=10), 'cold_detail_actual_frames_or_start_missing'),
            ('nonfinite-rect', lambda c: c['recordDetailLayout']['body']['rect'].update(top=float('nan')), 'cold_detail_body_rect'),
            ('boolean-scroll', lambda c: c['recordDetailEnd']['body'].update(scrollTop=True), 'cold_detail_scroll_metrics'),
            ('fake-nav-pass', lambda c: c['navigationLayout']['rect'].update(width=80, right=80), 'cold_navigation_width_placement'),
            ('false-nav', lambda c: c['navigationLayout'].update(passed=False), 'cold_navigation_missing'),
            ('wrong-nav-label', lambda c: c['navigationLayout']['columns'][0].update(label='other'), 'cold_navigation_labels'),
            ('snapshot-mismatch', lambda c: c['screenshots'][2]['rect'].update(bottom=500), 'cold_detail_screenshot_geometry_changed'),
        ]
        for case, mutate, reason in mutations:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
                UNIT_ONLY_replace_bound_cold_report(folder, host, mutate)
                with self.assertRaisesRegex(ValueError, reason): verify_artifacts(folder, source, 24, 4096)

    def test_overflow_must_actually_advance_but_nonoverflow_need_not_scroll(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
            def already_at_end(c):
                c['recordDetailLayout']['body']['scrollTop'] = 450
                c['recordDetailEnd']['scrollStart'] = 450
            UNIT_ONLY_replace_bound_cold_report(folder, host, already_at_end)
            with self.assertRaisesRegex(ValueError, 'cold_detail_scroll_not_advanced'): verify_artifacts(folder, source, 24, 4096)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); source, host = UNIT_ONLY_artifact_bundle(folder)
            def no_overflow(c):
                for field in ('recordDetailLayout', 'recordDetailEnd'):
                    c[field]['body'].update(scrollHeight=450, clientHeight=450, scrollTop=0)
            UNIT_ONLY_replace_bound_cold_report(folder, host, no_overflow)
            self.assertTrue(verify_artifacts(folder, source, 24, 4096)['forceStopColdProcessVerified'])

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
                  **UNIT_ONLY_ui_geometry()}
        verify_cold(report, expected, 300)
        for key, value in [('nonce', 'e' * 32), ('actualProcessPid', 200), ('displayedPhotoSha256', '0' * 64), ('navigatorOnlineAfter', True), ('phase', 'failed')]:
            altered = copy.deepcopy(report); altered[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): verify_cold(altered, expected, 300)
        altered = copy.deepcopy(report); altered['afterUiIdentity']['searchSnapshotSha256'] = '0' * 64
        with self.assertRaises(ValueError): verify_cold(altered, expected, 300)


if __name__ == '__main__': unittest.main()

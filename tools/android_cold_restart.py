#!/usr/bin/env python3
"""Existing actual UI report -> host force-stop -> new instrumented UI read.

No package-data clear, data seed, image replay, build, or CI dispatch occurs here.
"""
import argparse
import base64
import hashlib
import json
import math
import re
import secrets
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PACKAGE = 'com.shikuang.app.preview'
CLASS = 'com.shikuang.app.ColdProcessHistoryInstrumentedTest'
METHOD = 'existingUiRecordAfterHostForceStop'
PHASE = 'verify-existing-after-force-stop'
IDENTITY_KEYS = ('recordId', 'recordSnapshotSha256', 'searchSnapshotSha256', 'photoDataUrlSha256s',
                 'photoByteSha256s', 'photoCount', 'modelCount', 'modelVersion', 'manifestSha256')
COLD_SCREENSHOTS = ('cold-process-records.png', 'cold-process-record-detail.png',
                    'cold-process-record-detail-end.png')


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(record_json, search_json):
    need(isinstance(record_json, str) and len(record_json.encode()) <= 2 * 1024 * 1024, 'record_snapshot_bound')
    need(isinstance(search_json, str) and len(search_json.encode()) <= 128 * 1024, 'search_snapshot_bound')
    row, searches = json.loads(record_json), json.loads(search_json)
    need(row['key'] == 'quartz' and row['modelCount'] == 3 and row['photoCount'] == 1 and len(row['photos']) == 1, 'real_three_model_record_required')
    need(isinstance(row['id'], str) and 0 < len(row['id']) <= 256, 'record_id_bound')
    need(any(s.get('kind') == 'records' and s.get('query') == '石英' for s in searches), 'actual_search_missing')
    need(re.fullmatch('[a-f0-9]{64}', row['manifestSha256']) is not None, 'record_manifest_hash')
    urls, photos = [], []
    for url in row['photos']:
        need(isinstance(url, str) and re.fullmatch(r'data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}', url) is not None, 'actual_photo_data_url')
        raw = base64.b64decode(url.split(',', 1)[1], validate=True)
        need(0 < len(raw) <= 2 * 1024 * 1024, 'actual_photo_bound')
        urls.append(sha(url.encode())); photos.append(sha(raw))
    return {'recordId': row['id'], 'recordSnapshotSha256': sha(record_json.encode()),
            'searchSnapshotSha256': sha(search_json.encode()), 'photoDataUrlSha256s': urls,
            'photoByteSha256s': photos, 'photoCount': 1, 'modelCount': 3,
            'modelVersion': row['modelVersion'], 'manifestSha256': row['manifestSha256']}


def offline_native(network):
    need(network.get('activeNetwork') is None and network.get('connected') is False
         and network.get('internetCapability') is False, 'native_network_not_offline')


def first_phase(raw, sdk, page):
    need(0 < len(raw) <= 2 * 1024 * 1024, 'first_report_bound')
    report = json.loads(raw)
    need(report['phase'] == 'passed' and report['fullOfflineProductVerified'] is True
         and report['photoRecognitionVerified'] is True, 'first_actual_product_not_passed')
    need(report['quartz']['key'] == 'quartz' and report['quartz']['engine'] == 'onnx-native-android'
         and report['quartz']['modelCount'] == 3, 'first_native_three_model_result_missing')
    need(report['uiCancelRetry'] == {'cancelled': True, 'photoRetained': True, 'retried': True}, 'first_ui_cancel_retry_missing')
    history = report['history']
    need(history.get('activityRecreatePreserved') is True and 'offlineRestartVerified' not in history, 'activity_recreate_not_cold_restart')
    expected = identity(report['historySnapshot'], report['searchHistorySnapshot'])
    baseline = report['coldProcessBaseline']
    need(all(baseline.get(k) == expected[k] for k in IDENTITY_KEYS), 'baseline_does_not_match_actual_record_bytes')
    need(baseline.get('source') == 'real-ui-native-three-model-record' and type(baseline.get('firstPhasePid')) is int
         and baseline['firstPhasePid'] > 0, 'first_actual_process_identity_missing')
    need(baseline['origin'] == report['origin'] == 'https://localhost', 'stable_packaged_origin_required')
    need(history['recordId'] == report['savedRecords'][0]['id'] == report['recordsAfterRejection'][0]['id'] == expected['recordId'], 'first_record_identity_mismatch')
    need(expected['manifestSha256'] == report['quartz']['manifestSha256'], 'first_record_model_identity_changed')
    network = report['networkAfterActivityRecreate']['native']; offline_native(network)
    need(network['sdk'] == sdk and network['pageSize'] == page and network['packageName'] == PACKAGE, 'first_actual_platform_mismatch')
    return baseline


def required_original_junit(folder):
    needed = {'offlinePackagedNativeRecognitionAndRecovery', 'legacyNativeAssetMigrationPreservesSpecimens',
              'explicitlyMissingCapabilityRecoveryDoesNotReplaceProductAcceptance'}
    cases = [case for path in Path(folder).rglob('*.xml') for case in ET.parse(path).getroot().iter('testcase')
             if case.get('classname') == 'com.shikuang.app.MineralEngineInstrumentedTest']
    need(needed <= {c.get('name') for c in cases}, 'original_three_junit_cases_missing')
    need(all(c.find('failure') is None and c.find('error') is None and c.find('skipped') is None for c in cases), 'original_junit_failed_or_skipped')


def terminal(raw, stderr, return_code):
    need(return_code == 0 and stderr == b'', 'cold_instrumentation_host_exit')
    need(len(re.findall(rb'(?m)^OK \(1 test\)\s*$', raw)) == 1, 'cold_single_junit_OK_missing')
    need(re.findall(rb'(?m)^INSTRUMENTATION_CODE: (-?[0-9]+)\s*$', raw) == [b'-1'], 'cold_instrumentation_result_code')
    need(re.findall(rb'(?m)^INSTRUMENTATION_STATUS_CODE: (-?[0-9]+)\s*$', raw) == [b'1', b'0'], 'cold_single_JUnit_start_and_success_required')
    need(not any(x in raw for x in (b'FAILURES!!!', b'INSTRUMENTATION_FAILED', b'Process crashed', b'INSTRUMENTATION_ABORTED', b'shortMsg=')), 'cold_instrumentation_failed')
    classes = re.findall(rb'(?m)^INSTRUMENTATION_STATUS: class=(.+)\r?$', raw)
    tests = re.findall(rb'(?m)^INSTRUMENTATION_STATUS: test=(.+)\r?$', raw)
    need(classes and all(x.rstrip(b'\r') == CLASS.encode() for x in classes), 'cold_wrong_test_class')
    need(tests and all(x.rstrip(b'\r') == METHOD.encode() for x in tests), 'cold_wrong_test_method')


def instrumentation_command(serial, expected):
    need(re.fullmatch(r'emulator-[0-9]+', serial) is not None, 'explicit_test_emulator_required')
    need(type(expected['beforePid']) is int and expected['beforePid'] > 0
         and re.fullmatch(r'[a-f0-9]{32}', expected['nonce']) is not None
         and re.fullmatch(r'[a-f0-9]{64}', expected['sourceReportSha256']) is not None, 'cold_expected_identity')
    encoded = base64.b64encode(json.dumps(expected, ensure_ascii=False, separators=(',', ':')).encode()).decode()
    need(len(encoded) <= 16384 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', encoded) is not None, 'bounded_shell_safe_base64_required')
    return ['adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
            '-e', 'useTestStorageService', 'true', '-e', 'class', CLASS + '#' + METHOD,
            '-e', 'coldProcessPhase', PHASE, '-e', 'coldProcessExpected', encoded,
            PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner']


def finite_number(value, reason):
    need(type(value) in (int, float) and math.isfinite(value), reason)
    return value


def geometry_rect(rect, reason):
    need(isinstance(rect, dict), reason)
    values = {k: finite_number(rect.get(k), reason) for k in ('left', 'right', 'top', 'bottom', 'width', 'height')}
    need(values['width'] > 0 and values['height'] > 0
         and abs(values['right'] - values['left'] - values['width']) <= 0.1
         and abs(values['bottom'] - values['top'] - values['height']) <= 0.1, reason)
    return values


def inside_rect(rect, container, reason):
    need(rect['left'] >= container['left'] - 2 and rect['right'] <= container['right'] + 2
         and rect['top'] >= container['top'] - 2 and rect['bottom'] <= container['bottom'] + 2, reason)


def viewport_rect(viewport, reason):
    need(isinstance(viewport, dict), reason)
    width = finite_number(viewport.get('width'), reason); height = finite_number(viewport.get('height'), reason)
    return geometry_rect({'left': 0, 'top': 0, 'right': width, 'bottom': height, 'width': width, 'height': height}, reason)


def verify_navigation(layout):
    need(isinstance(layout, dict) and layout.get('passed') is True, 'cold_navigation_missing')
    viewport = viewport_rect(layout.get('viewport'), 'cold_navigation_viewport')
    rect = geometry_rect(layout.get('rect'), 'cold_navigation_rect'); columns = layout.get('columns')
    expected = min(viewport['width'], 1120)
    need(abs(rect['width'] - expected) <= 2 and abs(rect['left'] - (viewport['width'] - expected) / 2) <= 2,
         'cold_navigation_width_placement')
    inside_rect(rect, viewport, 'cold_navigation_outside_viewport')
    need(isinstance(columns, list) and len(columns) == 4, 'cold_navigation_columns')
    widths, previous = [], None
    for column, href, label in zip(columns, ('#identify', '#library', '#records', '#settings'), ('识别', '图鉴', '标本', '设置')):
        need(isinstance(column, dict) and column.get('href') == href and column.get('label') == label, 'cold_navigation_labels')
        target = geometry_rect(column.get('rect'), 'cold_navigation_target')
        text = geometry_rect(column.get('labelRect'), 'cold_navigation_label_rect')
        need(target['width'] >= 44 and target['height'] >= 44, 'cold_navigation_small_target')
        inside_rect(target, rect, 'cold_navigation_target_clipped'); inside_rect(text, target, 'cold_navigation_label_clipped')
        need(previous is None or target['left'] >= previous['right'] - 1, 'cold_navigation_overlap')
        widths.append(target['width']); previous = target
    need(max(widths) - min(widths) <= 2, 'cold_navigation_unequal_columns')


def verify_detail_control(control, target_id, viewport, clip):
    need(isinstance(control, dict) and control.get('id') == target_id, 'cold_detail_control_identity')
    rect = geometry_rect(control.get('rect'), 'cold_detail_control_rect')
    inside_rect(rect, viewport, 'cold_detail_control_outside_viewport')
    inside_rect(rect, clip, 'cold_detail_control_clipped')
    need(rect['width'] >= 44 and rect['height'] >= 44, 'cold_detail_small_target')
    need(control.get('enabled') is True and control.get('visible') is True and control.get('hitWithinTarget') is True
         and control.get('hitButtonId') == target_id, 'cold_detail_control_unreachable')
    center = control.get('center'); need(isinstance(center, dict), 'cold_detail_control_center')
    need(abs(finite_number(center.get('x'), 'cold_detail_control_center') - (rect['left'] + rect['right']) / 2) <= 0.1
         and abs(finite_number(center.get('y'), 'cold_detail_control_center') - (rect['top'] + rect['bottom']) / 2) <= 0.1,
         'cold_detail_control_center')


def verify_detail_geometry(geometry, stage):
    need(isinstance(geometry, dict) and geometry.get('schema') == 'android-cold-record-dialog-geometry-v1'
         and geometry.get('stage') == stage and geometry.get('passed') is True and geometry.get('dialogOpen') is True,
         'cold_detail_geometry_missing')
    viewport = viewport_rect(geometry.get('viewport'), 'cold_detail_viewport'); boxes = {}
    for name in ('dialog', 'body'):
        box = geometry.get(name); need(isinstance(box, dict), 'cold_detail_' + name + '_missing')
        rect = geometry_rect(box.get('rect'), 'cold_detail_' + name + '_rect')
        inside_rect(rect, viewport, 'cold_detail_' + name + '_outside_viewport')
        top, height, client = [finite_number(box.get(k), 'cold_detail_scroll_metrics') for k in ('scrollTop', 'scrollHeight', 'clientHeight')]
        # Preserve raw metrics; old WebView integer rounding may differ by <=2 CSS px.
        need(client > 0 and client <= rect['height'] + 2 and height >= client - 2 and 0 <= top <= max(0, height - client) + 2,
             'cold_detail_scroll_metrics')
        boxes[name] = rect
    inside_rect(boxes['body'], boxes['dialog'], 'cold_detail_body_outside_dialog')
    verify_detail_control(geometry.get('close'), 'closeRecord', viewport, boxes['dialog'])
    if stage == 'end':
        actions = geometry.get('actions'); need(isinstance(actions, dict), 'cold_detail_actions_missing')
        verify_detail_control(actions.get('save'), 'updateRecord', viewport, boxes['body'])
        verify_detail_control(actions.get('delete'), 'deleteRecord', viewport, boxes['body'])


def verify_detail_end(initial, end):
    verify_detail_geometry(initial, 'initial'); verify_detail_geometry(end, 'end')
    need(initial['viewport'] == end['viewport'], 'cold_detail_viewport_changed')
    before, after = initial['body'], end['body']
    start = finite_number(end.get('scrollStart'), 'cold_detail_scroll_start')
    need(abs(start - before['scrollTop']) <= 0.1 and type(end.get('animationFramesWaited')) is int
         and end['animationFramesWaited'] >= 2, 'cold_detail_actual_frames_or_start_missing')
    need(abs(before['scrollHeight'] - after['scrollHeight']) <= 1 and abs(before['clientHeight'] - after['clientHeight']) <= 1,
         'cold_detail_scroll_dimensions_changed')
    maximum = after['scrollHeight'] - after['clientHeight']
    need(abs(after['scrollTop'] - maximum) <= 2, 'cold_detail_end_not_reached')
    need(maximum <= 2 or after['scrollTop'] > start + 1, 'cold_detail_scroll_not_advanced')


def verify_cold(report, expected, after_pid):
    need(report.get('schema') == 'android-cold-process-ui-history-v1' and report.get('phase') == 'cold-process-history-passed'
         and report.get('passed') is True and report.get('coldProcessUiReadVerified') is True, 'cold_actual_UI_not_passed')
    need(report.get('nonce') == expected['nonce'] and report.get('sourceReportSha256') == expected['sourceReportSha256'], 'cold_stale_or_wrong_source_report')
    need(type(report.get('actualProcessPid')) is int and report['actualProcessPid'] == after_pid
         and after_pid != expected['beforePid'] and report.get('hostBeforePid') == expected['beforePid'], 'cold_actual_PID_mismatch')
    need(report.get('firstPhasePid') == expected['baseline']['firstPhasePid'], 'first_phase_PID_replaced')
    need(all(report['actualIdentity'].get(k) == expected['baseline'][k] for k in IDENTITY_KEYS), 'cold_record_photo_search_changed')
    need(all(report['afterUiIdentity'].get(k) == expected['baseline'][k] for k in IDENTITY_KEYS), 'cold_UI_mutated_record_photo_search')
    need(report.get('recordUnchanged') is True and report.get('searchHistoryUnchanged') is True
         and report.get('photoDecodedInActualUi') is True, 'cold_history_UI_missing')
    need(report.get('displayedPhotoSha256') == expected['baseline']['photoByteSha256s'][0], 'cold_displayed_photo_changed')
    for key in ('networkBefore', 'networkAfter'):
        network = report[key]; offline_native(network)
        need(network['sdk'] == expected['expectedSdk'] and network['pageSize'] == expected['expectedPageSize']
             and network['packageName'] == PACKAGE, 'cold_platform_changed')
    need(report.get('navigatorOnlineBefore') is False and report.get('navigatorOnlineAfter') is False, 'cold_WebView_not_offline')
    shots = report['screenshots']
    need(len(shots) == 3 and {s['filename'] for s in shots} == set(COLD_SCREENSHOTS)
         and all(s.get('visualStateSynchronized') is True for s in shots), 'cold_drawn_UI_evidence_missing')
    verify_navigation(report.get('navigationLayout'))
    verify_detail_end(report.get('recordDetailLayout'), report.get('recordDetailEnd'))
    for filename, geometry in ((COLD_SCREENSHOTS[1], report['recordDetailLayout']),
                               (COLD_SCREENSHOTS[2], report['recordDetailEnd'])):
        shot = next(s for s in shots if s['filename'] == filename)
        need(shot.get('selector') == '#recordBody' and shot.get('viewport') == geometry['viewport'],
             'cold_detail_screenshot_geometry_changed')
        rect = shot.get('rect'); need(isinstance(rect, dict), 'cold_detail_screenshot_geometry_changed')
        need(all(abs(finite_number(rect.get(k), 'cold_detail_screenshot_geometry_changed') - geometry['body']['rect'][k]) <= 0.1
                 for k in ('left', 'right', 'top', 'bottom')), 'cold_detail_screenshot_geometry_changed')


def verify_artifacts(folder, source_raw, sdk, page):
    """Shared final gate over actual raw receipts, not just reported booleans."""
    folder = Path(folder); baseline = first_phase(source_raw, sdk, page)
    host = json.loads((folder / 'host-cold-process-report.json').read_bytes())
    expected = json.loads((folder / 'expected-from-actual-first-report.json').read_bytes())
    need(host.get('phase') == 'host-cold-process-history-passed' and host.get('passed') is True
         and host.get('forceStopColdProcessVerified') is True, 'host_cold_phase_not_passed')
    need(expected['baseline'] == baseline and expected['sourceReportSha256'] == host['firstReportSha256'] == sha(source_raw), 'wrong_first_phase_source')
    need(expected['expectedSdk'] == sdk and expected['expectedPageSize'] == page, 'wrong_expected_platform')
    need(host['beforeForceStopPid'] == expected['beforePid'] and host['firstPhasePid'] == baseline['firstPhasePid'], 'wrong_before_PID_binding')
    need(host['instrumentation']['process_exited'] is True, 'instrumentation_not_reaped')
    terminal((folder / 'cold-instrumentation.stdout.bin').read_bytes(), (folder / 'cold-instrumentation.stderr.bin').read_bytes(), host['instrumentation']['return_code'])
    for stream in ('stdout', 'stderr'):
        need(sha((folder / ('cold-instrumentation.' + stream + '.bin')).read_bytes()) == host['instrumentation'][stream + '_sha256'], 'raw_instrumentation_receipt_hash')
    receipts = json.loads((folder / 'command-receipts.json').read_bytes()); by_label = {r['label']: r for r in receipts}
    need(len(by_label) == len(receipts), 'duplicate_host_receipt')
    for r in receipts:
        need(re.fullmatch(r'[a-z0-9-]+', r['label']) is not None, 'host_receipt_label')
        need(r.get('timed_out') is False and r['finished_monotonic_seconds'] >= r['started_monotonic_seconds'], 'host_receipt_timeout_or_time')
        for stream in ('stdout', 'stderr'):
            need(sha((folder / (r['label'] + '.' + stream + '.bin')).read_bytes()) == r[stream + '_sha256'], 'raw_host_receipt_hash')
        need((folder / (r['label'] + '.stderr.bin')).read_bytes() == b'', 'host_receipt_stderr_not_empty')
        output = (folder / (r['label'] + '.stdout.bin')).read_bytes().strip()
        need(r['return_code'] == 0 or (r['return_code'] == 1 and output == b'' and r['argv'][-3:] == ['shell', 'pidof', PACKAGE]), 'host_receipt_failed')
    need(host['instrumentation']['argv'] == instrumentation_command(host['instrumentation']['argv'][2], expected), 'wrong_cold_instrumentation_arguments')
    stopped = by_label['actual-force-stop']
    need(stopped['return_code'] == 0 and stopped['argv'][-4:] == ['shell', 'am', 'force-stop', PACKAGE], 'actual_force_stop_command_missing')
    need((folder / 'before-force-stop-pid.stdout.bin').read_bytes().strip() == str(expected['beforePid']).encode(), 'before_PID_receipt')
    need(re.fullmatch(r'after-force-stop-pid-[0-9]+', host['absentPidReceipt']) is not None
         and (folder / (host['absentPidReceipt'] + '.stdout.bin')).read_bytes().strip() == b''
         and by_label[host['absentPidReceipt']]['return_code'] in (0, 1), 'absent_PID_receipt')
    need(re.fullmatch(r'new-instrumentation-pid-[0-9]+', host['afterPidReceipt']) is not None
         and (folder / (host['afterPidReceipt'] + '.stdout.bin')).read_bytes().strip() == str(host['afterLaunchPid']).encode(), 'new_PID_receipt')
    need(by_label['before-force-stop-pid']['finished_monotonic_seconds'] <= stopped['started_monotonic_seconds']
         <= stopped['finished_monotonic_seconds'] <= by_label[host['absentPidReceipt']]['started_monotonic_seconds']
         <= by_label[host['absentPidReceipt']]['finished_monotonic_seconds'] <= host['instrumentation']['started_monotonic_seconds']
         <= by_label[host['afterPidReceipt']]['started_monotonic_seconds'], 'host_force_stop_order')
    boot_before = (folder / 'before-boot-id.stdout.bin').read_bytes().strip()
    need(boot_before == (folder / 'after-boot-id.stdout.bin').read_bytes().strip() == host['bootId'].encode(), 'same_actual_boot_required')
    for label in ('before-force-stop', 'after-force-stop-before-launch', 'after-cold-ui'):
        need(b'Active default network: none' in (folder / (label + '-connectivity.stdout.bin')).read_bytes(), 'host_network_reconnected')
        for version in ('ipv4', 'ipv6'):
            need(not re.search(rb'(?m)^\s*default\s', (folder / (label + '-' + version + '.stdout.bin')).read_bytes()), 'host_default_route_returned')
    cold_raw = (folder / 'cold-process-report.json').read_bytes()
    need(sha(cold_raw) == host['actualColdNativeReportSha256'], 'actual_cold_report_hash')
    verify_cold(json.loads(cold_raw), expected, host['afterLaunchPid'])
    # The provider's original stdout is the acquisition receipt. Bind each
    # convenience copy to those same bytes so a stale/replaced PNG or JSON
    # cannot satisfy the final gate while the original read says otherwise.
    artifact_labels = {'cold-process-report.json': 'cold-native-report',
                       'cold-process-records.png': 'cold-process-records',
                       'cold-process-record-detail.png': 'cold-process-record-detail',
                       'cold-process-record-detail-end.png': 'cold-process-record-detail-end'}
    bindings = host['contentReadArtifacts']
    need(set(bindings) == set(artifact_labels), 'cold_content_read_bindings_missing')
    serial = host['instrumentation']['argv'][2]
    for name, label in artifact_labels.items():
        receipt = by_label[label]
        need(receipt['argv'] == ['adb', '-s', serial, 'exec-out', 'content', 'read', '--uri',
                                'content://androidx.test.services.storage.outputfiles/' + name],
             'wrong_cold_content_read_command')
        original = (folder / (label + '.stdout.bin')).read_bytes()
        copy = (folder / name).read_bytes(); binding = bindings[name]
        need(binding == {'receiptLabel': label, 'bytes': len(original), 'sha256': sha(original)}
             and copy == original, 'cold_content_read_copy_changed')
    for name in COLD_SCREENSHOTS:
        image = (folder / name).read_bytes(); need(image.startswith(b'\x89PNG\r\n\x1a\n') and 1024 < len(image) <= 16 * 1024 * 1024, 'cold_PNG_missing')
    return {'forceStopColdProcessVerified': True, 'sourceReportSha256': sha(source_raw),
            'firstPhasePid': baseline['firstPhasePid'], 'beforePid': expected['beforePid'],
            'afterPid': host['afterLaunchPid'], 'physicalDeviceClaim': False}


class Host:
    def __init__(self, serial, out):
        self.serial, self.out, self.receipts = serial, out, []

    def command(self, label, args, allow_absent=False):
        argv = ['adb', '-s', self.serial, *args]
        started = time.monotonic()
        try:
            result = subprocess.run(argv, capture_output=True, timeout=30)
            stdout, stderr, code, timed_out = result.stdout, result.stderr, result.returncode, False
        except subprocess.TimeoutExpired as error:
            stdout, stderr, code, timed_out = error.stdout or b'', error.stderr or b'', None, True
        (self.out / (label + '.stdout.bin')).write_bytes(stdout)
        (self.out / (label + '.stderr.bin')).write_bytes(stderr)
        self.receipts.append({'label': label, 'argv': argv, 'return_code': code,
                              'started_monotonic_seconds': started, 'finished_monotonic_seconds': time.monotonic(),
                              'timed_out': timed_out, 'stdout_sha256': sha(stdout), 'stderr_sha256': sha(stderr)})
        (self.out / 'command-receipts.json').write_text(json.dumps(self.receipts, indent=2) + '\n')
        need(not timed_out and code in ((0, 1) if allow_absent else (0,)) and stderr == b'', label + '_command_failed')
        return stdout

    def pid(self, label):
        raw = self.command(label, ['shell', 'pidof', PACKAGE], allow_absent=True).strip()
        need(raw == b'' or re.fullmatch(rb'[1-9][0-9]*', raw) is not None, 'ambiguous_or_invalid_PID')
        need(not raw or self.receipts[-1]['return_code'] == 0, 'nonzero_PID_query_with_output')
        return int(raw) if raw else None

    def network(self, label):
        state = self.command(label + '-connectivity', ['shell', 'dumpsys', 'connectivity'])
        need(b'Active default network: none' in state, label + '_active_network')
        for name, args in [('ipv4', ['shell', 'ip', 'route', 'show', 'table', 'all']),
                           ('ipv6', ['shell', 'ip', '-6', 'route', 'show', 'table', 'all'])]:
            routes = self.command(label + '-' + name, args)
            need(not re.search(rb'(?m)^\s*default\s', routes), label + '_default_route')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--expected-sdk', type=int, choices=(24, 30, 35), required=True)
    parser.add_argument('--expected-page-size', type=int, choices=(4096, 16384), required=True)
    parser.add_argument('--first-report-root', type=Path, required=True); parser.add_argument('--junit-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True); args = parser.parse_args()
    need(re.fullmatch(r'emulator-[0-9]+', args.serial) is not None, 'explicit_test_emulator_required')
    args.out.mkdir(parents=True, exist_ok=False); host = Host(args.serial, args.out)
    result = {'schema': 'android-host-cold-process-history-v1', 'phase': 'host-cold-process-started', 'passed': False}
    process = None
    try:
        paths = [p for p in args.first_report_root.rglob('runtime-report.json') if p.is_file() and not p.is_symlink()]
        need(len(paths) == 1, 'one_actual_UTP_first_report_required')
        raw = paths[0].read_bytes(); baseline = first_phase(raw, args.expected_sdk, args.expected_page_size)
        required_original_junit(args.junit_root); (args.out / 'first-phase-runtime-report.json').write_bytes(raw)
        boot = host.command('before-boot-id', ['shell', 'cat', '/proc/sys/kernel/random/boot_id']).strip()
        need(re.fullmatch(rb'[a-f0-9-]{36}', boot) is not None, 'actual_boot_identity_missing')
        for name, package in (('test-apk', PACKAGE + '.test'), ('test-storage-service', 'androidx.test.services')):
            installed = host.command(name + '-installed', ['shell', 'pm', 'path', package])
            need(re.fullmatch(rb'(?:package:/[^\r\n]+\.apk\r?\n?)+', installed) is not None, name + '_must_remain_installed')
        host.network('before-force-stop')
        # Gradle can already have ended its instrumentation process. Bring the
        # actual existing App UI up; this never seeds records or clears data.
        launch = host.command('pre-stop-real-ui-launch', ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/com.shikuang.app.MainActivity'])
        need(re.search(rb'(?m)^Status: ok\r?$', launch) is not None, 'pre_stop_real_UI_launch_failed')
        before = host.pid('before-force-stop-pid'); need(before is not None, 'pre_stop_App_process_missing')
        result.update(firstPhasePid=baseline['firstPhasePid'], beforeForceStopPid=before, bootId=boot.decode(), firstReportSha256=sha(raw))
        host.command('actual-force-stop', ['shell', 'am', 'force-stop', PACKAGE])
        absent = False
        for index in range(30):
            label = f'after-force-stop-pid-{index}'
            if host.pid(label) is None:
                absent = True; result['absentPidReceipt'] = label; break
            time.sleep(0.1)
        need(absent, 'force_stop_did_not_remove_App_PID'); result['forceStopPidAbsentVerified'] = True
        host.network('after-force-stop-before-launch')
        expected = {'baseline': baseline, 'beforePid': before, 'expectedSdk': args.expected_sdk,
                    'expectedPageSize': args.expected_page_size, 'sourceReportSha256': sha(raw), 'nonce': secrets.token_hex(16)}
        (args.out / 'expected-from-actual-first-report.json').write_text(json.dumps(expected, ensure_ascii=False, indent=2) + '\n')
        argv = instrumentation_command(args.serial, expected)
        result['instrumentation'] = {'argv': argv, 'process_exited': False, 'return_code': None}
        with (args.out / 'cold-instrumentation.stdout.bin').open('wb') as stdout, (args.out / 'cold-instrumentation.stderr.bin').open('wb') as stderr:
            started = time.monotonic(); process = subprocess.Popen(argv, stdout=stdout, stderr=stderr)
            result['instrumentation'].update(started_monotonic_seconds=started, host_adb_pid=process.pid)
            after = None
            while time.monotonic() - started < 30 and process.poll() is None:
                label = 'new-instrumentation-pid-' + str(len(host.receipts)); after = host.pid(label)
                if after is not None: result['afterPidReceipt'] = label; break
                time.sleep(0.1)
            need(after is not None and after != before, 'new_App_PID_not_observed')
            code = process.wait(timeout=max(1, 180 - (time.monotonic() - started)))
        result['instrumentation'].update(return_code=code, elapsed_seconds=time.monotonic() - started,
                                         afterLaunchPid=after, process_exited=process.poll() is not None)
        terminal((args.out / 'cold-instrumentation.stdout.bin').read_bytes(), (args.out / 'cold-instrumentation.stderr.bin').read_bytes(), code)
        cold_raw = host.command('cold-native-report', ['exec-out', 'content', 'read', '--uri', 'content://androidx.test.services.storage.outputfiles/cold-process-report.json'])
        need(0 < len(cold_raw) <= 128 * 1024, 'cold_report_bound'); cold = json.loads(cold_raw)
        result['contentReadArtifacts'] = {'cold-process-report.json': {
            'receiptLabel': 'cold-native-report', 'bytes': len(cold_raw), 'sha256': sha(cold_raw)}}
        (args.out / 'cold-process-report.json').write_bytes(cold_raw); verify_cold(cold, expected, after)
        for filename in COLD_SCREENSHOTS:
            image = host.command(filename[:-4], ['exec-out', 'content', 'read', '--uri', 'content://androidx.test.services.storage.outputfiles/' + filename])
            need(image.startswith(b'\x89PNG\r\n\x1a\n') and 1024 < len(image) <= 16 * 1024 * 1024, 'cold_actual_PNG_missing')
            result['contentReadArtifacts'][filename] = {
                'receiptLabel': filename[:-4], 'bytes': len(image), 'sha256': sha(image)}
            (args.out / filename).write_bytes(image)
        host.network('after-cold-ui'); after_boot = host.command('after-boot-id', ['shell', 'cat', '/proc/sys/kernel/random/boot_id']).strip()
        need(after_boot == boot, 'guest_rebooted_instead_of_App_cold_restart')
        result.update(phase='host-cold-process-history-passed', passed=True, afterLaunchPid=after,
                      forceStopColdProcessVerified=True, sameBootVerified=True, originalRecordPhotoSearchVerified=True,
                      actualColdNativeReportSha256=sha(cold_raw), physicalDeviceClaim=False)
    except Exception as error:
        result.update(phase='host-cold-process-history-failed', failure=type(error).__name__ + ': ' + str(error)); raise
    finally:
        if process is not None and process.poll() is None:
            process.kill(); process.wait(timeout=10)
            result['hostInstrumentationTerminatedOnFailure'] = True
            result['guestTerminationConfirmed'] = False
        if process is not None:
            result['instrumentation'].update(return_code=process.returncode, process_exited=process.poll() is not None,
                                             finished_monotonic_seconds=time.monotonic())
            for stream in ('stdout', 'stderr'):
                result['instrumentation'][stream + '_sha256'] = sha((args.out / ('cold-instrumentation.' + stream + '.bin')).read_bytes())
        (args.out / 'host-cold-process-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()

"""Independent App-only evidence gate; never accepts the old two-case experiment."""
import json
import math
import re
import sys
from pathlib import Path
from case_gate import GateError, check_png, load_object, need, read_regular
from protocol import CASES


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_final_state(folder):
    evidence = load_object(folder, 'input-lifecycle-final-state.json')
    need(evidence.get('schema') == 'app-final-drawn-frame-v1' and evidence.get('visualFrameObserved') is True, 'diagnostic_final_draw')
    keys = ('synchronizationStartedElapsedRealtimeMs', 'synchronizationFinishedElapsedRealtimeMs', 'domCapturedElapsedRealtimeMs', 'screenshotStartedElapsedRealtimeMs', 'screenshotFinishedElapsedRealtimeMs')
    times = [evidence.get(key) for key in keys]
    need(all(type(value) is int and value > 0 for value in times) and times == sorted(times), 'diagnostic_final_time_order')
    need(type(evidence.get('wallTimeMillis')) is int and evidence['wallTimeMillis'] > 0, 'diagnostic_final_wall_time')
    dom = evidence.get('dom')
    need(isinstance(dom, dict) and dom.get('launchCoverHidden') is True and dom.get('bootSupported') is True and number(dom.get('performanceNowMs')) and dom['performanceNowMs'] >= 0, 'diagnostic_final_dom_ready')
    route = dom.get('route')
    need(route in ('', '#identify', '#library', '#records', '#settings'), 'diagnostic_final_route')
    need(dom.get('visibleViews') == ['view-' + (route[1:] if route else 'identify')], 'diagnostic_final_route_visibility')
    png = check_png(read_regular(folder, 'input-lifecycle-final.png', 16 * 1024 * 1024))
    return {'schema': 'app-final-drawn-frame-validation-v1', 'synchronized_final_capture_verified': True,
            'png': png, 'dom': dom, 'original_elapsed_realtime_ms': dict(zip(keys, times)),
            'requires_root_actual_final_PNG_review': True, 'cold_process_restart_claim': False}


def validate_geometry(folder, case='app'):
    need(case in CASES, 'diagnostic_case')
    contract = CASES[case]
    rows = []
    for view, selector, cycle in (('identify', '#notes', 1), ('library', '#librarySearch', 2), ('records', '#recordSearch', 3)):
        for state in ('after-touch', 'ime-visible', 'composing'):
            stem = contract['prefix'] + '-' + view + '-' + state
            evidence = load_object(folder, stem + '.json')
            dom = evidence.get('dom')
            need(isinstance(dom, dict), 'diagnostic_dom')
            need(evidence.get('selector') == selector and all(evidence.get(key) is True for key in ('visualFrameObserved', 'windowFocus', 'nativeViewFocus')) and dom.get('active') is True, 'diagnostic_focus_draw')
            keys = ('left', 'top', 'right', 'bottom', 'width', 'height', 'viewportWidth', 'viewportHeight', 'devicePixelRatio', 'bottomNavOverlapCssPixels')
            need(all(number(dom.get(key)) for key in keys), 'diagnostic_finite_geometry')
            need(dom['width'] > 0 and dom['height'] > 0 and dom['viewportWidth'] > 0 and dom['viewportHeight'] > 0 and dom['devicePixelRatio'] > 0, 'diagnostic_positive_geometry')
            need(abs(dom['right'] - dom['left'] - dom['width']) < 0.001 and abs(dom['bottom'] - dom['top'] - dom['height']) < 0.001, 'diagnostic_rectangle_consistency')
            need(dom['inputFullyUnobscured'] is True and dom['left'] >= 0 and dom['top'] >= 0 and dom['right'] <= dom['viewportWidth'] and dom['bottom'] <= dom['viewportHeight'] and dom['bottomNavOverlapCssPixels'] == 0, 'diagnostic_input_obscured')
            for key in ('nativeWebWidth', 'nativeWebHeight', 'imeBottomInsetPixels'):
                need(type(evidence.get(key)) is int and evidence[key] >= 0, 'diagnostic_native_size')
            need(evidence['nativeWebWidth'] > 0 and evidence['nativeWebHeight'] > 0 and type(evidence.get('imeVisible')) is bool, 'diagnostic_native_view')
            png = check_png(read_regular(folder, stem + '.png', 16 * 1024 * 1024))
            method = read_regular(folder, stem + '-input-method.txt', 2 * 1024 * 1024).decode('utf-8', 'strict')
            window = read_regular(folder, stem + '-window.txt', 2 * 1024 * 1024).decode('utf-8', 'strict')
            setting = read_regular(folder, stem + '-hard-keyboard-setting.txt', 64)
            need(setting in (b'1\n', b'1\r\n'), 'diagnostic_keyboard_setting')
            focuses = re.findall(r'(?m)^\s*mCurrentFocus=Window\{[a-f0-9]+ u0 ([^ }\n]+)\}\s*$', window)
            need(len(focuses) == 1 and focuses[0].startswith(contract['package'] + '/'), 'diagnostic_native_window_focus')
            ime_frame = None
            if state != 'after-touch':
                need(evidence['imeVisible'] is True and evidence['imeBottomInsetPixels'] > 0, 'diagnostic_visible_ime_insets')
                need(re.findall(r'(?m)^\s*mInputShown=(true|false)\s*$', method) == ['true'], 'diagnostic_native_ime_shown')
                frames = {tuple([*map(int, row[:4]), row[4]]) for row in re.findall(r'\btype=ime frame=\[(-?[0-9]+),(-?[0-9]+)\]\[(-?[0-9]+),(-?[0-9]+)\][^\n]*?\bvisible=(true|false)\b', window)}
                need(len(frames) == 1, 'diagnostic_unambiguous_native_ime_frame')
                left, top, right, bottom, visible = next(iter(frames))
                need(visible == 'true' and 0 <= left < right <= png['width'] and 0 <= top < bottom == png['height'], 'diagnostic_native_ime_bounds')
                need(bottom - top == evidence['imeBottomInsetPixels'] and evidence['nativeWebHeight'] <= top and evidence['nativeWebWidth'] <= png['width'], 'diagnostic_native_ime_inset_consistency')
                ime_frame = [left, top, right, bottom]
                if state == 'composing':
                    need(dom.get('value') == f'quartz-实验室-{cycle}', 'diagnostic_chinese_composition')
            rows.append({'view': view, 'state': state, 'file': stem + '.json', 'png': png,
                         'input_fully_unobscured': True, 'native_ime_frame': ime_frame})
    return {'schema': 'app-only-nine-input-geometries-v1', 'case': case, 'states': rows,
            'final_capture': validate_final_state(folder),
            'all_nine_geometries_verified': True, 'native_ime_frames_verified': 6,
            'after_touch_geometries_verified': 3, 'requires_root_actual_PNG_review': True,
            'scope': 'Recorded DOM/native bounds and real IME dumps; no inferred WebView screen origin or replacement for direct PNG review.'}


def validate(report):
    if not isinstance(report, dict) or report.get('execution_domain') != 'live_adb_test_candidate_root_review_pending' or report.get('unit_scope') is not False:
        return False
    if report.get('experiment_case_selection') != 'app_only_diagnostic' or report.get('diagnostic_app_only') is not True or report.get('complete_app_only_diagnostic_evidence') is not True:
        return False
    if any(report.get(key) is not False for key in ('complete_candidate_evidence', 'functional_both_fully_observed', 'experiment_protocol_accepted', 'production_stability_accepted', 'root_cause_closed')):
        return False
    if report.get('fatal_error') or report.get('persistent_guest_uncertainty_observations') or report.get('all_observed_inputs_unobscured') is not True:
        return False
    for key, count in (('physical_device_cases', 0), ('live_guest_case_commands', 1), ('unit_case_commands', 0), ('retries', 0), ('active_reconnects', 0), ('reboot_or_force_stop_after_cases', 0)):
        if type(report.get(key)) is not int or report[key] != count:
            return False
    cases = report.get('cases')
    if not isinstance(cases, dict) or set(cases) != {'app'}:
        return False
    app = cases['app']
    if not isinstance(app, dict) or app.get('status') != 'fully_observed_pending_root_visual_review' or app.get('case_structure') != 'structure_pass':
        return False
    if any(app.get(key) is not True for key in ('functional_observed', 'harvest_required_complete', 'all_inputs_unobscured', 'post_identity_verified')) or app.get('post_identity_failed') or app.get('harvest_guest_client_crash_observed'):
        return False
    if type(app.get('harvest_required_file_count')) is not int or app['harvest_required_file_count'] != 103:
        return False
    geometry = app.get('diagnostic_geometry')
    if not isinstance(geometry, dict) or geometry.get('case') != 'app' or geometry.get('all_nine_geometries_verified') is not True or geometry.get('native_ime_frames_verified') != 6 or geometry.get('after_touch_geometries_verified') != 3:
        return False
    final_capture = geometry.get('final_capture')
    if not isinstance(final_capture, dict) or final_capture.get('synchronized_final_capture_verified') is not True or final_capture.get('cold_process_restart_claim') is not False:
        return False
    states = geometry.get('states')
    if not isinstance(states, list) or len(states) != 9 or any(not isinstance(state, dict) or state.get('input_fully_unobscured') is not True for state in states):
        return False
    if {(state.get('view'), state.get('state')) for state in states} != {(view, state) for view in ('identify', 'library', 'records') for state in ('after-touch', 'ime-visible', 'composing')}:
        return False
    binding = report.get('frozen_gate')
    kind = 'new_current_r9_same_run_test_build'
    if not isinstance(binding, dict) or binding.get('experiment_case_selection') != 'app_only_diagnostic' or binding.get('artifact_source_kind') != kind or report.get('artifact_source_kind') != kind:
        return False
    if report.get('new_build_or_signing') is not True or binding.get('new_build_or_signing') is not True or binding.get('old_comparand_reused') is not False or binding.get('distributable_release') is not False:
        return False
    forensics = report.get('forensics')
    if not isinstance(forensics, dict) or forensics.get('status') != 'complete_verified' or forensics.get('transport_or_host_interruption') is not False:
        return False
    family = forensics.get('family_validation')
    return isinstance(family, dict) and all(family.get(key) is True for key in ('all_target_before_local_after_and_APK_signers_verified', 'provider_family_has_actual_ELF', 'ART_has_independent_actual_ELF'))


if __name__ == '__main__':
    try:
        complete = validate(json.loads(Path(sys.argv[1]).read_bytes()))
    except (OSError, ValueError, TypeError, IndexError):
        complete = False
    print(json.dumps({'complete_app_only_diagnostic_evidence': complete, 'dual_case_comparison_accepted': False,
                      'root_actual_PNG_and_provenance_review_still_required': True,
                      'production_stability_accepted': False, 'root_cause_closed': False}))
    sys.exit(0 if complete else 2)

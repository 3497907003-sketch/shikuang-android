"""Proposal-only command plan and result ledger; does not execute device commands."""
import argparse
import json
import math
from pathlib import Path

SDK_CONDITIONS = ({'id': '35-r05', 'sdk': 35, 'image_revision': 'r05'},
                  {'id': '36-r07', 'sdk': 36, 'image_revision': 'r07'})
PHASES = ('compose-before-background', 'compose-before-recreate', 'compose-before-close')
CASES = {
    'control': {'prefix': 'control16k-input-lifecycle', 'package': 'com.shikuang.control16k',
        'test_class': 'com.shikuang.control16k.WebViewControl16kInstrumentedTest',
        'runner': 'com.shikuang.control16k.test/androidx.test.runner.AndroidJUnitRunner'},
    'app': {'prefix': 'input-lifecycle', 'package': 'com.shikuang.app.preview',
        'test_class': 'com.shikuang.app.InputLifecycle16kStressInstrumentedTest',
        'runner': 'com.shikuang.app.preview.test/androidx.test.runner.AndroidJUnitRunner'}}


def evidence_names(case):
    prefix = CASES[case]['prefix']
    names = [prefix + '-report.json', prefix + '-progress.json']
    for cycle in range(12):
        if cycle % 4 == 0:
            continue
        for phase in PHASES:
            names += [f'{prefix}-connection-{cycle}-{phase}.json',
                      f'{prefix}-connection-result-{cycle}-{phase}.json']
    for view in ('identify', 'library', 'records'):
        for state in ('ime-visible', 'composing'):
            stem = f'{prefix}-{view}-{state}'
            names += [stem + '.json', stem + '.png', stem + '-input-method.txt',
                      stem + '-window.txt', stem + '-hard-keyboard-setting.txt']
    names += [prefix + '-final.png']
    return names


def health_eligible(health):
    required_true = ('transport_device', 'boot_completed', 'same_boot_id',
        'same_server_segment', 'identity_verified', 'offline_verified',
        'helper_initialized', 'no_open_guest_failure', 'no_active_prior_instrumentation')
    return isinstance(health, dict) and all(health.get(key) is True for key in required_true)


def case_eligibility(case, health, control_status):
    """A failed/skipped control is not an App observation, but health is mandatory."""
    if case not in CASES or control_status not in ('not_attempted', 'failed', 'observed_strict_pass', 'not_started'):
        raise ValueError('invalid fixed case/status')
    eligible = health_eligible(health)
    return {'case': case, 'eligible_to_attempt_once': eligible,
        'control_status': control_status, 'gate': 'independent fresh case health/identity',
        'case_observed_pass': False, 'new_authorization_required_after_gap': True}


def has_full_command_budget(remaining_seconds, command_timeout_seconds, reserved_seconds):
    values = (remaining_seconds, command_timeout_seconds, reserved_seconds)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in values):
        return False
    return command_timeout_seconds > 0 and remaining_seconds >= command_timeout_seconds + reserved_seconds


def summarize(control, app, forensics, *, root_review=False, visual_review=False,
              image_install_identity=False, host_trace=False):
    """Preserve actual functional observations, without converting them to release."""
    allowed = ('not_attempted', 'failed', 'observed_strict_pass')
    if control not in allowed or app not in allowed or forensics not in ('not_attempted', 'failed', 'complete_verified'):
        raise ValueError('invalid fixed result')
    functional = control == app == 'observed_strict_pass'
    complete = functional and forensics == 'complete_verified' and root_review is True and visual_review is True and image_install_identity is True
    return {'control': control, 'app': app, 'forensics': forensics,
        'functional_both_fully_observed': functional,
        'candidate_all_gate_flags_satisfied': complete,
        'experiment_protocol_accepted': False,
        'acceptance_requires_root_bound_receipts_not_supplied_flags': True,
        'root_cause_closed': False, 'production_stability_accepted': False,
        'cross_device_accepted': False, 'recognition_accuracy_claim': False,
        'adb_trace_observed': host_trace is True,
        'unrun_case_is_pass': False}


def recovery_transition(before, after, interrupted_case):
    if interrupted_case not in CASES:
        raise ValueError('fixed case required')
    same = isinstance(before, dict) and isinstance(after, dict) and all(
        before.get(key) is not None and before.get(key) == after.get(key)
        for key in ('boot_id', 'adb_server_pid', 'provider_identity_sha256', 'art_identity_sha256'))
    return {'read_only_recovered': isinstance(after, dict) and after.get('transport_device') is True,
        'identity_continuity_observed': same,
        'new_segment_required': True, 'interrupted_case': interrupted_case,
        'interrupted_case_status': 'failed', 'resume_partial_cycle': False,
        'backfill_unrun_case_pass': False, 'retry_authorized': False}


def plan():
    adb = '<BOUND_ABSOLUTE_ADB>'
    serial = '<BOUND_EXACT_SERIAL>'
    shell = [adb, '-s', serial, 'shell']
    return {'schema': 'android-observation-protocol-proposal-v1',
        'state': 'root_review_required_not_dispatched',
        'new_device_commands': 0, 'new_ci_dispatches': 0, 'changes_product_workflow': False,
        'conditions': list(SDK_CONDITIONS), 'abi': 'x86_64', 'page_size': 16384,
        'image_source': 'same official complete SDK archives; verify catalog length/SHA1 plus archive SHA256 and every installed image file',
        'frozen_source_commit': '1c345718018ae0ffe657cb5a853adfedcddd11eb',
        'r11_executed_source_commit': '971c609cbc3f8220518c9a0dbcd8c37d9984d1a5',
        'r11_test_workflow_sha256': 'd799c232fbb1fb0672efbf3248f0902f1c85b7e683468a853806ddcabd31f41b',
        'proposal_changes_order_not_original_attempt': True,
        'max_instrumentation_attempts_per_case_per_condition': 1,
        'total_budget': {'existing_ci_job_limit_seconds': 3000,
            'reserve_final_ledger_host_diagnostics_upload_seconds': 180,
            'job_start_and_phase_monotonic_deadline_required': True,
            'before_instrumentation_require_full_960s_plus_150s_harvest_plus_180s_final_reserve': True,
            'do_not_shorten_original_case_timeout_to_fit_budget': True,
            'insufficient_remaining_time': 'not_attempted/budget_exhausted, missing gates and final not accepted',
            'independent_step_results_not_fail_fast': True,
            'worst_case_setup_or_prior_timeout_may_leave_next_case_unrun': True},
        'steps': [
            {'id': 'bind-host', 'kind': 'host_observation', 'continue_independent_receipts': True,
             'capture': ['actual adb/emulator absolute path, version, bytes/SHA256',
                'host UTC and monotonic interval, ADB server PID/start time/config/log location',
                'host ps pid/ppid/start-time/comm without arbitrary args or environment, free, df, /proc/uptime, readable cgroup memory.current/peak/events, kernel log availability'],
             'per_command_timeout_seconds': 15,
             'trace_policy': 'transport,sockets,sync only before normal first server spawn; do not kill an existing daemon to retrofit trace; unsupported server-status and unreadable trace are explicit missing evidence; no env/auth/key dump'},
            {'id': 'bind-image-apks-helper', 'kind': 'existing_frozen_gates',
             'required': 'same official image install hashes, all four APKs and helper bytes, both Java bytes, same r11 helper completed stdout/stderr/returncode semantic gate',
             'scope': 'helper shell initialization is not instrumentation client access; source/model assets unchanged'},
            {'id': 'pre-control-health-identity', 'kind': 'read_only_guest',
             'commands': [
                {'argv': [adb, 'devices', '-l'], 'timeout_seconds': 15},
                {'argv': [adb, '-s', serial, 'get-state'], 'timeout_seconds': 15},
                {'argv': shell + ['cat', '/proc/sys/kernel/random/boot_id'], 'timeout_seconds': 15},
                {'argv': shell + ['cat', '/proc/uptime'], 'timeout_seconds': 15},
                {'argv': shell + ['getprop', 'sys.boot_completed'], 'timeout_seconds': 15},
                {'argv': shell + ['getconf', 'PAGE_SIZE'], 'timeout_seconds': 15},
                {'argv': shell + ['getprop', 'ro.build.version.sdk'], 'timeout_seconds': 15},
                {'argv': shell + ['getprop', 'ro.product.cpu.abi'], 'timeout_seconds': 15},
                {'argv': shell + ['getprop', 'ro.build.fingerprint'], 'timeout_seconds': 15},
                {'argv': shell + ['pidof', 'adbd', 'system_server'], 'timeout_seconds': 15},
                {'argv': shell + ['dumpsys', 'activity', 'instrumentation'], 'timeout_seconds': 20},
                {'argv': shell + ['dumpsys', 'webviewupdate'], 'timeout_seconds': 20},
                {'argv': shell + ['pm', 'path', '<ACTUAL_RESOLVED_PROVIDER_PACKAGE>'], 'timeout_seconds': 20},
                {'argv': shell + ['dumpsys', 'package', '<ACTUAL_RESOLVED_PROVIDER_PACKAGE>'], 'timeout_seconds': 20},
                {'argv': shell + ['pm', 'list', 'packages', '--apex-only', '--show-versioncode'], 'timeout_seconds': 20},
                {'argv': shell + ['stat', '-c', '%s', '<ACTUAL_PROVIDER_OR_TRICHROME_OR_ART_PATH>'], 'timeout_seconds': 20},
                {'argv': shell + ['sha256sum', '<ACTUAL_PROVIDER_OR_TRICHROME_OR_ART_PATH>'], 'timeout_seconds': 45}],
             'required_extra': ['offline native connectivity/routes and device health from original gates',
                'resolve static Trichrome from actual provider usesLibraryFiles/version, not pm installed-package list guess',
                'all resolved original paths size/SHA before tests; allowed paths and r11 exact parser retained',
                'baseline guest kernel/logcat and system_server/adbd PID plus boot-id intervals',
                'host trace usability recorded without causing ADB restart'],
             'timeout_termination': 'host process-group kill does not prove guest instrumentation stopped; current guest active-instrumentation absence must be parsed with actual platform support, otherwise block next case as unverified; do not force-stop/retry automatically',
             'identity_scope': 'remote SHA and size do NOT claim downloaded signer, ELF layout or BuildId'},
            {'id': 'control-once', 'kind': 'independent_instrumentation_case',
             'argv': shell + ['am', 'instrument', '-w', '-r', '-e', 'useTestStorageService', 'true', '-e', 'expectedSdk', '<35_OR_36>', '-e', 'class', CASES['control']['test_class'], CASES['control']['runner']],
             'timeout_seconds': 960, 'gate': 'fresh health/identity valid; original strict assertions unchanged', 'attempts': 1},
            {'id': 'harvest-control-small', 'kind': 'bounded_evidence', 'always_attempt_independently': True,
             'files': evidence_names('control'), 'json_first': True,
             'capture_logcat_exit_info_before_large_transfer': True},
            {'id': 'pre-app-health-identity', 'kind': 'read_only_guest',
             'repeat_binding': 'fresh same-boot/server/provider/staticlib/ART identity plus offline and actual helper health; no assumption from control outcome',
             'control_failure_does_not_mean_app_failure': True,
             'open_platform_transport_failure_blocks_app_as_not_attempted': True},
            {'id': 'app-once', 'kind': 'independent_instrumentation_case',
             'argv': shell + ['am', 'instrument', '-w', '-r', '-e', 'useTestStorageService', 'true', '-e', 'expectedSdk', '<35_OR_36>', '-e', 'class', CASES['app']['test_class'], CASES['app']['runner']],
             'timeout_seconds': 960, 'gate': 'fresh health/identity valid, not control success or bare always()', 'attempts': 1},
            {'id': 'harvest-app-small', 'kind': 'bounded_evidence', 'always_attempt_independently': True,
             'files': evidence_names('app'), 'json_first': True,
             'capture_logcat_exit_info_before_large_transfer': True},
            {'id': 'post-case-identity', 'kind': 'read_only_guest',
             'repeat_binding': 'each case post-state, boot/PID interval, offline, provider/staticlib/ART exact remote size/SHA; preserve every independent failure'},
            {'id': 'signed-binary-forensics-after-functional', 'kind': 'required_for_final_acceptance',
             'scope': 'once for each actual provider/staticlib/ART file: original r11 before/local/after exact bytes/SHA + signer + BuildId/readelf ELF layout and placeholder rule',
             'timeout_seconds_per_apk_pull': 90, 'timeout_seconds_per_art_pull': 60,
             'retries': 0, 'compression_change': False, 'image_or_provider_change': False,
             'device_offline_stops_further_device_transfers': True,
             'failure_does_not_erase_already_observed_case': True,
             'incomplete_forensics_blocks_experiment_acceptance': True},
            {'id': 'always-host-diagnostics-and-final-ledger', 'kind': 'bounded_host_and_optional_guest',
             'per_command_timeout_seconds': 15,
             'guest_commands_need_fresh_transport_not_default_continue': True,
             'write_every_status_even_not_attempted': True}],
        'evidence_harvest_contract': {
            'source': '/sdcard/googletest/test_outputfiles/<EXACT_ALLOWLIST_NAME> from actual AndroidX service output',
            'no_recursive_directory_pull': True, 'per_file_timeout_seconds': 10,
            'per_case_total_budget_seconds': 150, 'per_case_total_bytes_cap': 128 * 1024 * 1024,
            'json_first_then_actual_ime_png_then_extra_diagnostics': True,
            'raw_original_bytes_required': True, 'missing_file_not_success': True,
            'caps_bytes': {'json': 2 * 1024 * 1024, 'png': 16 * 1024 * 1024, 'txt': 4 * 1024 * 1024},
            'existing_utp_copy': 'Use only if physically present: original connected_android_test_additional_output bytes; sha equality required on duplicate. Direct am instrument does not promise AGP/UTP export.',
            'snapshot_not_replacement': 'posthoc adb screencap/launcher/black screen cannot replace native inputEvidence original PNG/DOM/actual frame',
            'no_instrumentation_changes': True},
        'recovery': {'active_reconnect_root_reboot_kill_server': False,
            'read_only_probe_max_attempts': 3, 'total_window_seconds': 45,
            'new_segment_even_if_same_identity_after_transport_gap': True,
            'adb_client_may_autostart_server': 'record host daemon PID/start time; never label server observation side-effect-free',
            'partial_case_resume': False, 'automatic_whole_case_retry': False,
            'new_root_authorization_before_next_instrumentation': True,
            'unrun_case_stays_not_attempted': True},
        'strict_gate': {'lifecycle_cycles': 12, 'native_input_cycles': 9,
            'native_composition_calls': 27, 'handler_thread_identity_exact': True,
            'native_touch_actual_system_ime_chinese_dom_actual_draw_png': True,
            'all_three_views': ['#notes', '#librarySearch', '#recordSearch'],
            'original_terminal_result_and_returncode': True,
            'visible_input_unobscured_separate_review': True,
            'no_physical_chinese_keyboard_suggestion_selection_claim': True,
            'no_cold_process_unsaved_draft_coverage_claim': True},
        'acceptance': {'requires_full_functional_cases_and_binary_identity_and_root_visual_review': True,
            'historical_jit_reportfragment_pause_sigsegv_closed': False,
            'historical_control_memoryinfra_sigtrap_closed': False,
            'r11_system_server_sigsegv_is_app_crash': False,
            'transport_root_cause_closed': False, 'production_acceptance': False,
            'representative_real_device_coverage': False}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Emit proposal only; never runs ADB or CI.')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    with Path(args.output).open('x') as stream:
        json.dump(plan(), stream, ensure_ascii=False, indent=2)
        stream.write('\n')

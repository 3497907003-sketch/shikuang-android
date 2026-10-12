"""Only synthetic local processes/files. Zero real devices, models or CI calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
import zlib
from bounded_capture import capture, not_attempted
from case_gate import GateError, validate_case
from protocol import CASES, PHASES, case_eligibility, evidence_names, has_full_command_budget, plan, recovery_transition, summarize


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')


def synthetic_png():
    def chunk(kind, raw):
        return struct.pack('>I', len(raw)) + kind + raw + struct.pack('>I', zlib.crc32(kind + raw) & 0xffffffff)
    raw = (b'\0' + b'\x11\x22\x33' * 320) * 640
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 320, 640, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def fixture(root, case='app'):
    folder = root / 'synthetic-case'
    folder.mkdir()
    prefix = CASES[case]['prefix']
    cycles = [{'cycle': cycle, 'backgroundForegroundVerified': True, 'recreateVerified': True,
        'storedRecordPreserved': True, 'closedWithoutObservedCrash': True,
        'nativeComposingAndVisibleImeVerified': cycle % 4 != 0} for cycle in range(12)]
    events = [{'cycle': cycle, 'action': phase + suffix} for cycle in range(12) if cycle % 4 != 0 for phase in PHASES for suffix in ('/native-touch-after', '/ime-visible', '/chinese-dom-verified')]
    report = {'phase': 'passed', 'sdk': 35, 'pageSize': 16384, 'deviceAbi': 'x86_64',
        'packageName': CASES[case]['package'], 'activeNetworkBefore': None, 'activeNetworkAfter': None,
        'sentinelRemoved': True, 'productionAccuracyClaim': False, 'unsavedDraftPersistenceClaim': False,
        'coldProcessRestartClaim': False, 'physicalImeSuggestionSelectionClaim': False, 'nativeInputCycles': 9,
        'fallbackNoEditCycles': 3, 'cycles': cycles, 'events': events}
    dump(folder / (prefix + '-report.json'), report)
    for cycle in range(12):
        if cycle % 4 == 0:
            continue
        for phase in PHASES:
            dump(folder / f'{prefix}-connection-result-{cycle}-{phase}.json',
                {'cycle': cycle, 'composePhase': phase, 'nativeCompositionReturned': True,
                 'actualCallThreadId': 22, 'handlerThreadId': 22,
                 'actualCallThreadName': 'synthetic-handler', 'handlerThreadName': 'synthetic-handler'})
    for view, selector, cycle in [('identify', '#notes', 1), ('library', '#librarySearch', 2), ('records', '#recordSearch', 3)]:
        for state in ('composing', 'ime-visible'):
            stem = f'{prefix}-{view}-{state}'
            dump(folder / (stem + '.json'), {'selector': selector, 'visualFrameObserved': True,
                'imeVisible': True, 'windowFocus': True, 'nativeViewFocus': True,
                'dom': {'active': True, 'value': f'quartz-实验室-{cycle}', 'inputFullyUnobscured': True}})
            (folder / (stem + '.png')).write_bytes(synthetic_png())
    receipt_dir = root / 'synthetic-command'
    capture([sys.executable, '-B', '-c', "print('OK (1 test)\\nINSTRUMENTATION_CODE: -1')"], receipt_dir, timeout_seconds=1)
    return folder, receipt_dir, prefix


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shikuang-proposal-synthetic-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_child(self, script, **kwargs):
        return capture([sys.executable, '-B', '-c', script], self.root / 'receipt', timeout_seconds=kwargs.pop('timeout_seconds', 1), **kwargs)

    def test_actual_child_success_binary_separate_streams(self):
        r = self.run_child("import os;os.write(1,b'\\x00A');os.write(2,b'B\\xff')")
        self.assertTrue(r['success'])
        self.assertEqual((self.root / 'receipt/stdout.bin').read_bytes(), b'\0A')
        self.assertEqual((self.root / 'receipt/stderr.bin').read_bytes(), b'B\xff')
        self.assertEqual(r['streams']['stdout']['sha256'], hashlib.sha256(b'\0A').hexdigest())

    def test_actual_child_nonzero_not_timeout(self):
        r = self.run_child("import sys;print('failed');sys.exit(7)")
        self.assertEqual((r['status'], r['return_code'], r['timed_out'], r['success']), ('command_failed', 7, False, False))

    def test_actual_timeout_retains_partial_stdout_stderr(self):
        r = self.run_child("import os,time;os.write(1,b'before');os.write(2,b'warning');time.sleep(3)", timeout_seconds=0.15)
        self.assertTrue(r['timed_out'])
        self.assertFalse(r['success'])
        self.assertLess(r['elapsed_seconds'], 1)
        self.assertEqual((self.root / 'receipt/stdout.bin').read_bytes(), b'before')
        self.assertEqual((self.root / 'receipt/stderr.bin').read_bytes(), b'warning')

    def test_actual_fork_descendant_pipe_timeout_is_bounded_and_killed(self):
        marker = self.root / 'descendant-wrote-after-timeout'
        code = f"import os,time;pid=os.fork();\nif pid==0:\n time.sleep(.7);open({str(marker)!r},'w').write('alive');os._exit(0)\nelse:\n print(pid,flush=True);os._exit(0)"
        r = self.run_child(code, timeout_seconds=0.12)
        self.assertTrue(r['timed_out'])
        self.assertLess(r['elapsed_seconds'], 1)
        time.sleep(0.8)
        self.assertFalse(marker.exists())

    def test_actual_output_limit_not_success_and_exact_cap(self):
        r = self.run_child("import os;os.write(1,b'A'*200000)", max_stream_bytes=1024)
        self.assertEqual(r['status'], 'output_limit')
        self.assertTrue(r['streams']['stdout']['truncated'])
        self.assertEqual(r['streams']['stdout']['bytes_retained'], 1024)
        self.assertFalse(r['success'])

    def test_actual_spawn_error_controlled(self):
        r = capture(['/nonexistent/shikuang-proposal-test'], self.root / 'receipt', timeout_seconds=0.1)
        self.assertEqual(r['status'], 'spawn_error')
        self.assertEqual(r['error_type'], 'FileNotFoundError')
        self.assertFalse(r['success'])

    def test_immutable_receipt_refuses_existing_directory(self):
        self.run_child("print('first')")
        prior = (self.root / 'receipt/receipt.json').read_bytes()
        with self.assertRaises(FileExistsError):
            self.run_child("print('second')")
        self.assertEqual(prior, (self.root / 'receipt/receipt.json').read_bytes())

    def test_not_attempted_has_no_success_or_exitcode(self):
        r = not_attempted(self.root / 'receipt', 'transport_unavailable')
        self.assertFalse(r['success'])
        self.assertIsNone(r['return_code'])
        self.assertIsNone(r['started_at_utc'])
        self.assertEqual(r['streams'], {})

    def test_no_shell_interpolation(self):
        marker = self.root / 'must-not-exist'
        literal = f'$(touch {marker}); `touch {marker}`'
        r = capture([sys.executable, '-B', '-c', 'import sys;print(sys.argv[1])', literal], self.root / 'receipt', timeout_seconds=1)
        self.assertTrue(r['success'])
        self.assertFalse(marker.exists())
        self.assertEqual((self.root / 'receipt/stdout.bin').read_text().strip(), literal)

    def test_timeout_and_output_caps_reject_bool_nan_unbounded(self):
        for timeout in (True, float('nan'), float('inf'), 0, 961):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                capture([sys.executable], self.root / 'unused', timeout_seconds=timeout)


class LedgerTests(unittest.TestCase):
    def health(self):
        return {key: True for key in ('transport_device', 'boot_completed', 'same_boot_id', 'same_server_segment', 'identity_verified', 'offline_verified', 'helper_initialized', 'no_open_guest_failure', 'no_active_prior_instrumentation')}

    def test_failed_control_does_not_erase_eligible_independent_app(self):
        r = case_eligibility('app', self.health(), 'failed')
        self.assertTrue(r['eligible_to_attempt_once'])
        self.assertFalse(r['case_observed_pass'])

    def test_each_health_gap_blocks_not_skips_to_pass(self):
        for key in self.health():
            h = self.health();h[key] = False
            with self.subTest(key=key):
                self.assertFalse(case_eligibility('app', h, 'observed_strict_pass')['eligible_to_attempt_once'])

    def test_string_true_does_not_satisfy_health(self):
        h = self.health();h['offline_verified'] = 'true'
        self.assertFalse(case_eligibility('app', h, 'failed')['eligible_to_attempt_once'])

    def test_host_timeout_is_not_guest_instrumentation_termination(self):
        h = self.health();h.pop('no_active_prior_instrumentation')
        self.assertFalse(case_eligibility('app', h, 'failed')['eligible_to_attempt_once'])

    def test_original_timeout_is_not_shortened_to_fit_job_or_upload(self):
        self.assertFalse(has_full_command_budget(1200, 960, 150 + 180))
        self.assertTrue(has_full_command_budget(1290, 960, 150 + 180))
        self.assertFalse(has_full_command_budget(float('inf'), 960, 330))
        self.assertFalse(has_full_command_budget(True, 960, 330))

    def test_forensic_failure_preserves_observations_but_blocks_acceptance(self):
        r = summarize('observed_strict_pass', 'observed_strict_pass', 'failed', root_review=True, visual_review=True, image_install_identity=True)
        self.assertTrue(r['functional_both_fully_observed'])
        self.assertFalse(r['experiment_protocol_accepted'])
        self.assertFalse(r['production_stability_accepted'])

    def test_missing_case_never_passes_even_all_other_gates_true(self):
        r = summarize('observed_strict_pass', 'not_attempted', 'complete_verified', root_review=True, visual_review=True, image_install_identity=True)
        self.assertFalse(r['experiment_protocol_accepted'])
        self.assertFalse(r['functional_both_fully_observed'])

    def test_layout_review_separate_and_required_for_acceptance(self):
        r = summarize('observed_strict_pass', 'observed_strict_pass', 'complete_verified', root_review=True, visual_review=False, image_install_identity=True)
        self.assertTrue(r['functional_both_fully_observed'])
        self.assertFalse(r['experiment_protocol_accepted'])

    def test_successful_protocol_is_not_historical_root_cause_or_product_release(self):
        r = summarize('observed_strict_pass', 'observed_strict_pass', 'complete_verified', root_review=True, visual_review=True, image_install_identity=True)
        self.assertTrue(r['candidate_all_gate_flags_satisfied'])
        self.assertFalse(r['experiment_protocol_accepted'])
        self.assertFalse(r['root_cause_closed'])
        self.assertFalse(r['cross_device_accepted'])
        self.assertFalse(r['production_stability_accepted'])

    def test_same_boot_recovery_still_new_segment_no_retry_or_backfill(self):
        before = dict(boot_id='synthetic-boot', adb_server_pid=123, provider_identity_sha256='a'*64, art_identity_sha256='b'*64)
        after = {**before, 'transport_device': True}
        r = recovery_transition(before, after, 'control')
        self.assertTrue(r['identity_continuity_observed'])
        self.assertTrue(r['new_segment_required'])
        self.assertFalse(r['retry_authorized'])
        self.assertFalse(r['backfill_unrun_case_pass'])

    def test_changed_boot_or_missing_identity_cannot_recover_continuity(self):
        before = dict(boot_id='a', adb_server_pid=1, provider_identity_sha256='a'*64, art_identity_sha256='b'*64)
        for key in before:
            after = {**before, key: None, 'transport_device': True}
            with self.subTest(key=key):
                self.assertFalse(recovery_transition(before, after, 'app')['identity_continuity_observed'])

    def test_plan_has_no_dispatch_and_small_artifacts_before_heavy_transfer(self):
        p = plan();ids = [row['id'] for row in p['steps']]
        self.assertEqual(p['new_ci_dispatches'], 0)
        self.assertLess(ids.index('harvest-control-small'), ids.index('signed-binary-forensics-after-functional'))
        self.assertLess(ids.index('harvest-app-small'), ids.index('signed-binary-forensics-after-functional'))
        for case in CASES:
            names = evidence_names(case)
            self.assertEqual(len(names), 87)
            self.assertEqual(len(set(names)), 87)
            self.assertTrue(all('/' not in name for name in names))


class CaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shikuang-case-SYNTHETIC-')
        self.root = Path(self.temp.name)
        self.folder, self.receipt_dir, self.prefix = fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def validate(self):
        return validate_case(self.folder, 'app', 35, self.receipt_dir)

    def edit(self, suffix, callback):
        path = self.folder / (self.prefix + suffix)
        obj = json.loads(path.read_text());callback(obj);dump(path, obj)

    def test_synthetic_complete_structure_does_not_claim_actual_device(self):
        r = self.validate()
        self.assertEqual((r['completed_cycles'], r['native_cycles'], r['native_composition_calls']), (12, 9, 27))
        self.assertFalse(r['genuine_device_claim'])
        self.assertFalse(r['provenance_checked_here'])
        self.assertTrue(r['requires_root_actual_visual_review'])

    def test_control_contract_is_independent(self):
        with tempfile.TemporaryDirectory(prefix='shikuang-control-SYNTHETIC-') as directory:
            folder, receipt, _ = fixture(Path(directory), 'control')
            r = validate_case(folder, 'control', 35, receipt)
            self.assertEqual(r['case'], 'control')

    def test_eleven_cycles_rejected(self):
        self.edit('-report.json', lambda d: d['cycles'].pop())
        with self.assertRaises(GateError):self.validate()

    def test_eight_native_cycles_rejected(self):
        self.edit('-report.json', lambda d: d['cycles'][1].update(nativeComposingAndVisibleImeVerified=False))
        with self.assertRaises(GateError):self.validate()

    def test_twenty_six_events_rejected(self):
        self.edit('-report.json', lambda d: d['events'].pop())
        with self.assertRaises(GateError):self.validate()

    def test_duplicate_events_cannot_make_27_valid_distinct_calls(self):
        self.edit('-report.json', lambda d: d['events'].__setitem__(3, copy.deepcopy(d['events'][0])))
        with self.assertRaises(GateError):self.validate()

    def test_handler_wrong_thread_rejected(self):
        self.edit('-connection-result-1-compose-before-background.json', lambda d: d.update(actualCallThreadId=99))
        with self.assertRaises(GateError):self.validate()

    def test_js_only_chinese_value_without_visible_ime_rejected(self):
        self.edit('-identify-composing.json', lambda d: d.update(imeVisible=False))
        with self.assertRaises(GateError):self.validate()

    def test_dom_formula_ascii_substitution_rejected(self):
        self.edit('-identify-composing.json', lambda d: d['dom'].update(value='quartz-lab-1'))
        with self.assertRaises(GateError):self.validate()

    def test_readiness_callback_without_real_draw_rejected(self):
        self.edit('-identify-composing.json', lambda d: d.update(visualFrameObserved=False))
        with self.assertRaises(GateError):self.validate()

    def test_missing_original_png_not_substituted_by_final_launcher(self):
        (self.folder / (self.prefix + '-identify-composing.png')).unlink()
        (self.folder / (self.prefix + '-final.png')).write_bytes(synthetic_png())
        with self.assertRaises(GateError):self.validate()

    def test_eight_byte_png_magic_is_not_complete_png(self):
        (self.folder / (self.prefix + '-identify-composing.png')).write_bytes(b'\x89PNG\r\n\x1a\n')
        with self.assertRaises(GateError):self.validate()

    def test_corrupted_png_crc_rejected(self):
        p = self.folder / (self.prefix + '-identify-composing.png');raw = bytearray(p.read_bytes());raw[-1] ^= 1;p.write_bytes(raw)
        with self.assertRaises(GateError):self.validate()

    def test_layout_obscured_preserves_case_observation_but_not_layout_pass(self):
        self.edit('-identify-composing.json', lambda d: d['dom'].update(inputFullyUnobscured=False))
        r = self.validate()
        self.assertEqual(r['status'], 'structure_pass')
        self.assertFalse(r['all_observed_inputs_unobscured'])
        self.assertFalse(r['production_stability_accepted'])

    def test_sdk_page_abi_network_package_individually_rejected(self):
        path = self.folder / (self.prefix + '-report.json');original = json.loads(path.read_text())
        for key, value in [('sdk', 36), ('pageSize', 4096), ('deviceAbi', 'arm64-v8a'), ('activeNetworkBefore', 'network-id'), ('packageName', 'other')]:
            obj = copy.deepcopy(original);obj[key] = value;dump(path, obj)
            with self.subTest(key=key), self.assertRaises(GateError):self.validate()
        dump(path, original)

    def test_lifecycle_sentinel_close_failure_rejected(self):
        self.edit('-report.json', lambda d: d['cycles'][9].update(closedWithoutObservedCrash=False))
        with self.assertRaises(GateError):self.validate()

    def test_corrupt_json_large_integer_controlled_reject(self):
        (self.folder / (self.prefix + '-report.json')).write_bytes(b'{"sdk":'+b'9'*5000+b'}')
        with self.assertRaises(GateError):self.validate()

    def test_report_list_instead_of_object_controlled_reject(self):
        dump(self.folder / (self.prefix + '-report.json'), ['passed'])
        with self.assertRaises(GateError):self.validate()

    def test_instrumentation_streams_list_controlled_reject(self):
        p = self.receipt_dir / 'receipt.json';r = json.loads(p.read_text());r['streams'] = [];dump(p, r)
        with self.assertRaises(GateError):self.validate()

    def test_false_exitcode_is_not_integer_zero(self):
        p = self.receipt_dir / 'receipt.json';r = json.loads(p.read_text());r['return_code'] = False;dump(p, r)
        with self.assertRaises(GateError):self.validate()

    def test_forged_physical_ime_claim_rejected(self):
        self.edit('-report.json', lambda d: d.update(physicalImeSuggestionSelectionClaim=True))
        with self.assertRaises(GateError):self.validate()

    def test_actual_fifo_report_refused_without_opening(self):
        p = self.folder / (self.prefix + '-report.json');p.unlink();os.mkfifo(p)
        before = time.monotonic()
        with self.assertRaises(GateError):self.validate()
        self.assertLess(time.monotonic() - before, 0.2)

    def test_missing_connection_file_rejected(self):
        (self.folder / (self.prefix + '-connection-result-11-compose-before-close.json')).unlink()
        with self.assertRaises(GateError):self.validate()

    def test_existing_failure_key_even_null_rejected(self):
        self.edit('-connection-result-1-compose-before-background.json', lambda d: d.update(failure=None))
        with self.assertRaises(GateError):self.validate()

    def test_terminal_success_text_cannot_override_command_failure(self):
        p = self.receipt_dir / 'receipt.json';r = json.loads(p.read_text());r.update(success=False, status='command_failed', return_code=1);dump(p, r)
        with self.assertRaises(GateError):self.validate()

    def test_instrumentation_stream_hash_tamper_rejected(self):
        p = self.receipt_dir / 'stdout.bin';p.write_bytes(p.read_bytes()+b'altered')
        with self.assertRaises(GateError):self.validate()

    def test_report_symlink_rejected(self):
        p = self.folder / (self.prefix + '-report.json');other = self.root / 'symlink-target.json';p.rename(other);p.symlink_to(other)
        with self.assertRaises(GateError):self.validate()


if __name__ == '__main__':
    unittest.main(verbosity=2)

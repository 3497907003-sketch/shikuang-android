"""Small UNIT_ONLY selector/gate checks. Constructed shapes are never device evidence."""
import copy
import unittest
from app_diagnostic_gate import validate
from executor import selected_cases
from final_current_gate import validate as old_comparison_gate


def UNIT_ONLY_shape():
    states = [{'view': view, 'state': state, 'input_fully_unobscured': True}
              for view in ('identify', 'library', 'records')
              for state in ('after-touch', 'ime-visible', 'composing')]
    app = {'status': 'fully_observed_pending_root_visual_review', 'case_structure': 'structure_pass',
           'functional_observed': True, 'harvest_required_complete': True, 'harvest_required_file_count': 103,
           'all_inputs_unobscured': True, 'post_identity_verified': True,
           'diagnostic_geometry': {'case': 'app', 'all_nine_geometries_verified': True,
                                   'native_ime_frames_verified': 6, 'after_touch_geometries_verified': 3,
                                   'states': states,
                                   'final_capture': {'synchronized_final_capture_verified': True,
                                                     'cold_process_restart_claim': False}}}
    return {'execution_domain': 'live_adb_test_candidate_root_review_pending', 'unit_scope': False,
            'experiment_case_selection': 'app_only_diagnostic', 'diagnostic_app_only': True,
            'complete_app_only_diagnostic_evidence': True, 'complete_candidate_evidence': False,
            'functional_both_fully_observed': False, 'experiment_protocol_accepted': False,
            'production_stability_accepted': False, 'root_cause_closed': False,
            'persistent_guest_uncertainty_observations': [], 'all_observed_inputs_unobscured': True,
            'physical_device_cases': 0, 'live_guest_case_commands': 1, 'unit_case_commands': 0,
            'retries': 0, 'active_reconnects': 0, 'reboot_or_force_stop_after_cases': 0,
            'cases': {'app': app}, 'artifact_source_kind': 'new_current_r9_same_run_test_build',
            'new_build_or_signing': True,
            'frozen_gate': {'experiment_case_selection': 'app_only_diagnostic',
                            'artifact_source_kind': 'new_current_r9_same_run_test_build',
                            'new_build_or_signing': True, 'old_comparand_reused': False,
                            'distributable_release': False},
            'forensics': {'status': 'complete_verified', 'transport_or_host_interruption': False,
                          'family_validation': {'all_target_before_local_after_and_APK_signers_verified': True,
                                                'provider_family_has_actual_ELF': True,
                                                'ART_has_independent_actual_ELF': True}}}


class AppDiagnosticTests(unittest.TestCase):
    def test_default_remains_two_cases_and_app_only_is_explicit(self):
        self.assertEqual(selected_cases(), ('control', 'app'))
        self.assertEqual(selected_cases(True), ('app',))
        for value in (1, 'app', None):
            with self.assertRaises(ValueError):
                selected_cases(value)

    def test_constructed_shape_never_passes_old_comparison_gate(self):
        report = UNIT_ONLY_shape()
        self.assertTrue(validate(report))
        self.assertFalse(old_comparison_gate(report))

    def test_diagnostic_cannot_be_synthetic_production_or_old_mode(self):
        for key, value in (('unit_scope', True), ('execution_domain', 'unit_only_python_adapter_no_device'),
                           ('experiment_case_selection', 'comparison'), ('diagnostic_app_only', False),
                           ('production_stability_accepted', True), ('complete_candidate_evidence', True),
                           ('root_cause_closed', True), ('live_guest_case_commands', True)):
            report = UNIT_ONLY_shape();report[key] = value
            with self.subTest(key=key):self.assertFalse(validate(report))

    def test_requires_103_files_post_identity_and_no_guest_crash(self):
        for key, value in (('harvest_required_complete', False), ('harvest_required_file_count', 102),
                           ('post_identity_verified', False), ('post_identity_failed', True),
                           ('harvest_guest_client_crash_observed', True), ('functional_observed', False)):
            report = UNIT_ONLY_shape();report['cases']['app'][key] = value
            with self.subTest(key=key):self.assertFalse(validate(report))

    def test_requires_synchronized_final_capture_without_cold_process_claim(self):
        for value in (None, {}, {'synchronized_final_capture_verified': False, 'cold_process_restart_claim': False},
                      {'synchronized_final_capture_verified': True, 'cold_process_restart_claim': True}):
            report = UNIT_ONLY_shape();report['cases']['app']['diagnostic_geometry']['final_capture'] = value
            with self.subTest(value=value):self.assertFalse(validate(report))

    def test_requires_all_nine_distinct_geometries_and_manifest_mode(self):
        report = UNIT_ONLY_shape();report['cases']['app']['diagnostic_geometry']['states'] = report['cases']['app']['diagnostic_geometry']['states'][:6]
        self.assertFalse(validate(report))
        report = UNIT_ONLY_shape();report['cases']['app']['diagnostic_geometry']['states'][-1] = copy.deepcopy(report['cases']['app']['diagnostic_geometry']['states'][0])
        self.assertFalse(validate(report))
        report = UNIT_ONLY_shape();report['frozen_gate']['experiment_case_selection'] = 'comparison'
        self.assertFalse(validate(report))

    def test_incomplete_provider_ART_forensics_or_interruption_rejects(self):
        for key in ('all_target_before_local_after_and_APK_signers_verified', 'provider_family_has_actual_ELF', 'ART_has_independent_actual_ELF'):
            report = UNIT_ONLY_shape();report['forensics']['family_validation'][key] = False
            with self.subTest(key=key):self.assertFalse(validate(report))
        report = UNIT_ONLY_shape();report['persistent_guest_uncertainty_observations'] = [{'reason': 'guest_client_segmentation_fault_marker'}]
        self.assertFalse(validate(report))


if __name__ == '__main__':
    unittest.main()

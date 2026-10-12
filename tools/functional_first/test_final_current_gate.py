"""UNIT_ONLY report-shape negatives, never live Android or visual evidence."""
import copy, unittest
from final_current_gate import CURRENT_KIND, validate

class CurrentFinalGateTests(unittest.TestCase):
 def setUp(self):
  case = {'status': 'fully_observed_pending_root_visual_review',
   'harvest_required_complete': True, 'case_structure': 'structure_pass',
   'functional_observed': True, 'all_inputs_unobscured': True}
  self.report = {'execution_domain': 'live_adb_test_candidate_root_review_pending',
   'unit_scope': False, 'complete_candidate_evidence': True,
   'functional_both_fully_observed': True, 'physical_device_cases': 0,
   'live_guest_case_commands': 2, 'unit_case_commands': 0,
   'experiment_protocol_accepted': False, 'forensics': {'status': 'complete_verified'},
   'cases': {'control': copy.deepcopy(case), 'app': copy.deepcopy(case)},
   'artifact_source_kind': CURRENT_KIND, 'new_build_or_signing': True,
   'all_observed_inputs_unobscured': True,
   'frozen_gate': {'artifact_source_kind': CURRENT_KIND, 'new_build_or_signing': True,
    'old_comparand_reused': False, 'distributable_release': False}}
 def test_UNIT_ONLY_shape_pass_does_not_prove_device_or_PNG_review(self):
  self.assertTrue(validate(self.report))
 def test_total_unobscured_requires_exact_boolean(self):
  for value in (None, False, 1, 'true'):
   with self.subTest(value=value):
    self.report['all_observed_inputs_unobscured'] = value
    self.assertFalse(validate(self.report))
 def test_each_case_unobscured_required_even_when_total_is_true(self):
  for name in ('app', 'control'):
   for value in (None, False, 1, 'true'):
    with self.subTest(name=name, value=value):
     r = copy.deepcopy(self.report); r['cases'][name]['all_inputs_unobscured'] = value
     self.assertFalse(validate(r))
 def test_old_or_missing_build_binding_rejected(self):
  for value in (None, {}, {'artifact_source_kind': 'old_frozen_comparand'}):
   with self.subTest(value=value):
    self.report['frozen_gate'] = value; self.assertFalse(validate(self.report))
 def test_reused_or_release_claim_rejected(self):
  for field in ('old_comparand_reused', 'distributable_release'):
   with self.subTest(field=field):
    r = copy.deepcopy(self.report); r['frozen_gate'][field] = True
    self.assertFalse(validate(r))
 def test_existing_strict_terminal_and_UNIT_ONLY_gates_preserved(self):
  for field, value in (('unit_scope', True), ('complete_candidate_evidence', False),
   ('live_guest_case_commands', 1), ('new_build_or_signing', False)):
   with self.subTest(field=field):
    r = copy.deepcopy(self.report); r[field] = value; self.assertFalse(validate(r))

if __name__ == '__main__': unittest.main()

"""Current-build evidence gate. Software geometry never replaces Root PNG review."""
import json, sys
from pathlib import Path
from final_gate import validate as validate_functional

CURRENT_KIND = 'new_current_r9_same_run_test_build'

def validate(report):
 if not validate_functional(report): return False
 binding = report.get('frozen_gate')
 if not isinstance(binding, dict): return False
 if report.get('artifact_source_kind') != CURRENT_KIND or binding.get('artifact_source_kind') != CURRENT_KIND: return False
 if report.get('new_build_or_signing') is not True or binding.get('new_build_or_signing') is not True: return False
 if binding.get('old_comparand_reused') is not False or binding.get('distributable_release') is not False: return False
 if report.get('all_observed_inputs_unobscured') is not True: return False
 return all(case.get('all_inputs_unobscured') is True for case in report['cases'].values())

if __name__ == '__main__':
 try:
  report = json.loads(Path(sys.argv[1]).read_bytes())
  complete = validate(report)
 except (OSError, ValueError, TypeError, IndexError): complete = False
 print(json.dumps({'candidate_evidence_complete': complete,
  'root_actual_png_and_provenance_review_still_required': True,
  'software_geometry_is_visual_acceptance': False,
  'production_stability_accepted': False, 'root_cause_closed': False}))
 sys.exit(0 if complete else 2)

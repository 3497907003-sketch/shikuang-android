"""Candidate CI completeness gate only. Never accepts synthetic or claims native cause fixed."""
import json,sys
from pathlib import Path

def validate(report):
 if not isinstance(report,dict) or report.get('execution_domain')!='live_adb_test_candidate_root_review_pending' or report.get('unit_scope') is not False:return False
 if report.get('complete_candidate_evidence') is not True or report.get('functional_both_fully_observed') is not True:return False
 if type(report.get('physical_device_cases')) is not int or report['physical_device_cases']!=0 or type(report.get('live_guest_case_commands')) is not int or report['live_guest_case_commands']!=2 or type(report.get('unit_case_commands')) is not int or report['unit_case_commands']!=0 or report.get('experiment_protocol_accepted') is not False:return False
 cases=report.get('cases')
 if not isinstance(cases,dict) or set(cases)!=set(('control','app')):return False
 if any(not isinstance(x,dict) or x.get('status')!='fully_observed_pending_root_visual_review' or x.get('harvest_required_complete') is not True or x.get('case_structure')!='structure_pass' or x.get('functional_observed') is not True or x.get('post_identity_failed') for x in cases.values()):return False
 forensics=report.get('forensics')
 return isinstance(forensics,dict) and forensics.get('status')=='complete_verified'
if __name__=='__main__':
 try:r=json.loads(Path(sys.argv[1]).read_bytes());ok=validate(r)
 except (OSError,ValueError,TypeError,IndexError):ok=False
 print(json.dumps({'candidate_evidence_complete':ok,'root_actual_visual_and_provenance_review_still_required':True,'production_stability_accepted':False,'root_cause_closed':False}))
 sys.exit(0 if ok else 2)

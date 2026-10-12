"""Pure software negative tests. Synthetic buffers never become device evidence."""
import copy,datetime,email.utils,hashlib,json,sys,tempfile,time,unittest
from pathlib import Path
from terminal import parse_terminal
from health import no_active_instrumentation,provider,static_dependency,binary_meta,continuous,HealthError
from harvest import names,priority,validate_payload
from final_gate import validate
from job_clock import derive
from test_protocol import fixture
from case_gate import validate_case,GateError

GOOD=b'OK (1 test)\nINSTRUMENTATION_CODE: -1\n'
class TerminalTests(unittest.TestCase):
 def test_complete_exact_terminal(self):self.assertEqual(parse_terminal(GOOD,b'')['terminal_code'],-1)
 def test_crlf_complete(self):self.assertEqual(parse_terminal(GOOD.replace(b'\n',b'\r\n'),b'')['terminal_code'],-1)
 def test_minus10_not_prefix_success(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD.replace(b'-1',b'-10'),b'')
 def test_duplicate_even_equal_not_success(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD+b'INSTRUMENTATION_CODE: -1\n',b'')
 def test_minus1_then_zero_not_success(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD+b'INSTRUMENTATION_CODE: 0\n',b'')
 def test_aborted_after_success(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD+b'INSTRUMENTATION_ABORTED: System has crashed.\n',b'')
 def test_aborted_stderr_not_ignored(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD,b'INSTRUMENTATION_ABORTED: stopped\n')
 def test_stderr_terminal_does_not_replace_stdout(self):
  with self.assertRaises(ValueError):parse_terminal(b'OK (1 test)\n',b'INSTRUMENTATION_CODE: -1\n')
 def test_terminal_duplicate_across_streams(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD,b'INSTRUMENTATION_CODE: -1\n')
 def test_missing_final_newline(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD[:-1],b'')
 def test_wrong_case_or_extra_text(self):
  for value in [GOOD.replace(b'CODE',b'code'),GOOD.replace(b'-1\n',b'-1 ignored\n'),GOOD.replace(b'CODE: -1',b'CODE:-1')]:
   with self.subTest(value=value),self.assertRaises(ValueError):parse_terminal(value,b'')
 def test_oversized_integer_controlled(self):
  with self.assertRaises(ValueError):parse_terminal(b'OK (1 test)\nINSTRUMENTATION_CODE: '+b'9'*5000+b'\n',b'')
 def test_invalid_bytes_types_and_nul(self):
  for out in (None,'text',b'\xff\n',GOOD+b'\0\n'):
   with self.subTest(out=str(type(out))),self.assertRaises(ValueError):parse_terminal(out,b'')
 def test_wrong_junit_count(self):
  with self.assertRaises(ValueError):parse_terminal(GOOD.replace(b'1 test',b'2 tests'),b'')
 def test_terminal_before_junit_not_success(self):
  with self.assertRaises(ValueError):parse_terminal(b'INSTRUMENTATION_CODE: -1\nOK (1 test)\n',b'')
 def test_guest_marker_in_stdout_rejects(self):
  for marker in (b'Process crashed',b'FAILURES!!!',b'INSTRUMENTATION_FAILED',b'device offline'):
   with self.subTest(marker=marker),self.assertRaises(ValueError):parse_terminal(GOOD+marker+b'\n',b'')

class HealthTests(unittest.TestCase):
 def raw(self):return b'ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)\n  PID mappings:\n\n__SHIKUANG_PROCESS_DUMP_COMPLETE__:0\n'
 def test_official_complete_no_active(self):self.assertTrue(no_active_instrumentation(self.raw())['no_active_instrumentation_observed'])
 def test_active_instrumentation_blocks(self):
  for marker in (b'  Active instrumentation:\n',b'    Instrumentation #0: active\n'):
   with self.subTest(marker=marker),self.assertRaises(HealthError):no_active_instrumentation(self.raw().replace(b'  PID mappings:',marker+b'  PID mappings:'))
 def test_empty_or_unsupported_instrumentation_command_rejects(self):
  for raw in (b'',b'ACTIVITY MANAGER INSTRUMENTATION\n',b'Unknown command: instrumentation\n'):
   with self.subTest(raw=raw),self.assertRaises(HealthError):no_active_instrumentation(raw)
 def test_truncated_dump_cannot_claim_no_active(self):
  with self.assertRaises(HealthError):no_active_instrumentation(self.raw().split(b'__SHIKUANG_')[0])
 def test_duplicate_complete_sentinel_or_header_rejects(self):
  for raw in (self.raw()+b'__SHIKUANG_PROCESS_DUMP_COMPLETE__:0\n',self.raw().replace(b'  PID',b'ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)\n  PID')):
   with self.subTest(raw=raw),self.assertRaises(HealthError):no_active_instrumentation(raw)
 def test_nonzero_remote_complete_blocks(self):
  with self.assertRaises(HealthError):no_active_instrumentation(self.raw().replace(b'COMPLETE__:0',b'COMPLETE__:1'))
 def test_provider_exact_actual_r11_shape(self):self.assertEqual(provider(b'Current WebView Update Service state\n  Current WebView package (name, version): (com.google.android.webview, 133.0)\n')['version'],'133.0')
 def test_duplicate_provider_blocks(self):
  raw=b'  Current WebView package (name, version): (com.google.android.webview, 133.0)\n'
  with self.assertRaises(HealthError):provider(raw+raw)
 def test_unknown_provider_blocks(self):
  with self.assertRaises(HealthError):provider(b'  Current WebView package (name, version): (other.package, 1)\n')
 def test_static_resolved_identity(self):
  raw=b'  usesStaticLibraries:\n    com.google.android.trichromelibrary version:133\n  usesLibraryFiles:\n    /product/app/TrichromeLibrary/TrichromeLibrary.apk\n  next:\n';self.assertEqual(static_dependency(raw)[0]['version'],'133')
 def test_static_unsafe_or_ambiguous_paths_block(self):
  for path in ('/tmp/file.apk','/product/app/../../bad.apk'):
   with self.subTest(path=path),self.assertRaises(HealthError):static_dependency(('  com.google.android.trichromelibrary version:133\n  usesLibraryFiles:\n    '+path+'\n').encode())
 def test_hash_bound_to_exact_remote_path(self):
  with self.assertRaises(HealthError):binary_meta(b'1\n',(b'a'*64)+b'  /other\n','/apex/com.android.art/lib64/libart.so')
 def test_server_boot_provider_art_changes_new_segment(self):
  b={'boot_id':'b','adbd_pid':1,'system_server_pid':2,'sdk':35,'abi':'x86_64','page_size':16384,'fingerprint':'f','host_server':{'pid':7,'start_ticks':8},'provider':{'version':'v'},'binary_targets':[{'sha256':'a'}],'helper_identity':{},'uptime':10};self.assertTrue(continuous(b,copy.deepcopy(b)))
  for key in ('boot_id','adbd_pid','system_server_pid','host_server','provider','binary_targets'):
   after=copy.deepcopy(b);after[key]='changed'
   with self.subTest(key=key),self.assertRaises(HealthError):continuous(b,after)
 def test_uptime_regression_blocks(self):
  b={'boot_id':'b','adbd_pid':1,'system_server_pid':2,'sdk':35,'abi':'x86_64','page_size':16384,'fingerprint':'f','host_server':{},'provider':{},'binary_targets':[],'helper_identity':{},'uptime':10};after=copy.deepcopy(b);after['uptime']=9
  with self.assertRaises(HealthError):continuous(b,after)

class HarvestTests(unittest.TestCase):
 def test_harvest_offline_stops_remaining_commands_not_guest_termination(self):
  from harvest import collect
  class SyntheticRunner:
   deadline=time.monotonic()+2000
   def __init__(self):self.calls=0
   def command(self,*args,**kwargs):
    self.calls+=1;return {'status':'command_failed','success':False,'relative_dir':'UNIT_ONLY-failed','streams':{'stdout':{'bytes_read':0}}},b'',b'error: device offline\n'
  runner=SyntheticRunner()
  with tempfile.TemporaryDirectory() as tmp:r=collect(runner,'app',Path(tmp)/'media',True)
  self.assertEqual(runner.calls,1);self.assertTrue(r['transport_or_host_interruption']);self.assertFalse(r['guest_termination_confirmed']);self.assertFalse(r['required_complete']);self.assertTrue(r['all282_names_accounted'])
 def test_harvest_host_timeout_is_controlled_and_blocks(self):
  from harvest import collect
  class SyntheticRunner:
   deadline=time.monotonic()+2000
   def command(self,*args,**kwargs):return {'status':'timeout','success':False,'relative_dir':'UNIT_ONLY-timeout','streams':{'stdout':{'bytes_read':0}}},b'',b''
  with tempfile.TemporaryDirectory() as tmp:r=collect(SyntheticRunner(),'control',Path(tmp)/'media',False)
  self.assertTrue(r['transport_or_host_interruption']);self.assertFalse(r['guest_termination_confirmed']);self.assertEqual(len(r['results']),282)
 def test_102_required_180_optional_both_cases(self):
  for case in ('control','app'):
   x=names(case);self.assertEqual((len(x['required']),len(x['optional_failure']),len(set(x['required']+x['optional_failure']))),(102,180,282))
 def test_all_six_original_pngs_before_connection_or_diagnostics(self):
  q=priority('app',{'cycle':11},False);self.assertEqual(q[:4],['input-lifecycle-report.json','input-lifecycle-progress.json','input-lifecycle-identify-ime-visible.json','input-lifecycle-identify-ime-visible.png'])
  png=[q.index('input-lifecycle-'+v+'-'+s+'.png') for v in ('identify','library','records') for s in ('ime-visible','composing')];connections=[i for i,x in enumerate(q) if '-connection-' in x];self.assertLess(max(png),min(connections))
 def test_current_failure_png_before_connections(self):
  q=priority('app',{'cycle':11},False);self.assertLess(q.index('input-lifecycle-compose-failure-11.png'),q.index('input-lifecycle-connection-1-compose-before-background.json'))
 def test_failure_optional_not_required_after_pass(self):self.assertFalse(any('-failure-' in x for x in priority('app',None,True)))
 def test_40_structure_fixture_still_not_complete_harvest(self):
  with tempfile.TemporaryDirectory() as temp:
   folder,cmd,prefix=fixture(Path(temp));result=validate_case(folder,'app',35,cmd);self.assertEqual(result['status'],'structure_pass');missing=set(names('app')['required'])-{x.name for x in folder.iterdir()};self.assertEqual(len(missing),62);self.assertFalse(result['genuine_device_claim'])
 def test_png_signature_only_cannot_qualify(self):
  with self.assertRaises(GateError):validate_payload('input-lifecycle-final.png',b'\x89PNG\r\n\x1a\n')
 def test_content_provider_error_body_not_dump(self):
  with self.assertRaises(GateError):validate_payload('input-lifecycle-identify-composing-window.txt',b'Error while accessing provider\n')
 def test_malformed_json_root_or_5000digit_controlled(self):
  for raw in (b'[]',b'{',b'{"x":'+b'9'*5000+b'}'):
   with self.subTest(raw_len=len(raw)),self.assertRaises(GateError):validate_payload('input-lifecycle-report.json',raw)

class ClockTests(unittest.TestCase):
 def sample(self):
  raw=json.dumps({'total_count':1,'jobs':[{'id':9,'name':'shikuang-current-r9-functional-first-35-r05','status':'in_progress','run_id':123,'run_attempt':1,'started_at':'2026-10-11T01:00:00Z'}]}).encode();date='Sun, 11 Oct 2026 01:01:00 GMT';url='https://api.github.com/repos/owner/repo/actions/runs/123/attempts/1/jobs?per_page=100';return raw,date,'owner/repo','123',1,'shikuang-current-r9-functional-first-35-r05',100000000000,101000000000,url,url
 def test_official_no_run_attempt_field_binds_exact_endpoint(self):
  a=list(self.sample());x=json.loads(a[0]);del x['jobs'][0]['run_attempt'];a[0]=json.dumps(x).encode();self.assertTrue(derive(*a)['authoritative_job_start_verified'])
 def test_redirect_or_wrong_attempt_url_blocks(self):
  for i,value in ((8,'https://api.github.com/repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=100'),(9,'https://api.github.com/repos/other/repo/actions/runs/123/attempts/1/jobs?per_page=100')):
   a=list(self.sample());a[i]=value
   with self.subTest(index=i),self.assertRaises(ValueError):derive(*a)
 def test_invalid_actual_job_field_types_controlled(self):
  for key,value in (('id',True),('started_at',123),('run_attempt',True)):
   a=list(self.sample());x=json.loads(a[0]);x['jobs'][0][key]=value;a[0]=json.dumps(x).encode()
   with self.subTest(key=key),self.assertRaises(ValueError):derive(*a)
 def test_actual_job_start_conservative_mapping(self):r=derive(*self.sample());self.assertEqual(r['started_monotonic_ns'],38000000000);self.assertTrue(r['no_secret_or_auth_token_read'])
 def test_ambiguous_job_does_not_grant_budget(self):
  a=list(self.sample());x=json.loads(a[0]);x['jobs']*=2;x['total_count']=2;a[0]=json.dumps(x).encode()
  with self.assertRaises(ValueError):derive(*a)
 def test_wrong_attempt_or_job_does_not_bind(self):
  for i,value in ((3,'456'),(4,2),(5,'other-job')):
   a=list(self.sample());a[i]=value
   with self.subTest(index=i),self.assertRaises(ValueError):derive(*a)
 def test_server_date_before_start_rejects(self):
  a=list(self.sample());a[1]='Sun, 11 Oct 2026 00:59:00 GMT'
  with self.assertRaises(ValueError):derive(*a)
 def test_incomplete_pagination_blocks(self):
  a=list(self.sample());x=json.loads(a[0]);x['total_count']=101;a[0]=json.dumps(x).encode()
  with self.assertRaises(ValueError):derive(*a)
 def test_malformed_json_date_and_types_controlled(self):
  for i,value in ((0,b'{'),(1,None),(6,True)):
   a=list(self.sample());a[i]=value
   with self.subTest(index=i),self.assertRaises(ValueError):derive(*a)

class ActualHostLifecycleSoftwareTests(unittest.TestCase):
 def test_actual_timeout_reaps_host_not_guest(self):
  from bounded_capture import capture
  from executor import interrupted_guest_uncertain
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);r=capture([sys.executable,'-B','-c',"import time;print('UNIT_ONLY host',flush=True);time.sleep(2)"],root/'receipt',timeout_seconds=.1)
   self.assertTrue(r['timed_out']);self.assertTrue(r['host_process_reaped']);self.assertIs(r['guest_termination_confirmed'],False);self.assertTrue(interrupted_guest_uncertain(r,(root/'receipt/stdout.bin').read_bytes(),b''))
 def test_aborted_requires_no_second_case_even_health_later_looks_good(self):
  from executor import interrupted_guest_uncertain
  self.assertTrue(interrupted_guest_uncertain({'status':'success'},GOOD+b'INSTRUMENTATION_ABORTED: System crashed\n',b''))
 def test_plain_assertion_failure_not_automatically_platform_crash(self):
  from executor import interrupted_guest_uncertain
  self.assertFalse(interrupted_guest_uncertain({'status':'command_failed'},b'FAILURES!!!\nINSTRUMENTATION_CODE: 0\n',b''))
 def test_actual_spawn_failure_uncertain_never_guest_terminated(self):
  from bounded_capture import capture
  from executor import interrupted_guest_uncertain
  with tempfile.TemporaryDirectory() as tmp:
   r=capture(['/nonexistent/UNIT_ONLY_ADB_DO_NOT_EXIST'],Path(tmp)/'receipt',timeout_seconds=.1)
   self.assertTrue(interrupted_guest_uncertain(r,b'',b''));self.assertFalse(r['guest_termination_confirmed']);self.assertFalse(r['host_process_reaped'])

class FinalGateTests(unittest.TestCase):
 def candidate(self):return {'execution_domain':'live_adb_test_candidate_root_review_pending','unit_scope':False,'complete_candidate_evidence':True,'functional_both_fully_observed':True,'physical_device_cases':0,'live_guest_case_commands':2,'unit_case_commands':0,'experiment_protocol_accepted':False,'cases':{k:{'status':'fully_observed_pending_root_visual_review','harvest_required_complete':True,'case_structure':'structure_pass','functional_observed':True} for k in ('control','app')},'forensics':{'status':'complete_verified'}}
 def test_forensic_malformed_type_controlled(self):
  for value in (None,[],True,'complete_verified'):
   x=self.candidate();x['forensics']=value
   with self.subTest(value=value):self.assertFalse(validate(x))
 def test_boolean_count_never_accepted(self):
  x=self.candidate();x['unit_case_commands']=False;self.assertFalse(validate(x))
 def test_unit_never_device_candidate_green(self):self.assertFalse(validate({'unit_scope':True,'complete_candidate_evidence':True,'execution_domain':'unit_only_python_adapter_no_device'}))
 def test_missing_or_supplied_bools_never_green(self):
  for value in (None,{},True,{'complete_candidate_evidence':True,'functional_both_fully_observed':True}):self.assertFalse(validate(value))
if __name__=='__main__':unittest.main()

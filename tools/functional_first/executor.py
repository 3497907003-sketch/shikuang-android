#!/usr/bin/env python3
"""Actual bounded TEST executor. Local unit adapter is explicitly never device evidence."""
import argparse,hashlib,json,math,os,re,sys,time
from pathlib import Path
from bounded_capture import capture,not_attempted
from case_gate import validate_case,GateError
from terminal import parse_terminal
from protocol import CASES
from health import HealthError,basic,continuous,host_server,provider,package_paths,static_dependency,binary_meta,PROCESS_DUMP
from helper_gate import check_helper
from harvest import collect
from interruptions import interruption_reason,instrumentation_uncertain

FROZEN_SHA='4e91883a61c8663248bb62463616bc216637a5b20373a1571b67461c1f52bd0b'
SPECIMEN_APKS={'app.apk':'com.shikuang.app.preview','app-test.apk':'com.shikuang.app.preview.test','control.apk':'com.shikuang.control16k','control-test.apk':'com.shikuang.control16k.test','test-services-1.4.2.apk':'androidx.test.services'}
IMAGE={35:(5,'x86_64-ps16k-35_r05.zip',1696342085,'d709cf26b375abecfbbf5803afd20749ddfa2865'),36:(7,'x86_64-ps16k-36_r07.zip',1849428145,'dd783282e84bf475a02eba6777c79fc5695e1583')}
def sha(raw):return hashlib.sha256(raw).hexdigest()
def put(file,obj):
 with Path(file).open('x') as f:json.dump(obj,f,ensure_ascii=False,indent=2,allow_nan=False);f.write('\n')
def load(file):
 try:o=json.loads(Path(file).read_bytes())
 except (OSError,ValueError,UnicodeError):raise HealthError('invalid_required_metadata') from None
 return o

class Runner:
 def __init__(self,adb,serial,out,deadline,unit=None):
  self.adb=adb;self.serial=serial;self.out=Path(out);self.deadline=deadline;self.unit=Path(unit) if unit else None;self.ordinal=0;self.commands=[];self.interruption_observations=[]
  self.out.mkdir(mode=0o700);(self.out/'commands').mkdir()
  self.domain='unit_only_python_adapter_no_device' if unit else 'live_adb_test_candidate_root_review_pending'
 def command(self,label,args,timeout=20,cap=16*1024*1024,permit_short_budget=False,host=False):
  if not re.fullmatch(r'[A-Za-z0-9._-]+',label):raise ValueError('fixed command label required')
  self.ordinal+=1;leaf=self.out/'commands'/f'{self.ordinal:04d}-{label}'
  if not permit_short_budget and self.deadline-time.monotonic()<timeout+180:
   r=not_attempted(leaf,'budget_exhausted');raw,err=b'',b''
  else:
   if self.unit and not host:argv=[sys.executable,'-B',str(Path(__file__).with_name('unit_adapter.py')),str(self.unit),*args]
   else:argv=args if host else [self.adb,'-s',self.serial,*args]
   r=capture(argv,leaf,timeout_seconds=timeout,max_stream_bytes=cap);raw=(leaf/'stdout.bin').read_bytes();err=(leaf/'stderr.bin').read_bytes()
  r={**r,'relative_dir':str(leaf.relative_to(self.out)),'execution_domain':self.domain};self.commands.append({'label':label,**r})
  if not host:
   reason=interruption_reason(r,raw,err)
   if reason:self.interruption_observations.append({'label':label,'receipt':r['relative_dir'],'reason':reason,'guest_termination_confirmed':False})
  return r,raw,err
 def required(self,label,args,timeout=20):
  r,out,err=self.command(label,args,timeout)
  if not r['success']:raise HealthError('command_'+r['status'])
  if err.strip():raise HealthError('required_command_stderr_nonempty')
  return out


def bind_frozen(folder):
 p=Path(folder);raw=(p/'manifest.json').read_bytes()
 if sha(raw)!=FROZEN_SHA:raise HealthError('frozen_manifest_hash')
 m=json.loads(raw)
 if m.get('sourceSha')!='1c345718018ae0ffe657cb5a853adfedcddd11eb' or len(m.get('apks',[]))!=5:raise HealthError('frozen_source_contract')
 pins={}
 for row in m['apks']:
  f=p/row['name'];b=f.read_bytes()
  if len(b)!=row['bytes'] or sha(b)!=row['sha256']:raise HealthError('frozen_apk_bytes')
  pins[row['name']]=row
 for row in m['sourceFiles']:
  f=p/'source'/row['path'];b=f.read_bytes()
  if len(b)!=row['bytes'] or sha(b)!=row['sha256']:raise HealthError('frozen_java_or_protocol_bytes')
 return {'manifest_sha256':sha(raw),'source_sha':m['sourceSha'],'apk_pins':pins,'java_source_pins':[r for r in m['sourceFiles'] if r['path'].endswith('.java')],'new_build_or_signing':False}


def bind_image(runtime,sdk):
 v=load(Path(runtime)/'official-image-verification.json');installed=load(Path(runtime)/'installed-image-file-hashes.json');rev,archive,bytes_,sha1=IMAGE[sdk]
 expected={'package':f'system-images;android-{sdk};google_apis_ps16k;x86_64','revision':str(rev),'url':'https://dl.google.com/android/repository/sys-img/google_apis/'+archive,'bytes':bytes_,'sha1':sha1}
 if not isinstance(v,dict) or any(v.get(k)!=value for k,value in expected.items()) or not re.fullmatch(r'[a-f0-9]{64}',v.get('sha256','')):raise HealthError('official_image_receipt')
 if not isinstance(installed,list) or not installed or any(not isinstance(x,dict) or not isinstance(x.get('file'),str) or type(x.get('bytes')) is not int or x['bytes']<0 or not re.fullmatch(r'[a-f0-9]{64}',x.get('sha256','')) for x in installed):raise HealthError('installed_image_receipt')
 return {'official_verification_file_sha256':sha((Path(runtime)/'official-image-verification.json').read_bytes()),'installed_file_manifest_sha256':sha((Path(runtime)/'installed-image-file-hashes.json').read_bytes()),'scope':'unchanged official workflow independently checked archive+installed every file; this parser binds its actual receipts, not a replacement for those checks'}


def observe(runner,label,sdk,runtime,frozen):
 raw={};errors=[];parsed=None;targets=[];host=None
 try:
  # Actual host daemon PID + /proc start identity, no arbitrary command line dumped.
  host=load(runner.unit/'unit-host.json') if runner.unit else host_server()
  raw['state']=runner.required(label+'-state',['get-state'],15)
  from health import text
  if text(raw['state'])!='device\n':raise HealthError('transport_unavailable')
  calls={'boot_id':['shell','cat','/proc/sys/kernel/random/boot_id'],'uptime':['shell','cat','/proc/uptime'],'boot_completed':['shell','getprop','sys.boot_completed'],'sdk':['shell','getprop','ro.build.version.sdk'],'abi':['shell','getprop','ro.product.cpu.abi'],'page_size':['shell','getconf','PAGE_SIZE'],'fingerprint':['shell','getprop','ro.build.fingerprint'],'adbd_pid':['shell','pidof','adbd'],'system_server_pid':['shell','pidof','system_server'],'active_instrumentation':['shell',PROCESS_DUMP],'network':['shell','dumpsys','connectivity'],'airplane':['shell','cmd','connectivity','airplane-mode'],'crash':['logcat','-b','crash','-d','-v','threadtime']}
  for name,args in calls.items():
   try:raw[name]=runner.required(label+'-'+name,args,20)
   except HealthError as e:errors.append({'observation':name,'error':str(e)})
  if errors:raise HealthError('incomplete_required_health_commands')
  parsed=basic(raw,sdk)
  p=provider(runner.required(label+'-provider',['shell','dumpsys','webviewupdate']))
  package_dump=runner.required(label+'-provider-package',['shell','dumpsys','package',p['package']]);paths=package_paths(runner.required(label+'-provider-path',['shell','pm','path',p['package']]))
  targets=[{'role':'provider-package','package':p['package'],'remote':x} for x in paths]+static_dependency(package_dump)+[{'role':'art','remote':'/apex/com.android.art/lib64/libart.so'}]
  # Installed actual five APK bytes are re-bound to frozen bytes before each case.
  for name,pkg in SPECIMEN_APKS.items():
   apkpaths=package_paths(runner.required(label+'-'+name+'-path',['shell','pm','path',pkg]))
   if len(apkpaths)!=1:raise HealthError('frozen_installed_apk_split')
   targets.append({'role':'frozen-apk','package':pkg,'remote':apkpaths[0],'frozen_name':name})
  for i,t in enumerate(targets):
   meta=binary_meta(runner.required(label+f'-binary-{i}-size',['shell','stat','-c','%s',t['remote']],20),runner.required(label+f'-binary-{i}-sha',['shell','sha256sum',t['remote']],45),t['remote']);t.update(meta)
   if t['role']=='frozen-apk' and any(meta[k]!=frozen['apk_pins'][t['frozen_name']][k] for k in ('bytes','sha256')):raise HealthError('actual_installed_apk_hash_differs_frozen')
  helper_raw={'package_dump':runner.required(label+'-helper-package',['shell','dumpsys','package','androidx.test.services']),'query_dump':runner.required(label+'-helper-queries',['shell','dumpsys','package','queries']),'appops':runner.required(label+'-helper-appops',['shell','appops','get','androidx.test.services','MANAGE_EXTERNAL_STORAGE']),'install_stdout':(Path(runtime)/'helper-install-stdout.txt').read_bytes()}
  helper=check_helper(**{k:v.decode('utf8','strict') for k,v in helper_raw.items()})
  parsed.update(host_server=host,provider=p,binary_targets=targets,helper_identity=helper,health_domain=runner.domain)
 except (HealthError,AssertionError,UnicodeError,OSError,ValueError,KeyError,IndexError) as e:
  errors.append({'observation':'health_identity_gate','error':str(e)[:160] if isinstance(e,HealthError) else type(e).__name__})
 out={'label':label,'eligible':not errors and parsed is not None,'observed':parsed,'errors':errors,'execution_domain':runner.domain,'guest_termination_confirmed_by_host_timeout':False,'raw_source_receipts':[r['relative_dir'] for r in runner.commands if r['label'].startswith(label+'-')]}
 put(runner.out/(label+'.json'),out);return out


def interrupted_guest_uncertain(receipt,out,err):
 return instrumentation_uncertain(receipt,out,err)

def selected_cases(diagnostic_app_only=False):
 if type(diagnostic_app_only) is not bool:raise ValueError('exact_diagnostic_boolean_required')
 return ('app',) if diagnostic_app_only else ('control','app')

def run(args):
 diagnostic=getattr(args,'diagnostic_app_only',False);case_order=selected_cases(diagnostic)
 if diagnostic and args.unit_fixture:raise ValueError('app_only_diagnostic_requires_live_run')
 if args.sdk not in IMAGE or not re.fullmatch(r'emulator-[0-9]{4,5}',args.serial):raise ValueError('fixed sdk/exact emulator serial required')
 clock=load(args.clock);now=time.monotonic();start=clock.get('started_monotonic_ns')
 if not args.unit_fixture:
  from job_clock import derive
  if not isinstance(clock,dict) or clock.get('authoritative_job_start_verified') is not True:raise ValueError('authoritative_job_clock_unverified_no_case')
  raw_clock=Path(args.clock).with_suffix('.response.bin').read_bytes()
  rebound=derive(raw_clock,clock.get('public_server_date'),clock.get('repository'),clock.get('run_id'),clock.get('run_attempt'),clock.get('job_name'),clock.get('request_before_monotonic_ns'),clock.get('request_after_monotonic_ns'),clock.get('public_api_request_url'),clock.get('public_api_response_url'))
  if rebound!=clock:raise ValueError('public_job_clock_byte_binding_mismatch')
 if type(start) is not int or start<0 or now*1e9<start or now-start/1e9>3600:raise ValueError('actual same host monotonic job clock required')
 deadline=start/1e9+3000
 runner=Runner(args.adb,args.serial,args.out,deadline,args.unit_fixture)
 report={'schema':'functional-first-executor-result-v1','execution_domain':runner.domain,'cases':{},'forensics':{'status':'not_attempted'},'experiment_protocol_accepted':False,'root_cause_closed':False,'production_stability_accepted':False,'new_build_or_signing':False,'genuine_device_claim':False,'root_visual_review_required':True,'job_clock_sha256':sha(Path(args.clock).read_bytes()),'job_clock_input_file':str(args.clock),'job_clock_original_response_sha256':sha(raw_clock) if not args.unit_fixture else None,'job_clock_original_response_file':str(Path(args.clock).with_suffix('.response.bin')) if not args.unit_fixture else None,'first_training_or_kappa_claim':False,'unit_scope':bool(args.unit_fixture)}
 report.update(experiment_case_selection='app_only_diagnostic' if diagnostic else 'comparison',diagnostic_app_only=diagnostic)
 fatal=None;baseline=None;open_failure=False
 try:
  if args.unit_fixture:
   report['frozen_gate']=bind_frozen(args.frozen)
  else:
   from current_artifact import bind_current
   report['frozen_gate']=bind_current(args.frozen,args.expected_manifest_sha,args.expected_source_sha,args.expected_web_sync_sha,Path(__file__).resolve().parents[2],report['experiment_case_selection'])
   report.update(artifact_source_kind='new_current_r9_same_run_test_build',new_build_or_signing=True)
  report['image_gate']=bind_image(args.runtime,args.sdk)
  if not args.unit_fixture:
   for name,path in [('adb',args.adb),('emulator',args.emulator)]:
    f=Path(path)
    if not f.is_absolute() or not f.is_file():raise HealthError('actual_host_tool_file_missing')
    report[name+'_tool']={'path':str(f),'bytes':f.stat().st_size,'sha256':sha(f.read_bytes())}
   runner.command('host-adb-version',[args.adb,'version'],15,host=True)
   runner.command('host-adb-server-status',[args.adb,'server-status'],15,host=True)
  for case in case_order:
   row={'status':'not_attempted','functional_observed':False,'case_structure':'not_attempted','harvest_required_complete':False,'guest_terminated_by_host_kill_claim':False,'post_identity_verified':False};report['cases'][case]=row
   if open_failure or runner.interruption_observations:row['reason']='previous_host_timeout_transport_platform_or_identity_failure';open_failure=True;continue
   h=observe(runner,'pre-'+case,args.sdk,args.runtime,report['frozen_gate']);row['pre_health']=h['label']+'.json'
   if not h['eligible']:row['reason']='fresh_health_identity_failed';open_failure=True;continue
   if baseline:
    try:continuous(baseline,h['observed'])
    except HealthError:row['reason']='identity_segment_changed_new_authorization_required';open_failure=True;continue
   else:baseline=h['observed']
   if runner.deadline-time.monotonic()<960+150+180:row['reason']='budget_exhausted_original960s_case_not_shortened';continue
   spec=CASES[case];r,out,err=runner.command(case+'-instrumentation',['shell','am','instrument','-w','-r','-e','useTestStorageService','true','-e','expectedSdk',str(args.sdk),'-e','class',spec['test_class'],spec['runner']],960)
   row.update(status='failed',instrumentation_receipt=r['relative_dir'],host_command_status=r['status'],host_process_reaped=r.get('host_process_reaped'))
   terminal=False
   try:
    if not r['success']:raise GateError('instrumentation_host_command_failed')
    parse_terminal(out,err,GateError);terminal=True
   except GateError as e:row['terminal_error']=str(e)
   # Immediately harvest small core/PNG/JSON before all connection and system binary transfers.
   hv=collect(runner,case,runner.out/(case+'-evidence'),terminal,require_final_state=diagnostic);row['harvest_manifest']=case+'-evidence/harvest-manifest.json';row['harvest_required_complete']=hv['required_complete'];row['harvest_required_missing']=hv['required_missing'];row['harvest_transport_or_host_interruption']=hv['transport_or_host_interruption']
   row['harvest_guest_client_crash_observed']=hv.get('guest_client_crash_observed',False)
   row['harvest_required_file_count']=hv['required_success_files']
   if hv['transport_or_host_interruption'] or row['harvest_guest_client_crash_observed']:open_failure=True
   if terminal:
    try:
     structure=validate_case(runner.out/(case+'-evidence'),case,args.sdk,runner.out/r['relative_dir']);put(runner.out/(case+'-structure.json'),structure);row['case_structure']=structure['status'];row['all_inputs_unobscured']=structure['all_observed_inputs_unobscured']
     if diagnostic:
      from app_diagnostic_gate import validate_geometry
      row['diagnostic_geometry']=validate_geometry(runner.out/(case+'-evidence'),case);put(runner.out/(case+'-diagnostic-geometry.json'),row['diagnostic_geometry']);row['all_inputs_unobscured']=row['diagnostic_geometry']['all_nine_geometries_verified']
     if hv['required_complete']:row.update(status='unit_only_structure_and_harvest_complete' if args.unit_fixture else 'fully_observed_pending_root_visual_review',functional_observed=not bool(args.unit_fixture),software_structure_and_harvest_complete=True)
    except (GateError,ValueError,KeyError,TypeError) as e:row['structure_error']=str(e)[:160]
   post=observe(runner,'post-'+case,args.sdk,args.runtime,report['frozen_gate']);row['post_health']=post['label']+'.json'
   if not post['eligible']:open_failure=True;row['post_identity_failed']=True
   else:
    try:continuous(baseline,post['observed'])
    except HealthError:open_failure=True;row['post_identity_failed']=True
    else:row['post_identity_verified']=True
   # host kill/reaped is not guest termination. Any interruption/abort blocks subsequent case.
   if interrupted_guest_uncertain(r,out,err) or runner.interruption_observations:open_failure=True
   row['instrumentation_transport_or_host_interruption']=interrupted_guest_uncertain(r,out,err)
  # Identity/functional findings are preserved independently even when binary forensic fails.
  if baseline and not open_failure and not runner.interruption_observations:
   from forensics import capture_forensics
   report['forensics']=capture_forensics(runner,baseline,args.sdk_root)
  else:report['forensics']={'status':'not_attempted','reason':'transport_platform_or_identity_unverified'}
 except (HealthError,OSError,ValueError,KeyError,TypeError) as e:
  fatal={'type':type(e).__name__,'code':str(e)[:160]};report['fatal_error']=fatal
 finally:
  if not args.unit_fixture:
   for label,cmd in [('host-processes-final',['ps','-eo','pid,ppid,lstart,comm']),('host-memory-final',['free','-m']),('host-disk-final',['df','-h']),('host-uptime-final',['cat','/proc/uptime'])]:
    runner.command(label,cmd,10,host=True)
  report['persistent_guest_uncertainty_observations']=runner.interruption_observations;report['guest_termination_confirmed_by_host_timeout']=False
  if runner.interruption_observations:open_failure=True
  report['commands']=runner.commands;report['remaining_job_seconds']=max(0,runner.deadline-time.monotonic());report['physical_device_cases']=0;report['live_guest_case_commands']=0 if args.unit_fixture else sum('instrumentation_receipt' in r for r in report['cases'].values());report['unit_case_commands']=sum('instrumentation_receipt' in r for r in report['cases'].values()) if args.unit_fixture else 0
  report['software_path_both_structure_harvest_complete']=len(report['cases'])==2 and all(r.get('software_structure_and_harvest_complete') for r in report['cases'].values());report['functional_both_fully_observed']=not bool(args.unit_fixture) and len(report['cases'])==2 and all(r['functional_observed'] for r in report['cases'].values())
  report['complete_candidate_evidence']=report['functional_both_fully_observed'] and report['forensics']['status']=='complete_verified' and not fatal and not open_failure
  report['all_observed_inputs_unobscured']=len(report['cases'])==2 and all(r.get('all_inputs_unobscured') is True for r in report['cases'].values())
  if diagnostic:report['all_observed_inputs_unobscured']=set(report['cases'])=={'app'} and report['cases']['app'].get('all_inputs_unobscured') is True
  report['new_ci_dispatches']=0;report['retries']=0;report['active_reconnects']=0;report['reboot_or_force_stop_after_cases']=0
  report['complete_app_only_diagnostic_evidence']=False
  if diagnostic:
   from app_diagnostic_gate import validate as validate_app_diagnostic
   report['complete_app_only_diagnostic_evidence']=True
   report['complete_app_only_diagnostic_evidence']=not fatal and not open_failure and validate_app_diagnostic(report)
  put(runner.out/'executor-report.json',report)
 return report

def main():
 p=argparse.ArgumentParser();p.add_argument('--sdk',type=int,required=True);p.add_argument('--serial',required=True);p.add_argument('--adb',required=True);p.add_argument('--emulator',required=True);p.add_argument('--sdk-root',required=True);p.add_argument('--clock',required=True);p.add_argument('--frozen',required=True);p.add_argument('--runtime',required=True);p.add_argument('--out',required=True);p.add_argument('--unit-fixture');p.add_argument('--expected-manifest-sha');p.add_argument('--expected-source-sha');p.add_argument('--expected-web-sync-sha');p.add_argument('--diagnostic-app-only',action='store_true')
 args=p.parse_args()
 try:r=run(args)
 except (OSError,ValueError,TypeError,KeyError,AttributeError) as e:
  output=Path(args.out)
  if output.exists():raise
  output.mkdir(mode=0o700);r={'schema':'functional-first-executor-result-v1','execution_domain':'unit_only_python_adapter_no_device' if args.unit_fixture else 'live_adb_test_candidate_root_review_pending','cases':{case:{'status':'not_attempted','reason':'preflight_or_clock_rejected'} for case in selected_cases(args.diagnostic_app_only)},'complete_candidate_evidence':False,'complete_app_only_diagnostic_evidence':False,'experiment_case_selection':'app_only_diagnostic' if args.diagnostic_app_only else 'comparison','diagnostic_app_only':args.diagnostic_app_only,'experiment_protocol_accepted':False,'fatal_error':{'type':type(e).__name__,'code':'controlled_preflight_rejection'},'unit_scope':bool(args.unit_fixture),'genuine_device_claim':False};put(output/'executor-report.json',r)
 print(json.dumps({'result_file':str(Path(args.out)/'executor-report.json'),'unit_only':bool(args.unit_fixture),'experiment_case_selection':r['experiment_case_selection'],'complete_candidate_evidence':r['complete_candidate_evidence'],'complete_app_only_diagnostic_evidence':r.get('complete_app_only_diagnostic_evidence',False),'experiment_protocol_accepted':False,'case_statuses':{k:x['status'] for k,x in r['cases'].items()}}));return 0 if args.unit_fixture and not r.get('fatal_error') or r['complete_candidate_evidence'] or r.get('complete_app_only_diagnostic_evidence') else 2
if __name__=='__main__':sys.exit(main())

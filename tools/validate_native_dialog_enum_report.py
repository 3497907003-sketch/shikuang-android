"""Future diagnostic-only staging/whole-small-artifact validator. No networking.
Default no-op. Never prints rejected input, dynamic fields, labels or exceptions.
"""
from pathlib import Path
import hashlib,io,json,os,re,struct,sys,zipfile
NAME='native-dialog-enum-report.json';CAP=65536;ZIP_CAP=131072
COMPONENTS={'android_framework','android_systemui','google_messaging','play_services','webview','permission_controller','this_app','unknown'}
RESOURCES={'aerr_restart','aerr_app_info','aerr_close','aerr_report','aerr_mute','aerr_wait'}
PRODUCERS={'observer':'android/app/src/androidTest/java/com/shikuang/app/NativeDialogDiagnostic.java','gate':'android/app/src/androidTest/java/com/shikuang/app/MineralEngineInstrumentedTest.java','diagnostic_case':'android/app/src/androidTest/java/com/shikuang/app/NativeDialogEnumDiagnosticTest.java','output_service':'android/app/src/androidTest/java/com/shikuang/app/RuntimeTestOutput.java','validator':'tools/validate_native_dialog_enum_report.py'}
def need(v):
 if not v:raise ValueError('finite_diagnostic_shape_rejected')
def sha(b):return hashlib.sha256(b).hexdigest()
def unique(pairs):
 d={}
 for k,v in pairs:need(k not in d);d[k]=v
 return d
def decode(raw):
 need(0<len(raw)<=CAP)
 try:return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('finite_diagnostic_shape_rejected')))
 except (UnicodeError,json.JSONDecodeError):raise ValueError('finite_diagnostic_shape_rejected') from None
def integer(v,limit):return type(v)is int and 0<=v<=limit
def focus(v):return v is None or type(v)is bool
def report(d,head,nonce):
 need(re.fullmatch('[a-f0-9]{40}',head) and re.fullmatch('[a-f0-9]{32}',nonce))
 need(type(d)is dict and set(d)=={'schema','source_sha_argument','diagnostic_nonce','gate_passed','gate_observation_count','last_gate_webview_focus','first_mismatch_tree','dialog_cause_or_current_identity_established','release_acceptance'})
 need(d['schema']=='android-native-dialog-finite-enums-v1' and d['source_sha_argument']==head and d['diagnostic_nonce']==nonce and type(d['gate_passed'])is bool and integer(d['gate_observation_count'],256) and focus(d['last_gate_webview_focus']) and d['dialog_cause_or_current_identity_established'] is d['release_acceptance'] is False)
 need(not d['gate_passed'] or d['last_gate_webview_focus'] is True and d['gate_observation_count']>0)
 t=d['first_mismatch_tree'];need(type(t)is dict and set(t)=={'completed','stop','nodes_visited','root_component','webview_focus','node_component_counts','error_resource_enum_counts','system_error_controls_observed','title_comparison_performed','title_component','title_match_state'})
 need(type(t['completed'])is bool and t['stop'] in {'complete','node_cap','time_cap','ipc_timeout','exception','not_observed'} and integer(t['nodes_visited'],200) and t['root_component'] in COMPONENTS and focus(t['webview_focus']))
 for field,keys in [('node_component_counts',COMPONENTS),('error_resource_enum_counts',RESOURCES)]:need(type(t[field])is dict and set(t[field])<=keys and all(integer(v,200) for v in t[field].values()))
 need(sum(t['node_component_counts'].values())==t['nodes_visited'] and sum(t['error_resource_enum_counts'].values())<=t['nodes_visited'])
 need(type(t['system_error_controls_observed'])is type(t['title_comparison_performed'])is bool and t['title_component'] in COMPONENTS and t['title_match_state'] in {'none','unique','ambiguous'})
 controls=t['root_component']=='android_framework' and t['error_resource_enum_counts'].get('aerr_close',0)>0 and sum(t['error_resource_enum_counts'].values())>=2
 need(t['system_error_controls_observed']==controls)
 need(not t['title_comparison_performed'] or controls)
 need((t['title_match_state']=='unique')==(t['title_component']!='unknown'))
 need(t['title_match_state']=='none' or t['title_comparison_performed'])
 return d
def envelope(d,head,nonce,run_id,expected_producer_pins=None,expected_workflow_sha=None):
 need(type(d)is dict and set(d)=={'schema','run','producer_sha256','workflow_sha256','enum_report'})
 need(type(run_id)is int and 0<run_id<2**64 and type(d['run'])is dict and all(type(d['run'].get(k))is int for k in ['run_id','attempt','api','page_size']))
 need(d['schema']=='android-native-dialog-finite-artifact-v1' and d['run']=={'head_sha':head,'nonce':nonce,'run_id':run_id,'attempt':1,'event':'workflow_dispatch','api':35,'page_size':4096})
 need(type(d['producer_sha256'])is dict and set(d['producer_sha256'])==set(PRODUCERS) and all(type(v)is str and re.fullmatch('[a-f0-9]{64}',v) for v in d['producer_sha256'].values()))
 if expected_producer_pins is not None:need(d['producer_sha256']==expected_producer_pins)
 need(type(d['workflow_sha256'])is str and re.fullmatch('[a-f0-9]{64}',d['workflow_sha256']))
 if expected_workflow_sha is not None:need(d['workflow_sha256']==expected_workflow_sha)
 report(d['enum_report'],head,nonce);return d
def small_archive(raw,head,nonce,run_id,expected_producer_pins,expected_workflow_sha):
 need(22<=len(raw)<=ZIP_CAP and raw[-22:-18]==b'PK\x05\x06')
 sig,disk,cd_disk,n_disk,n,cd_size,offset,comment=struct.unpack('<4s4H2LH',raw[-22:]);need(disk==cd_disk==comment==0 and n_disk==n==1 and offset+cd_size==len(raw)-22)
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  infos=z.infolist();need(len(infos)==1);i=infos[0];need(i.filename==NAME and not i.is_dir() and i.flag_bits&0x41==0 and i.compress_type in {0,8} and 0<i.file_size<=CAP and 0<i.compress_size<=CAP)
  with z.open(i) as f:b=f.read(CAP+1)
  need(len(b)==i.file_size<=CAP) # zipfile enforces CRC on complete read.
 return envelope(decode(b),head,nonce,run_id,expected_producer_pins,expected_workflow_sha)
def main():
 if len(sys.argv)==1:print('disabled_future_targeted_diagnostic_staging_only');return
 try:
  need(len(sys.argv)==5 and sys.argv[1]=='--stage-root');root=Path(sys.argv[2]);head,nonce=sys.argv[3:];need(os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and os.environ.get('GITHUB_RUN_ATTEMPT')=='1' and os.environ.get('GITHUB_SHA')==head and re.fullmatch('[0-9]{1,20}',os.environ.get('GITHUB_RUN_ID','')))
  files=list(root.rglob(NAME));need(len(files)==1);p=files[0];need(not any(q.is_symlink() for q in [p,*p.parents]))
  with p.open('rb') as f:d=report(decode(f.read(CAP+1)),head,nonce)
  cwd=Path.cwd();pins={k:sha((cwd/v).read_bytes()) for k,v in PRODUCERS.items()}
  workflow_sha=sha((cwd/'.github/workflows/android-runtime.yml').read_bytes())
  data={'schema':'android-native-dialog-finite-artifact-v1','run':{'head_sha':head,'nonce':nonce,'run_id':int(os.environ['GITHUB_RUN_ID']),'attempt':1,'event':'workflow_dispatch','api':35,'page_size':4096},'producer_sha256':pins,'workflow_sha256':workflow_sha,'enum_report':d};envelope(data,head,nonce,int(os.environ['GITHUB_RUN_ID']),pins,workflow_sha)
  b=(json.dumps(data,sort_keys=True,separators=(',',':'))+'\n').encode();need(len(b)<=CAP);out=cwd/'diagnostic-upload';out.mkdir(exist_ok=False)
  with (out/NAME).open('xb') as f:f.write(b)
  print(json.dumps({'safe_staging_complete':True,'bytes':len(b),'sha256':sha(b),'release_acceptance':False}))
 except Exception:print('finite_diagnostic_staging_rejected');raise SystemExit(1) from None
if __name__=='__main__':main()

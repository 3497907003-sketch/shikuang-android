"""Finite names from unchanged Java; successful structure is not harvest completion."""
import hashlib,json,re,time
from pathlib import Path
from protocol import CASES,PHASES
from case_gate import check_png,GateError
from interruptions import interruption_reason

def stem_files(stem):return [stem+'.json',stem+'.png']
def dump_files(stem):return [stem+'-input-method.txt',stem+'-window.txt',stem+'-hard-keyboard-setting.txt']
def names(case):
 p=CASES[case]['prefix'];core=[p+'-report.json',p+'-progress.json'];visual=[];diagnostics=[];connections=[];failures=[]
 for view in ('identify','library','records'):
  for state in ('ime-visible','composing','after-touch'):
   stem=p+'-'+view+'-'+state;visual+=stem_files(stem);diagnostics+=dump_files(stem)
 for cycle in range(12):
  if cycle%4==0:continue
  for phase in PHASES:connections += [f'{p}-connection-{cycle}-{phase}.json',f'{p}-connection-result-{cycle}-{phase}.json']
  for failure in ('route','bounds','ime','compose'):
   stem=f'{p}-{failure}-failure-{cycle}';failures+=stem_files(stem)+dump_files(stem)
 required=core+visual+connections+diagnostics+[p+'-final.png']
 assert len(required)==102 and len(set(required+failures))==282
 return {'core':core,'visual':visual,'connections':connections,'diagnostics':diagnostics,'required':required,'optional_failure':failures}

def priority(case,progress=None,terminal_success=False):
 x=names(case);p=CASES[case]['prefix'];current=[]
 if not terminal_success:
  cycle=progress.get('cycle') if isinstance(progress,dict) else None
  if type(cycle) is int and cycle in range(12) and cycle%4:
   for failure in ('route','bounds','ime','compose'):current+=stem_files(f'{p}-{failure}-failure-{cycle}')
  else:current=[n for n in x['optional_failure'] if n.endswith(('.json','.png'))]
 ordered=x['core']+x['visual']+current+x['connections']+x['diagnostics']+[p+'-final.png']
 if not terminal_success:ordered+=x['optional_failure']
 return list(dict.fromkeys(ordered))

def validate_payload(name,raw):
 if not isinstance(raw,bytes) or not raw:raise GateError('empty_harvest_payload')
 if name.endswith('.png'):return check_png(raw)
 if name.endswith('.json'):
  try:o=json.loads(raw)
  except (ValueError,UnicodeError):raise GateError('harvest_invalid_json') from None
  if not isinstance(o,dict):raise GateError('harvest_json_object_required')
  return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
 try:s=raw.decode('utf8','strict')
 except UnicodeError:raise GateError('harvest_invalid_text') from None
 if not s.endswith('\n') or any(t in s for t in ('Error while accessing provider','No result found','FileNotFoundException','Permission Denial')):raise GateError('harvest_invalid_dump')
 return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}

def collect(runner,case,folder,terminal_success):
 folder=Path(folder);folder.mkdir();allowed=names(case);results=[];downloaded={};progress=None
 deadline=min(time.monotonic()+150,runner.deadline-180);total=0;done=set();transport_uncertain=False
 # Two core first; then update finite priority from actual progress if parsable.
 queue=allowed['core'][:]
 while queue:
  name=queue.pop(0)
  if name in done:continue
  done.add(name);required=name in allowed['required']
  row={'file':name,'required_after_success':required,'source':'exact helper output authority content URI, no directory guessing or recursive pull'}
  if transport_uncertain:
   row.update(status='not_attempted',reason='prior_harvest_transport_or_host_interruption')
  elif time.monotonic()>=deadline or total>=128*1024*1024:
   row.update(status='not_attempted',reason='case_harvest_budget_exhausted')
  else:
   timeout=min(10,deadline-time.monotonic());cap=min(16*1024*1024,128*1024*1024-total)
   r,raw,err=runner.command('harvest-'+case+'-'+name,['exec-out','content','read','--uri','content://androidx.test.services.storage.outputfiles/'+name],timeout,cap,permit_short_budget=True)
   row['command_receipt']=r['relative_dir'];row['command_status']=r['status'];total+=r.get('streams',{}).get('stdout',{}).get('bytes_read',0)
   gap=interruption_reason(r,raw,err)
   if gap:transport_uncertain=True;row['interruption_reason']=gap
   if not r.get('success'):row.update(status='failed',reason='harvest_command_failed')
   else:
    try:
     meta=validate_payload(name,raw);(folder/name).write_bytes(raw);row.update(status='collected',**meta);downloaded[name]=meta
     if name.endswith('-progress.json'):
      progress=json.loads(raw)
      # Actual Java records cycle inside latest event, not a guessed top-level supplied field.
      if isinstance(progress.get('events'),list) and progress['events'] and isinstance(progress['events'][-1],dict):progress={**progress,'cycle':progress['events'][-1].get('cycle')}
    except GateError as e:row.update(status='failed',reason=str(e))
  results.append(row)
  if name==allowed['core'][-1]:queue+=priority(case,progress,terminal_success)[2:]
 for name in allowed['required']+allowed['optional_failure']:
  if name not in done:results.append({'file':name,'required_after_success':name in allowed['required'],'status':'not_attempted','reason':'failure_evidence_not_expected_after_terminal_success' if terminal_success else 'case_harvest_budget_exhausted'})
 missing=[n for n in allowed['required'] if n not in downloaded]
 out={'schema':'finite-harvest-result-v1','case':case,'required_success_files':102,'optional_failure_files':180,'results':results,'bytes_read':total,'required_missing':missing,'required_complete':not missing,'all282_names_accounted':len(results)==282,'transport_or_host_interruption':transport_uncertain,'guest_termination_confirmed':False,'genuine_device_claim':False}
 (folder/'harvest-manifest.json').write_text(json.dumps(out,indent=2)+'\n');return out

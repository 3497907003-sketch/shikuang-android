#!/usr/bin/env python3
"""Public GitHub job started_at -> conservative host monotonic deadline; no token access.

Called only by a future root-reviewed CI. Unit tests pass supplied synthetic API
bytes separately; this module has not requested any actual workflow/job here.
"""
import datetime,email.utils,hashlib,json,os,re,sys,time,urllib.request
from pathlib import Path

def endpoint(repo,run_id,attempt):
 if not isinstance(repo,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo) or not isinstance(run_id,str) or not re.fullmatch(r'[0-9]{1,20}',run_id) or type(attempt) is not int or not 1<=attempt<=9999:raise ValueError('fixed_public_job_identity')
 return f'https://api.github.com/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100'

def derive(raw,date,repo,run_id,attempt,job_name,before_ns,after_ns,request_url,response_url):
 expected_url=endpoint(repo,run_id,attempt)
 if request_url!=expected_url or response_url!=expected_url:raise ValueError('attempt_endpoint_binding')
 if not isinstance(job_name,str) or not re.fullmatch(r'shikuang-current-r9-functional-first-(35-r05|36-r07)',job_name):raise ValueError('fixed_job_name')
 if not isinstance(raw,bytes) or len(raw)>1024*1024:raise ValueError('public_job_body_cap')
 try:data=json.loads(raw);server=email.utils.parsedate_to_datetime(date)
 except (ValueError,TypeError,UnicodeError):raise ValueError('invalid_public_job_response') from None
 if not isinstance(data,dict) or not isinstance(data.get('jobs'),list) or type(data.get('total_count')) is not int or not 0<=data['total_count']<=100 or len(data['jobs'])!=data['total_count']:raise ValueError('job_page_incomplete')
 # Official attempt-list example has no run_attempt field. The exact requested
 # and final HTTPS endpoint binds the attempt; if the field exists, it must agree.
 jobs=[j for j in data['jobs'] if isinstance(j,dict) and j.get('name')==job_name and j.get('status')=='in_progress' and str(j.get('run_id'))==run_id and ('run_attempt' not in j or type(j['run_attempt']) is int and j['run_attempt']==attempt)]
 if len(jobs)!=1:raise ValueError('unique_current_job_not_found')
 if type(jobs[0].get('id')) is not int or jobs[0]['id']<=0 or not isinstance(jobs[0].get('started_at'),str):raise ValueError('job_id_or_start_type')
 try:start=datetime.datetime.fromisoformat(jobs[0]['started_at'].replace('Z','+00:00'));elapsed=(server-start).total_seconds()
 except (ValueError,TypeError,KeyError):raise ValueError('job_start_timestamp') from None
 if not 0<=elapsed<=3000 or type(before_ns) is not int or type(after_ns) is not int or not 0<before_ns<=after_ns:raise ValueError('job_clock_range')
 # Date rounds to seconds. Use request-start monotonic and subtract2 seconds,
 # never granting a later deadline from network latency or second granularity.
 mapped_start=before_ns-int((elapsed+2)*1e9)
 return {'schema':'authoritative-public-job-monotonic-clock-v1','started_monotonic_ns':mapped_start,'job_started_at_utc':jobs[0]['started_at'],'job_id':jobs[0]['id'],'repository':repo,'run_id':run_id,'run_attempt':attempt,'job_name':job_name,'public_api_request_url':request_url,'public_api_response_url':response_url,'attempt_identity_basis':'exact attempt-specific HTTPS request and final response URL; optional job run_attempt must agree','public_api_body_sha256':hashlib.sha256(raw).hexdigest(),'public_server_date':date,'request_before_monotonic_ns':before_ns,'request_after_monotonic_ns':after_ns,'authoritative_job_start_verified':True,'clock_scope':'actual public GitHub current-job started_at via HTTPS plus server Date, conservative request-start mapping minus2seconds','job_limit_seconds':3000,'no_secret_or_auth_token_read':True,'full_identity_root_review_still_required':True}

def main():
 file=Path(sys.argv[1]);repo=os.environ.get('GITHUB_REPOSITORY','');run=os.environ.get('GITHUB_RUN_ID','');attempt_s=os.environ.get('GITHUB_RUN_ATTEMPT','');job_name=sys.argv[2]
 if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo) or not re.fullmatch(r'[0-9]{1,20}',run) or not re.fullmatch(r'[0-9]{1,4}',attempt_s) or not re.fullmatch(r'shikuang-current-r9-functional-first-(35-r05|36-r07)',job_name):raise ValueError('fixed_public_job_identity')
 url=endpoint(repo,run,int(attempt_s));before=time.monotonic_ns();raw=b'';date=None;error=None
 try:
  req=urllib.request.Request(url,headers={'Accept':'application/vnd.github+json','User-Agent':'Shikuang-Private-Test-Budget','X-GitHub-Api-Version':'2022-11-28'})
  with urllib.request.urlopen(req,timeout=20) as response:
   raw=response.read(1024*1024+1);date=response.headers.get('Date');response_url=response.geturl()
  after=time.monotonic_ns();clock=derive(raw,date,repo,run,int(attempt_s),job_name,before,after,url,response_url)
 except (OSError,ValueError,TypeError) as e:
  error=type(e).__name__;clock={'authoritative_job_start_verified':False,'clock_scope':'public API unavailable or unverified; no case may start','error_type':error,'no_secret_or_auth_token_read':True}
 for path,data in [(file.with_suffix('.response.bin'),raw),(file,(json.dumps(clock,indent=2)+'\n').encode())]:
  with path.open('xb') as f:f.write(data)
 print(json.dumps({'job_clock_verified':not error,'file':str(file),'no_device_commands':True,'no_ci_dispatch':True}));return 0 if not error else 2
if __name__=='__main__':sys.exit(main())

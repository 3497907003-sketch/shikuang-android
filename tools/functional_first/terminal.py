"""Exact complete AndroidX terminal, stdout/stderr remain separately bound."""
import hashlib,re
from pathlib import Path
from interruptions import interruption_reason

def parse_terminal(stdout,stderr,Error=ValueError):
 def reject(code):raise Error(code)
 if not isinstance(stdout,bytes) or not isinstance(stderr,bytes):reject('terminal_bytes_required')
 try:out=stdout.decode('utf8','strict');err=stderr.decode('utf8','strict')
 except UnicodeError:reject('terminal_invalid_utf8')
 if '\0' in out+err:reject('terminal_invalid_nul')
 if not out.endswith('\n'):reject('terminal_truncated')
 markers=('INSTRUMENTATION_ABORTED','INSTRUMENTATION_FAILED','FAILURES!!!','Process crashed','device offline','no devices/emulators found')
 if any(x in out or x in err for x in markers) or interruption_reason({'status':'success'},stdout,stderr):reject('terminal_failure_marker')
 # A terminal embedded in stderr, a prefix -10, extra suffix or duplicate never qualifies.
 if err.count('INSTRUMENTATION_CODE') or out.count('INSTRUMENTATION_CODE')!=1:reject('terminal_count')
 lines=out.splitlines(keepends=True)
 codes=[line for line in lines if 'INSTRUMENTATION_CODE' in line]
 if codes!=['INSTRUMENTATION_CODE: -1\n'] and codes!=['INSTRUMENTATION_CODE: -1\r\n']:reject('terminal_exact_code')
 ok=[line for line in lines if re.fullmatch(r'OK \(1 test\)\r?\n',line)]
 if len(ok)!=1:reject('terminal_exact_junit_success')
 if lines.index(ok[0])>lines.index(codes[0]):reject('terminal_success_order')
 return {'terminal_code':-1,'unique_complete_stdout_terminal':True,'stderr_failure_checked':True,'genuine_device_claim':False}

def verify_command_terminal(folder,receipt,Error=ValueError):
 from case_gate import read_regular
 def need(condition,code):
  if not condition:raise Error(code)
 need(isinstance(receipt,dict) and receipt.get('success') is True and type(receipt.get('return_code')) is int and receipt['return_code']==0 and receipt.get('timed_out') is False and receipt.get('status')=='success','instrumentation_command_not_success')
 streams=receipt.get('streams');need(isinstance(streams,dict),'instrumentation_streams_object');raw={}
 for name in ('stdout','stderr'):
  meta=streams.get(name);need(isinstance(meta,dict) and meta.get('file')==name+'.bin' and meta.get('truncated') is False,'instrumentation_stream_metadata')
  b=read_regular(folder,name+'.bin',16*1024*1024)
  need(type(meta.get('bytes_retained')) is int and meta['bytes_retained']==len(b) and meta.get('sha256')==hashlib.sha256(b).hexdigest(),'instrumentation_stream_hash')
  raw[name]=b
 return parse_terminal(raw['stdout'],raw['stderr'],Error)

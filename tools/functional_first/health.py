"""Parse completed raw observations. No supplied health booleans grant access."""
import hashlib,math,os,re
from pathlib import Path

PROCESS_DUMP="dumpsys activity processes; shikuang_dump_rc=$?; printf '\\n__SHIKUANG_PROCESS_DUMP_COMPLETE__:%s\\n' \"$shikuang_dump_rc\""
PREFIXES=('/data/app/','/product/app/','/system/app/','/system_ext/app/','/apex/')
class HealthError(ValueError):pass

def need(value,code):
 if not value:raise HealthError(code)

def text(raw):
 try:s=raw.decode('utf8','strict')
 except (AttributeError,UnicodeError):raise HealthError('invalid_raw_utf8') from None
 need(s.endswith('\n') and '\0' not in s,'truncated_or_nul');return s.replace('\r\n','\n')

def no_active_instrumentation(raw):
 s=text(raw)
 header='ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)'
 need(s.count(header)==1 and s.count('__SHIKUANG_PROCESS_DUMP_COMPLETE__:')==1,'process_dump_header_or_complete_count')
 need(s.endswith('\n__SHIKUANG_PROCESS_DUMP_COMPLETE__:0\n'),'process_dump_not_completed')
 need(s.splitlines()[0]==header,'process_dump_not_unfiltered_header')
 need(not re.search(r'(?im)^\s*(?:Active instrumentation:|Instrumentation #)',s),'active_instrumentation_present')
 need(not any(v in s for v in ('Permission Denial','Unknown command','INSTRUMENTATION_ABORTED','Exception:')),'process_dump_error')
 return {'no_active_instrumentation_observed':True,'basis':'official Android15/16 ProcessList.dumpProcessesLSP invokes unfiltered AMS.dumpActiveInstruments; host completed stream and fixed remote completion sentinel','guest_termination_proven_by_host_kill':False,'device_format_runtime_validated':False}

def remote_path(value):
 need(isinstance(value,str) and value.startswith(PREFIXES) and '..' not in Path(value).parts and re.fullmatch(r'/[A-Za-z0-9._/+=@%~:-]+',value),'unsafe_remote_path');return value

def provider(raw):
 s=text(raw);found=re.findall(r'^  Current WebView package \(name, version\): \(([a-zA-Z0-9_.]+), ([^,)\n]+)\)$',s,re.M)
 need(len(found)==1 and found[0][0] in ('com.google.android.webview','com.android.webview'),'ambiguous_or_unsupported_active_provider');return {'package':found[0][0],'version':found[0][1]}

def package_paths(raw):
 s=text(raw);rows=s.splitlines();need(rows and len(rows)==len(set(rows)) and all(x.startswith('package:') for x in rows),'package_paths');return [remote_path(x[8:]) for x in rows]

def static_dependency(raw):
 s=text(raw);declared=re.findall(r'^\s+com\.google\.android\.trichromelibrary version:(\d+)\s*$',s,re.M)
 if not declared:return []
 need(len(declared)==1,'ambiguous_static_version');lines=s.splitlines();positions=[i for i,l in enumerate(lines) if l.strip()=='usesLibraryFiles:'];need(len(positions)==1,'static_resolved_section')
 i=positions[0];indent=len(lines[i])-len(lines[i].lstrip());paths=[]
 for line in lines[i+1:]:
  if not line.strip():continue
  if len(line)-len(line.lstrip())<=indent:break
  if line.strip().endswith('.apk'):paths.append(remote_path(line.strip()))
 need(len(paths)==1,'static_resolved_apk_count');return [{'role':'resolved-static-library','package':'com.google.android.trichromelibrary','version':declared[0],'remote':paths[0]}]

def binary_meta(size,digest,path):
 s=text(size).strip();d=text(digest).strip().split();need(re.fullmatch(r'[1-9][0-9]{0,11}',s) is not None,'binary_size')
 need(len(d)==2 and re.fullmatch(r'[a-f0-9]{64}',d[0]) and d[1]==path,'binary_sha_binding');return {'bytes':int(s),'sha256':d[0]}

def host_server():
 """Linux proc identity without logging arbitrary cmdline or environment."""
 roots=Path('/proc');rows=[]
 for p in roots.iterdir() if roots.exists() else []:
  if not p.name.isdigit():continue
  try:
   if (p/'comm').read_text().strip()!='adb':continue
   args=(p/'cmdline').read_bytes().split(b'\0')
   if b'fork-server' not in args or b'server' not in args:continue
   stat=(p/'stat').read_text();fields=stat[stat.rfind(')')+2:].split()
   rows.append({'pid':int(p.name),'start_ticks':int(fields[19]),'comm':'adb','classification':'exact fork-server/server tokens seen; raw argv not saved'})
  except (OSError,ValueError,IndexError):continue
 need(len(rows)==1,'host_adb_server_identity_ambiguous_or_absent');return rows[0]

def basic(raw,sdk):
 need(text(raw['state'])=='device\n','transport_unavailable')
 need(text(raw['boot_completed'])=='1\n','guest_boot_incomplete')
 boot=text(raw['boot_id']).strip();need(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',boot),'guest_boot_id')
 need(text(raw['sdk']).strip()==str(sdk) and text(raw['abi'])=='x86_64\n' and text(raw['page_size'])=='16384\n','guest_sdk_abi_page')
 pids={}
 for n in ('adbd_pid','system_server_pid'):
  v=text(raw[n]).strip();need(re.fullmatch(r'[1-9][0-9]{0,9}',v),'guest_pid_shape');pids[n]=int(v)
 uptime=text(raw['uptime']).strip().split();need(len(uptime)==2,'guest_uptime_shape')
 try:t=float(uptime[0])
 except ValueError:raise HealthError('guest_uptime_shape') from None
 need(math.isfinite(t) and t>=0,'guest_uptime_shape')
 fingerprint=text(raw['fingerprint']).strip();need(fingerprint and len(fingerprint)<1024,'guest_fingerprint')
 no_active_instrumentation(raw['active_instrumentation'])
 network=text(raw['network']);need(len(re.findall(r'^Active default network: none$',network,re.M))==1,'guest_not_offline')
 need(text(raw['airplane']).strip()=='enabled','guest_airplane_not_enabled')
 crash=raw['crash'].decode('utf8','strict');need(not crash or crash.endswith('\n'),'truncated_crash_buffer');need(all(not line.strip() or line.startswith('--------- beginning of ') for line in crash.splitlines()),'open_guest_crash_record')
 return {'boot_id':boot,**pids,'uptime':t,'sdk':sdk,'abi':'x86_64','page_size':16384,'fingerprint':fingerprint}

def continuous(before,after):
 keys=('boot_id','adbd_pid','system_server_pid','sdk','abi','page_size','fingerprint','host_server','provider','binary_targets','helper_identity')
 need(all(before.get(k) is not None and before.get(k)==after.get(k) for k in keys),'identity_segment_changed')
 need(after['uptime']>=before['uptime'],'guest_uptime_regressed')
 return True

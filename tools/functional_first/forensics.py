"""Bound signed APKs per file; provider-family ELF and ART are separate gates."""
import hashlib,json,re,shutil,zipfile
from pathlib import Path
from health import binary_meta,HealthError
from interruptions import interruption_reason

def sha(raw):return hashlib.sha256(raw).hexdigest()
def actual_apk_signer_sha256s(raw):
 # SDK 37 prints V3.0 Signer:, older SDKs print Signer #n. Source Stamp
 # authenticates a stamp, not the APK signer; it must never satisfy this gate.
 digests=[]
 for line in raw.splitlines():
  match=re.fullmatch(rb'(?:Signer #[1-9][0-9]*|V3\.0 Signer:) certificate SHA-256 digest: ([a-f0-9]{64})',line)
  if match:digests.append(match.group(1).decode('ascii'))
 return digests
def capture_forensics(runner,identity,sdk_root):
 folder=runner.out/'binary-forensics';folder.mkdir();targets=[x for x in identity['binary_targets'] if x['role'] in ('provider-package','resolved-static-library','art')];rows=[];transport_failed=False
 signers=sorted(Path(sdk_root).glob('build-tools/*/apksigner'));readelf=shutil.which('readelf')
 def required(label,args,timeout):
  nonlocal transport_failed
  r,out,err=runner.command(label,args,timeout)
  gap=interruption_reason(r,out,err)
  if gap:
   transport_failed=True
   raise HealthError('binary_required_guest_uncertain_'+gap)
  if not r['success']:raise HealthError('binary_required_command_'+r['status'])
  if err.strip():raise HealthError('binary_required_stderr_nonempty')
  return out
 for i,t in enumerate(targets):
  row={'target':t,'status':'not_attempted','retry_count':0};rows.append(row)
  if transport_failed or getattr(runner,'interruption_observations',[]):row['reason']='prior_transport_or_host_interruption';continue
  remote=t['remote'];local=folder/(f'{i:02d}-'+('libart.so' if t['role']=='art' else 'actual.apk'))
  try:
   if required(f'binary-{i}-state',['get-state'],15).strip()!=b'device':transport_failed=True;raise HealthError('transport_unavailable')
   before=binary_meta(required(f'binary-{i}-before-size',['shell','stat','-c','%s',remote],20),required(f'binary-{i}-before-sha',['shell','sha256sum',remote],45),remote);row['remote_before']=before
   if any(before[k]!=t[k] for k in ('bytes','sha256')):raise HealthError('binary_changed_before_transfer')
   seconds=60 if t['role']=='art' else 90
   receipt,raw,err=runner.command(f'binary-{i}-pull',['pull',remote,str(local)],seconds);row['pull_receipt']=receipt['relative_dir'];gap=interruption_reason(receipt,raw,err)
   if gap or not receipt['success']:
    transport_failed=True;row['interruption_reason']=gap or 'binary_transfer_command_failed'
    raise HealthError('binary_pull_'+receipt['status'])
   if not local.is_file() or local.is_symlink():raise HealthError('binary_local_missing_or_symlink')
   b=local.read_bytes();actual={'bytes':len(b),'sha256':sha(b)};row['local_actual']=actual
   after=binary_meta(required(f'binary-{i}-after-size',['shell','stat','-c','%s',remote],20),required(f'binary-{i}-after-sha',['shell','sha256sum',remote],45),remote);row['remote_after']=after
   if actual!=before or before!=after:raise HealthError('binary_transfer_hash_or_identity_changed')
   if not readelf:raise HealthError('readelf_unavailable')
   elf_files=[]
   if t['role']=='art':elf_files=[('libart.so',local,b)]
   else:
    if not signers:raise HealthError('official_apksigner_unavailable')
    r,out,err=runner.command(f'binary-{i}-signer',[str(signers[-1]),'verify','--print-certs',str(local)],60,host=True);row['signer_receipt']=r['relative_dir']
    if not r['success'] or not actual_apk_signer_sha256s(out):raise HealthError('actual_signer_verification_failed')
    (folder/f'{i:02d}-certificates.txt').write_bytes(out)
    with zipfile.ZipFile(local) as z:
     seen=set()
     for member in z.infolist():
      name=member.filename
      if not name.startswith('lib/x86_64/') or not name.endswith('.so'):continue
      if name in seen or '/' in name[len('lib/x86_64/'):] or member.file_size>512*1024*1024:raise HealthError('native_zip_member_unbounded_unsafe_or_duplicate')
      seen.add(name);data=z.read(member)
      if name=='lib/x86_64/libplaceholder.so' and len(data)==0:
       row.setdefault('empty_abi_placeholder',[]).append({'name':name,'bytes':0,'sha256':sha(data),'scope':'exact known Chromium empty ABI placeholder; verified signed APK, not an ELF'})
       continue
      elf=folder/(f'{i:02d}-'+Path(name).name);elf.write_bytes(data);elf_files.append((name,elf,data))
    if not elf_files and not row.get('empty_abi_placeholder'):raise HealthError('no_actual_x86_64_elf_or_exact_placeholder')
   row['elfs']=[]
   for j,(name,file,data) in enumerate(elf_files):
    # Actual class/data/machine header, never infer x86_64 solely from ZIP path.
    if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(data[18:20],'little')!=62:raise HealthError('actual_binary_not_x86_64_ELF64_LE')
    r,out,err=runner.command(f'binary-{i}-elf-{j}',[readelf,'-W','-l','-n',str(file)],60,host=True)
    if not r['success']:raise HealthError('actual_readelf_failed')
    ids=re.findall(rb'Build ID: ([a-f0-9]+)',out);loads=[line.decode('ascii','strict') for line in out.splitlines() if line.lstrip().startswith(b'LOAD ')]
    if not ids or not loads:raise HealthError('actual_elf_buildid_or_segments_missing')
    (folder/(file.name+'-readelf.txt')).write_bytes(out)
    row['elfs'].append({'name':name,'bytes':len(data),'sha256':sha(data),'readelf_receipt':r['relative_dir'],'build_ids':[x.decode() for x in ids],'load_segments':loads,'scope':'actual file header and tool identity/layout; no substituted alignment or inferred cause'})
   row['status']='complete_verified';row['native_packaging']='ELF64_x86_64' if row['elfs'] else 'exact_empty_abi_placeholder_only'
  except (HealthError,OSError,ValueError,zipfile.BadZipFile,UnicodeError) as e:
   row['status']='failed';row['reason']=str(e)[:160] if isinstance(e,HealthError) else type(e).__name__
   if getattr(runner,'interruption_observations',[]):transport_failed=True
   if local.is_file() and not local.is_symlink():row['partial_local']={'bytes':local.stat().st_size,'sha256':sha(local.read_bytes())}
  with (folder/f'{i:02d}-result.json').open('x') as f:json.dump(row,f,indent=2);f.write('\n')
 providers=[r for r in rows if r['target']['role']=='provider-package'];family=[r for r in rows if r['target']['role'] in ('provider-package','resolved-static-library')];art=[r for r in rows if r['target']['role']=='art']
 family_elfs=sum(len(r.get('elfs',[])) for r in family if r['status']=='complete_verified');art_elfs=sum(len(r.get('elfs',[])) for r in art if r['status']=='complete_verified')
 gate={'all_target_before_local_after_and_APK_signers_verified':bool(targets) and all(r['status']=='complete_verified' for r in rows),'provider_target_count':len(providers),'provider_plus_resolved_dependency_verified_ELF_count':family_elfs,'ART_target_count':len(art),'ART_verified_ELF_count':art_elfs,'provider_family_has_actual_ELF':bool(providers) and family_elfs>=1,'ART_has_independent_actual_ELF':len(art)==1 and art_elfs==1,'ART_cannot_satisfy_provider_family_gate':True,'placeholder_exception_is_exact_known_zero_entry_only':True}
 complete=gate['all_target_before_local_after_and_APK_signers_verified'] and gate['provider_family_has_actual_ELF'] and gate['ART_has_independent_actual_ELF'] and not transport_failed
 out={'status':'complete_verified' if complete else 'failed','targets':rows,'family_validation':gate,'transport_or_host_interruption':transport_failed,'guest_termination_confirmed':False,'function_first_observations_retained':True,'root_cause_closed':False,'production_stability_accepted':False,'new_model_or_apk':False,'genuine_device_claim':False}
 with (folder/'forensic-report.json').open('x') as f:json.dump(out,f,indent=2);f.write('\n')
 return out

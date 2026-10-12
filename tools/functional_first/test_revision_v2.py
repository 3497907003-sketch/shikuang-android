"""Meaningful UNIT_ONLY regression negatives, never real signing/device evidence."""
import argparse,copy,hashlib,json,os,subprocess,sys,tempfile,time,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
import executor,forensics
from interruptions import interruption_reason,instrumentation_uncertain
from clock_archive import archive_clock
from harvest import collect
from terminal import parse_terminal

GOOD=b'OK (1 test)\nINSTRUMENTATION_CODE: -1\n'
def digest(b):return hashlib.sha256(b).hexdigest()
def elf(machine=62):
 b=bytearray(64);b[:6]=b'\x7fELF\x02\x01';b[18:20]=machine.to_bytes(2,'little');return bytes(b)

class UnitForensicRunner:
 """Injected success tools + real local byte/ZIP I/O; not APK/signer/ELF attestation."""
 def __init__(self,root,provider_members=None,dep_members=None,with_art=True,fail_label=None,marker=b'error: closed\n',signer_ok=True,change_after=False):
  self.out=root;self.calls=[];self.fail_label=fail_label;self.marker=marker;self.signer_ok=signer_ok;self.change_after=change_after;self.raw={};self.targets=[]
  for i,(role,members) in enumerate([('provider-package',provider_members),('resolved-static-library',dep_members)]):
   if members is None:continue
   path=root/('UNIT_ONLY-'+role+'.zip')
   with zipfile.ZipFile(path,'w') as z:
    for name,b in members:z.writestr(name,b)
   raw=path.read_bytes();remote='/product/app/UNIT_ONLY/'+role+'.apk';self.raw[remote]=raw;self.targets.append({'role':role,'package':'UNIT_ONLY','remote':remote,'bytes':len(raw),'sha256':digest(raw)})
  if with_art:
   remote='/apex/com.android.art/lib64/libart.so';raw=elf();self.raw[remote]=raw;self.targets.append({'role':'art','remote':remote,'bytes':len(raw),'sha256':digest(raw)})
  self.sdk=root/'sdk';(self.sdk/'build-tools/UNIT_ONLY').mkdir(parents=True);(self.sdk/'build-tools/UNIT_ONLY/apksigner').write_text('UNIT_ONLY not executed\n')
 def command(self,label,args,timeout=20,host=False):
  self.calls.append({'label':label,'args':args,'host':host});r={'success':True,'status':'success','relative_dir':'UNIT_ONLY-'+label}
  if label==self.fail_label:return {**r,'success':False,'status':'command_failed'},b'',self.marker
  if args==['get-state']:return r,b'device\n',b''
  if args[:3]==['shell','stat','-c']:return r,str(len(self.raw[args[-1]])).encode()+b'\n',b''
  if args[:2]==['shell','sha256sum']:
   d=digest(self.raw[args[-1]])
   if self.change_after and '-after-sha' in label:d='a'*64
   return r,d.encode()+b'  '+args[-1].encode()+b'\n',b''
  if args[0]=='pull':Path(args[2]).write_bytes(self.raw[args[1]]);return r,b'UNIT_ONLY local bytes\n',b''
  if label.endswith('-signer'):return ({**r,'success':self.signer_ok,'status':'success' if self.signer_ok else 'command_failed'},b'Signer #1 certificate SHA-256 digest: '+b'a'*64+b'\n',b'')
  if '-elf-' in label:return r,b'Build ID: '+b'b'*40+b'\n LOAD 0x000000 0x000000 0x000000 0x000100 0x000100 R E 0x4000\n',b''
  raise AssertionError('Unexpected UNIT_ONLY command')

def forensic(root,**kwargs):
 runner=UnitForensicRunner(root,**kwargs)
 with patch.object(forensics.shutil,'which',return_value='/UNIT_ONLY/readelf-not-executed'):
  result=forensics.capture_forensics(runner,{'binary_targets':runner.targets},runner.sdk)
 return runner,result

class ProviderFamilyTests(unittest.TestCase):
 def test_placeholder_provider_dependency_ELF_and_ART_pass_software_path(self):
  with tempfile.TemporaryDirectory() as tmp:
   runner,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())]);self.assertEqual(r['status'],'complete_verified');self.assertEqual(r['targets'][0]['native_packaging'],'exact_empty_abi_placeholder_only');self.assertEqual(r['family_validation']['provider_plus_resolved_dependency_verified_ELF_count'],1);self.assertEqual(r['family_validation']['ART_verified_ELF_count'],1)
   for row in r['targets']:self.assertEqual(row['remote_before'],row['local_actual']);self.assertEqual(row['remote_before'],row['remote_after'])
 def test_ART_cannot_replace_family_ELF(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'')]);self.assertEqual(r['status'],'failed');self.assertFalse(r['family_validation']['provider_family_has_actual_ELF']);self.assertTrue(r['family_validation']['ART_has_independent_actual_ELF'])
 def test_family_ELF_cannot_replace_ART(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libwebview.so',elf())],with_art=False);self.assertEqual(r['status'],'failed');self.assertTrue(r['family_validation']['provider_family_has_actual_ELF']);self.assertFalse(r['family_validation']['ART_has_independent_actual_ELF'])
 def test_missing_provider_not_accepted_by_dependency_and_ART(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),dep_members=[('lib/x86_64/libmonochrome_64.so',elf())]);self.assertEqual(r['status'],'failed');self.assertFalse(r['family_validation']['provider_family_has_actual_ELF'])
 def test_unknown_empty_so_not_placeholder_exception(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/not-placeholder.so',b'')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())]);self.assertEqual(r['status'],'failed');self.assertEqual(r['targets'][0]['reason'],'actual_binary_not_x86_64_ELF64_LE')
 def test_nonempty_placeholder_not_exception(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'notELF')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())]);self.assertEqual(r['status'],'failed')
 def test_unsigned_placeholder_still_fails(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())],signer_ok=False);self.assertEqual(r['status'],'failed');self.assertEqual(r['targets'][0]['reason'],'actual_signer_verification_failed')
 def test_source_byte_identity_change_after_transfer_fails(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())],change_after=True);self.assertEqual(r['status'],'failed');self.assertEqual(r['targets'][0]['reason'],'binary_transfer_hash_or_identity_changed')
 def test_x86_64_name_does_not_turn_other_machine_into_ELF(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libwrong.so',elf(183))]);self.assertEqual(r['status'],'failed');self.assertEqual(r['targets'][0]['reason'],'actual_binary_not_x86_64_ELF64_LE')
 def test_unknown_empty_APK_not_exception(self):
  with tempfile.TemporaryDirectory() as tmp:
   _,r=forensic(Path(tmp),provider_members=[],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())]);self.assertEqual(r['status'],'failed');self.assertEqual(r['targets'][0]['reason'],'no_actual_x86_64_elf_or_exact_placeholder')
 def test_before_after_required_transport_blocks_later_binary_targets(self):
  for label in ('binary-0-state','binary-0-before-size','binary-0-before-sha','binary-0-after-size','binary-0-after-sha'):
   for marker in (b'error: closed\n',b'error: no devices/emulators found\n'):
    with self.subTest(label=label,marker=marker),tempfile.TemporaryDirectory() as tmp:
     runner,r=forensic(Path(tmp),provider_members=[('lib/x86_64/libplaceholder.so',b'')],dep_members=[('lib/x86_64/libmonochrome_64.so',elf())],fail_label=label,marker=marker);self.assertEqual(r['status'],'failed');self.assertTrue(r['transport_or_host_interruption']);self.assertTrue(all(x['status']=='not_attempted' for x in r['targets'][1:]));self.assertFalse(any(c['label'].startswith('binary-1-') for c in runner.calls));self.assertFalse(r['guest_termination_confirmed'])

class InterruptionTests(unittest.TestCase):
 def test_plain_assertion_failure_does_not_imply_guest_crash(self):self.assertIsNone(interruption_reason({'status':'command_failed'},b'FAILURES!!!\nINSTRUMENTATION_CODE: 0\n',b''))
 def test_closed_and_missing_on_either_stream_and_even_zero_exit(self):
  for marker in (b'error: closed\n',b'error: no devices/emulators found\n',b'error: device offline\n'):
   for status in ('success','command_failed'):
    for out,err in ((marker,b''),(b'',marker)):
     with self.subTest(marker=marker,status=status,out=bool(out)):self.assertTrue(interruption_reason({'status':status},out,err));self.assertTrue(instrumentation_uncertain({'status':status},out,err))
 def test_terminal_same_zero_exit_transport_markers_reject(self):
  for marker in (b'error: closed\n',b'error: no devices/emulators found\n'):
   with self.subTest(marker=marker),self.assertRaises(ValueError):parse_terminal(GOOD,marker)
 def test_harvest_shared_classifier_blocks_remaining(self):
  for marker in (b'error: closed\n',b'error: no devices/emulators found\n'):
   class Runner:
    deadline=time.monotonic()+2000;calls=0
    def command(self,*a,**kw):self.calls+=1;return {'status':'command_failed','success':False,'relative_dir':'UNIT_ONLY-marker','streams':{'stdout':{'bytes_read':0}}},b'',marker
   with self.subTest(marker=marker),tempfile.TemporaryDirectory() as tmp:
    runner=Runner();r=collect(runner,'app',Path(tmp)/'media',True);self.assertEqual(runner.calls,1);self.assertTrue(r['transport_or_host_interruption']);self.assertFalse(r['required_complete']);self.assertTrue(r['all282_names_accounted'])
 def test_runner_retains_real_unit_child_transport_gap_even_later_success(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);fixture=root/'fixture';fixture.mkdir();(fixture/'adapter.json').write_text(json.dumps({'responses':{'["UNIT_ONLY-response"]':'closed.txt','["UNIT_ONLY-healthy"]':'healthy.txt'}}));(fixture/'state.json').write_text(json.dumps({'instrumentations':0}));(fixture/'closed.txt').write_bytes(b'error: closed\n');(fixture/'healthy.txt').write_bytes(b'device\n');runner=executor.Runner('/UNIT_ONLY-never-adb','emulator-5554',root/'out',time.monotonic()+2000,fixture)
   runner.command('unit-gap',['UNIT_ONLY-response'],1);runner.command('unit-later-healthy',['UNIT_ONLY-healthy'],1);self.assertEqual(len(runner.interruption_observations),1);self.assertEqual(runner.interruption_observations[0]['label'],'unit-gap');self.assertFalse(runner.interruption_observations[0]['guest_termination_confirmed'])

class ArchiveTests(unittest.TestCase):
 def create_pair(self,root):
  source=root/'clock.json';source.write_bytes(b'{"UNIT_ONLY":true}\n');source.with_suffix('.response.bin').write_bytes(b'{"jobs":[]}\n');return source
 def test_original_pair_exact_bytes_hashes_without_auth_claim(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=self.create_pair(root);r=archive_clock(source,root/'archive');self.assertTrue(r['complete_pair']);self.assertFalse(r['authoritative_clock_revalidated']);self.assertTrue(r['no_API_requests_or_secret_access']);self.assertEqual((root/'archive/job-clock.json').read_bytes(),source.read_bytes());self.assertEqual((root/'archive/job-clock.response.bin').read_bytes(),source.with_suffix('.response.bin').read_bytes())
 def test_missing_both_explicit_and_no_replacement_bytes(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);r=archive_clock(root/'absent.json',root/'archive');self.assertFalse(r['complete_pair']);self.assertTrue(all(x['status']=='missing_original' for x in r['files']));self.assertFalse((root/'archive/job-clock.json').exists());self.assertFalse((root/'archive/job-clock.response.bin').exists())
 def test_missing_response_preserves_only_actual_clock(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'clock.json';source.write_bytes(b'{"UNIT_ONLY":true}\n');r=archive_clock(source,root/'archive');self.assertFalse(r['complete_pair']);self.assertEqual(r['files'][0]['status'],'copied_original_bytes_verified');self.assertEqual(r['files'][1]['status'],'missing_original')
 def test_source_symlink_rejected_no_follow(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=self.create_pair(root);link=root/'link.json';link.symlink_to(source);r=archive_clock(link,root/'archive');self.assertEqual(r['files'][0]['status'],'failed_original_read');self.assertFalse((root/'archive/job-clock.json').exists())
 def test_actual_FIFO_does_not_block_host_collection(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'fifo.json';os.mkfifo(source);p=subprocess.run([sys.executable,'-B',str(Path(__file__).with_name('clock_archive.py')),str(source),str(root/'archive')],capture_output=True,timeout=1);self.assertEqual(p.returncode,2);r=json.loads((root/'archive/archive-report.json').read_text());self.assertEqual(r['files'][0]['reason'],'regular_file_required')
 def test_oversized_source_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'clock.json';source.write_bytes(b'X'*(128*1024+1));r=archive_clock(source,root/'archive');self.assertEqual(r['files'][0]['reason'],'original_clock_size_bound')
 def test_no_overwrite_of_existing_archive(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=self.create_pair(root);archive_clock(source,root/'archive');before=(root/'archive/archive-report.json').read_bytes()
   with self.assertRaises(FileExistsError):archive_clock(source,root/'archive')
   self.assertEqual((root/'archive/archive-report.json').read_bytes(),before)

if __name__=='__main__':unittest.main()

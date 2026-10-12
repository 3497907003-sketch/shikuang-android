#!/usr/bin/env python3
"""Freeze exactly one new current-r9 debug comparison build; never publish it."""
import argparse,hashlib,json,os,re,shutil,subprocess,zipfile,xml.etree.ElementTree as ET
from pathlib import Path
from current_artifact import APK_NAMES,HELPER_SHA,PRESSURE_JAVA,SYNC_PATH,WORKFLOW_PATH,validate_sync,sha

EXPECTED_PACKAGE={'app.apk':'com.shikuang.app.preview','app-test.apk':'com.shikuang.app.preview.test','control.apk':'com.shikuang.control16k','control-test.apk':'com.shikuang.control16k.test','test-services-1.4.2.apk':'androidx.test.services'}
BUILD_DIRS={'app.apk':'android/app/build/outputs/apk/debug','app-test.apk':'android/app/build/outputs/apk/androidTest/debug','control.apk':'android16k-control/build/outputs/apk/debug','control-test.apk':'android16k-control/build/outputs/apk/androidTest/debug'}
def built_apk(folder):
 metadata=json.loads((folder/'output-metadata.json').read_bytes());rows=metadata.get('elements')
 if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict):raise ValueError('one_actual_build_APK_required')
 name=rows[0].get('outputFile')
 if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.apk',name):raise ValueError('actual_build_APK_filename')
 p=folder/name
 if p.is_symlink() or not p.is_file():raise ValueError('actual_build_APK_missing')
 return p
def instrumentation_target(raw,target):
 root=ET.fromstring(raw);rows=root.findall('instrumentation');ns='{http://schemas.android.com/apk/res/android}'
 if len(rows)!=1 or rows[0].get(ns+'name')!='androidx.test.runner.AndroidJUnitRunner' or rows[0].get(ns+'targetPackage')!=target:raise ValueError('actual_APK_instrumentation_target_mismatch')
def command(argv,folder,stem):
 p=subprocess.run(argv,capture_output=True,timeout=90)
 (folder/(stem+'.stdout.bin')).write_bytes(p.stdout);(folder/(stem+'.stderr.bin')).write_bytes(p.stderr)
 (folder/(stem+'.receipt.json')).write_text(json.dumps({'argv':argv,'return_code':p.returncode,'stdout_bytes':len(p.stdout),'stdout_sha256':sha(p.stdout),'stderr_bytes':len(p.stderr),'stderr_sha256':sha(p.stderr),'scope':'Actual host build/tool observation; no Android runtime claim'},indent=2)+'\n')
 if p.returncode!=0:raise ValueError('required_build_tool_failed_'+stem)
 return p.stdout
def main():
 a=argparse.ArgumentParser();a.add_argument('--out',required=True);a.add_argument('--helper',required=True);a.add_argument('--sdk',required=True);a.add_argument('--source-sha',required=True);a.add_argument('--web-sync-sha',required=True);args=a.parse_args()
 repo=Path.cwd();out=Path(args.out);out.mkdir(mode=0o700,exist_ok=False);evidence=out/'build-evidence';evidence.mkdir()
 source=subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()
 if not re.fullmatch(r'[a-f0-9]{40}',args.source_sha) or source!=args.source_sha:raise ValueError('actual_current_checkout_source_mismatch')
 syncraw=(repo/SYNC_PATH).read_bytes();sync=validate_sync(syncraw,args.web_sync_sha)
 # Commit snapshots, source web plan and actual post-sync Android assets must agree.
 for row in sync['assets']:
  original=repo/'web'/row['path'];packaged=repo/'android/app/src/main/assets/public'/row['path']
  original_raw=original.read_bytes();packaged_raw=packaged.read_bytes()
  committed=subprocess.check_output(['git','show',source+':web/'+row['path']])
  if original_raw!=committed or packaged_raw!=original_raw or len(original_raw)!=row['bytes'] or sha(original_raw)!=row['sha256']:raise ValueError('current_committed_packaged_web_asset_mismatch_'+row['path'])
 srcnames=set(PRESSURE_JAVA)|{SYNC_PATH,WORKFLOW_PATH,'package.json','package-lock.json','tools/build.cjs','tools/check.cjs','tools/verify-sync.cjs','android/app/build.gradle','android/variables.gradle','android/app/src/androidTest/java/com/shikuang/app/RuntimeTestOutput.java'}
 srcnames|={str(p.relative_to(repo)) for base in ('tools/functional_first','android/app/src/main/java','android16k-control') for p in (repo/base).rglob('*') if p.is_file() and 'build' not in p.relative_to(repo/base).parts and '.gradle' not in p.relative_to(repo/base).parts}
 sources=[]
 for name in sorted(srcnames):
  raw=(repo/name).read_bytes();committed=subprocess.check_output(['git','show',source+':'+name])
  if raw!=committed:raise ValueError('current_source_not_committed_'+name)
  if name in PRESSURE_JAVA and sha(raw)!=PRESSURE_JAVA[name]:raise ValueError('strict_pressure_class_changed')
  dst=out/'source'/name;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(raw)
  sources.append({'path':name,'bytes':len(raw),'sha256':sha(raw)})
 tools=Path(args.sdk)/'build-tools/35.0.0'
 for tool in ('apksigner','aapt','zipalign'):
  if not (tools/tool).is_file():raise ValueError('official_build_tool_missing_'+tool)
 apks=[]
 for name in sorted(APK_NAMES):
  src=Path(args.helper) if name=='test-services-1.4.2.apk' else built_apk(repo/BUILD_DIRS[name])
  dst=out/name;shutil.copyfile(src,dst);raw=dst.read_bytes()
  if name=='test-services-1.4.2.apk' and sha(raw)!=HELPER_SHA:raise ValueError('same_helper_SHA_required')
  sign=command([str(tools/'apksigner'),'verify','--verbose','--print-certs',str(dst)],evidence,name+'-signature')
  certs=re.findall(rb'^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$',sign,re.M)
  if len(certs)!=1 or re.search(rb'^Signer #[2-9]',sign,re.M):raise ValueError('single_actual_APK_signer_required')
  badging=command([str(tools/'aapt'),'dump','badging',str(dst)],evidence,name+'-package')
  package=re.findall(rb"^package: name='([^']+)'",badging,re.M)
  if package!=[EXPECTED_PACKAGE[name].encode()]:raise ValueError('actual_APK_package_mismatch_'+name)
  if name in ('app-test.apk','control-test.apk'):
   target=EXPECTED_PACKAGE[name.replace('-test','')]
   xml=command([str(Path(args.sdk)/'cmdline-tools/latest/bin/apkanalyzer'),'manifest','print',str(dst)],evidence,name+'-manifest')
   instrumentation_target(xml,target)
  apks.append({'name':name,'bytes':len(raw),'sha256':sha(raw),'certificate_sha256':certs[0].decode().lower(),'package':EXPECTED_PACKAGE[name],'signing_scope':'Same-run CI debug/test artifact; no persistent preview signing key accessed'})
 with zipfile.ZipFile(out/'app.apk') as z:
  members=z.namelist()
  if len(set(members))!=len(members):raise ValueError('duplicate_APK_zip_members')
  for row in sync['assets']:
   raw=z.read('assets/public/'+row['path'])
   if len(raw)!=row['bytes'] or sha(raw)!=row['sha256']:raise ValueError('actual_APK_current_r9_asset_mismatch_'+row['path'])
 command(['python3','tools/inspect_apk.py',str(out/'app.apk'),'--require-16k','--output',str(evidence/'app-native-compatibility.json')],evidence,'app-native-inspect')
 command([str(tools/'zipalign'),'-v','-c','-P','16','4',str(out/'app.apk')],evidence,'app-zipalign')
 manifest={'schema':'current-r9-functional-test-build-v1','sourceSha':source,'currentR9':True,'webSourceSha':sync['web_source_commit'],'webSyncSha256':args.web_sync_sha,'packagedWebAssetsSha256':sha(json.dumps(sync['assets'],sort_keys=True,separators=(',',':')).encode()),'fourExperimentApks':['app.apk','app-test.apk','control.apk','control-test.apk'],'testStorageHelper':'test-services-1.4.2.apk','apks':apks,'sourceFiles':sources,'distributableRelease':False,'oldComparandOverwritten':False,'actualAndroidRuntimeProven':False,'scope':'Once-built current r9 App/control/test APKs reused byte-identically on two official full16KB images. Full-image comparison, not provider-only A/B; no release or accuracy claim.'}
 raw=(json.dumps(manifest,indent=2)+'\n').encode();(out/'manifest.json').write_bytes(raw)
 if os.environ.get('GITHUB_OUTPUT'):
  with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('manifest_sha='+sha(raw)+'\n')
 print(json.dumps({'current_source_sha':source,'manifest_sha':sha(raw),'web_source_sha':sync['web_source_commit'],'actual_built_APKs':4,'same_byte_helper':True,'public_release':False,'actual_Android_runtime_proven':False}))
if __name__=='__main__':main()

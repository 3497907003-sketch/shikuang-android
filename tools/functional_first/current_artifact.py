"""Bind one new current-r9 test build to trusted same-run source/output hashes.

This validates artifact identity, never Android functionality or release signing.
"""
import hashlib,json,re
from pathlib import Path
from health import HealthError

APK_NAMES={'app.apk','app-test.apk','control.apk','control-test.apk','test-services-1.4.2.apk'}
HELPER_SHA='c6bc74268b29bdabad8da962e00e2f6fd613c24b42c69e81b258397b4819f156'
PRESSURE_JAVA={
 'android/app/src/androidTest/java/com/shikuang/app/InputLifecycle16kStressInstrumentedTest.java':'85a3085c3804bf4870025f91006df4e601151b0cafe823ce360fbd8ca0c54181',
 'android16k-control/src/androidTest/java/com/shikuang/control16k/WebViewControl16kInstrumentedTest.java':'75076416ddeb45dadb8fa1be28f3db64b2ba997899fbd313303c95157a333273'}
APP_DIAGNOSTIC_FINAL_JAVA_SHA='d40c9fa745504ba06d414646c4b355b32fb41e9be90c0ee7692261172be5ac03'
def pressure_java_pins(case_selection='comparison'):
 if case_selection not in ('comparison','app_only_diagnostic'):raise HealthError('current_experiment_case_selection')
 pins=dict(PRESSURE_JAVA)
 if case_selection=='app_only_diagnostic':pins['android/app/src/androidTest/java/com/shikuang/app/InputLifecycle16kStressInstrumentedTest.java']=APP_DIAGNOSTIC_FINAL_JAVA_SHA
 return pins
SYNC_PATH='docs/CURRENT_R9_WEB_SYNC.json'
WORKFLOW_PATH='.github/workflows/android-functional-first.yml'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def relative(name):
 if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_./-]+',name) or name.startswith('/') or any(p in ('','..','.') for p in name.split('/')):raise HealthError('current_artifact_relative_path')
 return name
def digest_file(path,cap):
 if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=cap:raise HealthError('current_artifact_file_bound')
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return path.stat().st_size,h.hexdigest()
def validate_sync(raw,expected_sha):
 if not re.fullmatch(r'[a-f0-9]{64}',expected_sha or '') or sha(raw)!=expected_sha:raise HealthError('current_web_sync_hash')
 try:m=json.loads(raw)
 except (ValueError,UnicodeError):raise HealthError('current_web_sync_json') from None
 if m.get('schema')!='current-r9-android-private-test-web-sync-v1' or m.get('web_version',{}).get('development_revision')!='r9' or not re.fullmatch(r'[a-f0-9]{40}',m.get('web_source_commit','')):raise HealthError('current_r9_source_identity')
 rows=m.get('assets');seen=set()
 if not isinstance(rows,list) or len(rows)!=m.get('count') or not rows:raise HealthError('current_web_asset_count')
 for r in rows:
  name=relative(r.get('path'));size=r.get('bytes')
  if name in seen or type(size) is not int or size<=0 or not re.fullmatch(r'[a-f0-9]{64}',r.get('sha256','')):raise HealthError('current_web_asset_row')
  seen.add(name)
 if not {'index.html','core.js','app.js','viewport.js','model-manifest.json'}<=seen:raise HealthError('current_r9_required_assets')
 return m
def source_contract(m,expected_source_sha,expected_case_selection):
 if not re.fullmatch(r'[a-f0-9]{40}',expected_source_sha or ''):raise HealthError('current_build_trusted_hashes_required')
 if m.get('schema')!='current-r9-functional-test-build-v1' or m.get('sourceSha')!=expected_source_sha or m.get('currentR9') is not True or m.get('distributableRelease') is not False:raise HealthError('current_build_source_contract')
 if expected_case_selection not in ('comparison','app_only_diagnostic') or m.get('experiment_case_selection','comparison')!=expected_case_selection:raise HealthError('current_experiment_case_selection')
 return pressure_java_pins(expected_case_selection)
def bind_current_source_metadata(folder,m,expected_source_sha,expected_sync_sha,repo,expected_case_selection='comparison'):
 """Real source stage shared by the full binder; this alone never validates APKs."""
 p=Path(folder);repo=Path(repo);pressure_java=source_contract(m,expected_source_sha,expected_case_selection)
 source=m.get('sourceFiles');seen=set();bound={}
 if not isinstance(source,list) or not source:raise HealthError('current_source_files_missing')
 for row in source:
  name=relative(row.get('path'))
  if name in seen or type(row.get('bytes')) is not int or not re.fullmatch(r'[a-f0-9]{64}',row.get('sha256','')):raise HealthError('current_source_row')
  seen.add(name)
  for base in (p/'source',repo):
   size,digest=digest_file(base/name,8*1024*1024)
   if size!=row['bytes'] or digest!=row['sha256']:raise HealthError('current_source_bytes')
  bound[name]=row
 if not set(pressure_java)|{SYNC_PATH,WORKFLOW_PATH}<=seen:raise HealthError('current_required_sources')
 if any(bound[n]['sha256']!=d for n,d in pressure_java.items()):raise HealthError('current_pressure_java_changed')
 sync=validate_sync((repo/SYNC_PATH).read_bytes(),expected_sync_sha)
 if m.get('webSyncSha256')!=expected_sync_sha or m.get('webSourceSha')!=sync['web_source_commit'] or m.get('packagedWebAssetsSha256')!=sha(json.dumps(sync['assets'],sort_keys=True,separators=(',',':')).encode()):raise HealthError('current_packaged_asset_binding')
 return {'source_sha':m['sourceSha'],'java_source_pins':[r for r in source if r['path'] in pressure_java],
  'web_source_sha':sync['web_source_commit'],'web_sync_sha256':expected_sync_sha,'experiment_case_selection':expected_case_selection}
def bind_current(folder,expected_manifest_sha,expected_source_sha,expected_sync_sha,repo,expected_case_selection='comparison'):
 if not re.fullmatch(r'[a-f0-9]{64}',expected_manifest_sha or '') or not re.fullmatch(r'[a-f0-9]{40}',expected_source_sha or ''):raise HealthError('current_build_trusted_hashes_required')
 p=Path(folder);repo=Path(repo);file=p/'manifest.json'
 if file.is_symlink() or file.stat().st_size>256*1024:raise HealthError('current_manifest_file_bound')
 raw=file.read_bytes()
 if sha(raw)!=expected_manifest_sha:raise HealthError('current_manifest_hash')
 try:m=json.loads(raw)
 except (ValueError,UnicodeError):raise HealthError('current_manifest_json') from None
 source_contract(m,expected_source_sha,expected_case_selection)
 rows=m.get('apks');pins={}
 if not isinstance(rows,list) or len(rows)!=5:raise HealthError('current_five_apks_required')
 for row in rows:
  name=row.get('name')
  if name not in APK_NAMES or name in pins or type(row.get('bytes')) is not int or not re.fullmatch(r'[a-f0-9]{64}',row.get('sha256','')) or not re.fullmatch(r'[a-f0-9]{64}',row.get('certificate_sha256','')):raise HealthError('current_apk_identity_row')
  size,digest=digest_file(p/name,256*1024*1024)
  if size!=row['bytes'] or digest!=row['sha256']:raise HealthError('current_apk_bytes')
  pins[name]=row
 if set(pins)!=APK_NAMES or pins['test-services-1.4.2.apk']['sha256']!=HELPER_SHA:raise HealthError('current_helper_same_bytes')
 source_binding=bind_current_source_metadata(p,m,expected_source_sha,expected_sync_sha,repo,expected_case_selection)
 return {**source_binding,'manifest_sha256':sha(raw),'apk_pins':pins,'artifact_source_kind':'new_current_r9_same_run_test_build',
  'new_build_or_signing':True,'distributable_release':False,'old_comparand_reused':False,'experiment_case_selection':expected_case_selection}

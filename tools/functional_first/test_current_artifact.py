"""Small UNIT_ONLY parser corruption tests; no APK/signature/device evidence."""
import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import current_artifact as c
from freeze_current import built_apk,instrumentation_target
from health import HealthError

class CurrentArtifactTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='UNIT_ONLY-current-artifact-');self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.repo=self.root/'repo';self.out=self.root/'artifact';self.repo.mkdir();self.out.mkdir()
  self.source='1'*40;assets=[{'path':p,'bytes':1,'sha256':'a'*64} for p in ('index.html','core.js','app.js','viewport.js','model-manifest.json')]
  self.sync={'schema':'current-r9-android-private-test-web-sync-v1','web_version':{'development_revision':'r9'},'web_source_commit':'2'*40,'assets':assets,'count':5}
  self.syncraw=json.dumps(self.sync).encode();self.syncsha=c.sha(self.syncraw)
  pressure={p:c.sha(('UNIT_ONLY '+p).encode()) for p in c.PRESSURE_JAVA}
  self.addCleanup(patch.stopall);patch.object(c,'PRESSURE_JAVA',pressure).start();patch.object(c,'HELPER_SHA',c.sha(b'UNIT_ONLY test-services-1.4.2.apk')).start()
  rows=[]
  for name in sorted(c.APK_NAMES):
   raw=('UNIT_ONLY '+name).encode();(self.out/name).write_bytes(raw);rows.append({'name':name,'bytes':len(raw),'sha256':c.sha(raw),'certificate_sha256':'a'*64})
  sources=[]
  for p in sorted(set(pressure)|{c.SYNC_PATH,c.WORKFLOW_PATH}):
   raw=self.syncraw if p==c.SYNC_PATH else ('UNIT_ONLY '+p).encode()
   for base in (self.repo,self.out/'source'):
    f=base/p;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(raw)
   sources.append({'path':p,'bytes':len(raw),'sha256':c.sha(raw)})
  self.manifest={'schema':'current-r9-functional-test-build-v1','sourceSha':self.source,'currentR9':True,'distributableRelease':False,'webSourceSha':'2'*40,'webSyncSha256':self.syncsha,'packagedWebAssetsSha256':c.sha(json.dumps(assets,sort_keys=True,separators=(',',':')).encode()),'apks':rows,'sourceFiles':sources}
  self.write()
 def write(self):
  raw=json.dumps(self.manifest).encode();(self.out/'manifest.json').write_bytes(raw);self.msha=c.sha(raw)
 def bind(self,**kw):
  return c.bind_current(self.out,kw.get('manifest',self.msha),kw.get('source',self.source),kw.get('sync',self.syncsha),self.repo)
 def test_valid_UNIT_ONLY_identity_shape_is_not_device_proof(self):
  r=self.bind();self.assertEqual(r['artifact_source_kind'],'new_current_r9_same_run_test_build');self.assertFalse(r['distributable_release'])
 def test_manifest_body_change_rejected_with_original_pin(self):
  (self.out/'manifest.json').write_bytes((self.out/'manifest.json').read_bytes()+b' ')
  with self.assertRaises(HealthError):self.bind()
 def test_wrong_or_missing_trusted_source_pin(self):
  for value in (None,'3'*40):
   with self.subTest(value=value),self.assertRaises(HealthError):self.bind(source=value)
 def test_old_comparand_schema_cannot_be_current(self):
  self.manifest['schema']='old-frozen-artifact';self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_changed_APK_rejected(self):
  (self.out/'app.apk').write_bytes(b'UNIT_ONLY changed')
  with self.assertRaises(HealthError):self.bind()
 def test_duplicate_APK_cannot_hide_missing_helper(self):
  self.manifest['apks'][-1]=self.manifest['apks'][0];self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_repo_source_bytes_must_equal_manifest_and_artifact(self):
  (self.repo/c.WORKFLOW_PATH).write_bytes(b'UNIT_ONLY changed source')
  with self.assertRaises(HealthError):self.bind()
 def test_parent_escape_source_path_rejected(self):
  self.manifest['sourceFiles'][0]['path']='../outside';self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_pressure_hash_cannot_be_changed(self):
  p=next(iter(c.PRESSURE_JAVA));raw=b'UNIT_ONLY altered pressure'
  for base in (self.repo,self.out/'source'):(base/p).write_bytes(raw)
  row=next(r for r in self.manifest['sourceFiles'] if r['path']==p);row.update(bytes=len(raw),sha256=c.sha(raw));self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_wrong_web_sync_pin_or_asset_list_binding_rejected(self):
  with self.assertRaises(HealthError):self.bind(sync='b'*64)
  self.manifest['packagedWebAssetsSha256']='b'*64;self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_release_claim_rejected(self):
  self.manifest['distributableRelease']=True;self.write()
  with self.assertRaises(HealthError):self.bind()
 def test_actual_output_metadata_selects_one_built_filename(self):
  d=self.root/'build-output';d.mkdir();(d/'Chosen-debug.apk').write_bytes(b'UNIT_ONLY no actual APK')
  (d/'output-metadata.json').write_text(json.dumps({'elements':[{'outputFile':'Chosen-debug.apk'}]}))
  self.assertEqual(built_apk(d),d/'Chosen-debug.apk')
  (d/'output-metadata.json').write_text(json.dumps({'elements':[{'outputFile':'../outside.apk'}]}))
  with self.assertRaises(ValueError):built_apk(d)
 def test_instrumentation_XML_binds_exact_runner_and_target(self):
  raw=b'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><instrumentation android:name="androidx.test.runner.AndroidJUnitRunner" android:targetPackage="unit.only"/></manifest>'
  instrumentation_target(raw,'unit.only')
  with self.assertRaises(ValueError):instrumentation_target(raw,'other.package')
  with self.assertRaises(ValueError):instrumentation_target(raw.replace(b'/></manifest>',b'/><instrumentation/></manifest>'),'unit.only')
if __name__=='__main__':unittest.main()

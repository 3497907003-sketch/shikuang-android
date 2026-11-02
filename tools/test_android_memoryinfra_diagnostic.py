"""Pure host tests; synthetic subprocesses only, no APK, AVD or model run.

Workflow semantics require PyYAML in the host test environment.
"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import os
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import android_memoryinfra_diagnostic as m
import android_pretest_install_diagnostic as p

class RunnerTests(unittest.TestCase):
    def env(self):return {'GITHUB_ACTIONS':'true','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'b'*40,'GITHUB_RUN_ID':'123','SHIKUANG_MEMORYINFRA_DIAGNOSTIC':'true'}
    def test_disabled_or_wrong_dispatch_never_passes(self):
        self.assertEqual(m.authentication('b'*40,'a'*32,{'schema':'memoryinfra-dispatch-config-v1','enabled':True},self.env(),'b'*40)['run_id'],'123')
        for key,value in [('GITHUB_EVENT_NAME','push'),('GITHUB_RUN_ATTEMPT','2'),('SHIKUANG_PRETEST_INSTALL','true'),('GITHUB_SHA','c'*40),('SHIKUANG_MEMORYINFRA_DIAGNOSTIC','false')]:
            e=self.env();e[key]=value
            with self.assertRaises(ValueError):m.authentication('b'*40,'a'*32,{'schema':'memoryinfra-dispatch-config-v1','enabled':True},e,'b'*40)
        with self.assertRaises(ValueError):m.authentication('b'*40,'a'*32,{'schema':'memoryinfra-dispatch-config-v1','enabled':False},self.env(),'b'*40)
    def test_nonce_binding_unique_fixed_enum(self):
        values=[m.arm_nonce('a'*32,a) for a in m.ARMS];self.assertEqual(len(set(values)),3)
        self.assertTrue(all(len(v)==32 for v in values));self.assertEqual(values[0],m.arm_nonce('a'*32,m.ARMS[0]))
        for nonce,arm in [('../path',m.ARMS[0]),('a'*32,'../../path')]:
            with self.assertRaises(ValueError):m.arm_nonce(nonce,arm)
    def test_os_build_id_and_webview_elf_id_are_separate(self):
        self.assertEqual(m.OS_BUILD_ID,'AE3A.240806.043');self.assertEqual(m.elf_build_id((' Build ID: '+m.ELF_BUILD_ID+'\n').encode()),m.ELF_BUILD_ID)
        with self.assertRaises(ValueError):m.elf_build_id(b'Build ID: AE3A.240806.043\n')
        with self.assertRaises(ValueError):m.elf_build_id(('Build ID: '+m.ELF_BUILD_ID+'\n') .encode()*2)
    def test_provider_path_rejects_shell_traversal_multiple_or_other_root(self):
        self.assertEqual(m.provider_path(b'package:/data/app/~~abc/pkg/base.apk\n'),'/data/app/~~abc/pkg/base.apk')
        for raw in [b'package:/data/app/../escape.apk',b'package:/tmp/base.apk',b'package:/data/app/base.apk\npackage:/data/app/other.apk',b'package:/data/app/$(bad).apk']:
            with self.assertRaises(ValueError):m.provider_path(raw)
    def test_installed_revision_is_hard_gate(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder=root/'system-images/android-35/google_apis_ps16k/x86_64';folder.mkdir(parents=True)
            (folder/'source.properties').write_text('Pkg.Revision=5\nAndroidVersion.ApiLevel=35\nSystemImage.Abi=x86_64\n');(folder/'package.xml').write_text('<package/>')
            self.assertEqual(m.installed_image(root,{'image':{'revision':5}})[1],b'<package/>')
            with self.assertRaises(ValueError):m.installed_image(root,{'image':{'revision':4}})
    def test_original_freeze_auth_still_precedes_neutral_core(self):
        args=SimpleNamespace(source='b'*40,nonce='a'*32)
        with patch.object(p,'identity',return_value={'original':'auth'}) as auth,patch.object(p,'freeze_artifacts',return_value='done') as core:
            self.assertEqual(p.freeze(args),'done');auth.assert_called_once();core.assert_called_once_with(args,{'original':'auth'})
        with patch.object(p,'identity',side_effect=ValueError('old auth rejected')),patch.object(p,'freeze_artifacts') as core:
            with self.assertRaises(ValueError):p.freeze(args)
            core.assert_not_called()
    def test_recorder_default_and_explicit_stdout_cap(self):
        with tempfile.TemporaryDirectory() as d:
            recorder=p.Recorder(Path(d),seconds=5)
            self.assertEqual(recorder.run('small',[sys.executable,'-c',"print('ok')"],seconds=2),b'ok\n')
            with self.assertRaises(ValueError):recorder.run('oversize',[sys.executable,'-c',"print('x'*40)"],seconds=2,stdout_cap=8)
            self.assertGreater(recorder.receipts[-1]['stdout_bytes'],8)
            with self.assertRaises(ValueError):recorder.run('bad-cap',[sys.executable,'-c','pass'],stdout_cap=0)
    def test_bad_owner_performs_zero_ADB_and_fails_with_host_receipt(self):
        auth={'source_sha':'b'*40,'unit_nonce':'a'*32,'run_id':'123','run_attempt':1}
        build={'plan_sha256':'c'*64,'source_sha':'b'*40,'run_id':'123','actual_packaged_assets_verified':168}
        labels=[]
        class FakeRecorder:
            def __init__(self,out,**kwargs):self.out=out
            def run(self,label,argv,**kwargs):
                labels.append(label);(self.out/(label+'.stdout.bin')).write_bytes(b'partial');return b'partial'
        def bounded(path,cap):
            if path.name=='memoryinfra-build-receipt.json':return json.dumps(build).encode()
            return b'{}'
        with tempfile.TemporaryDirectory() as d:
            args=SimpleNamespace(source='b'*40,nonce='a'*32,arm=m.ARMS[0],plan_sha='c'*64,out=Path(d)/'out',owner=Path(d)/'owner',sdk=Path(d)/'sdk')
            with patch.object(m,'source_contract',return_value=(auth,{},{})),patch.object(p,'bounded',side_effect=bounded),patch.object(p,'check_plan',return_value={'apks':[]}),patch.object(p,'Recorder',FakeRecorder),patch.dict(m.os.environ,{'GITHUB_RUN_ID':'123'}):
                with self.assertRaisesRegex(ValueError,'diagnostic arm failed'):m.run_arm(args)
            report=json.loads((args.out/'arm-report.json').read_text());self.assertFalse(report['passed']);self.assertFalse(report['product_acceptance'])
            self.assertEqual(labels,[])
            self.assertFalse(report['owned_transport_verified'])
            self.assertIn('no further transport',report['transport_cleanup_skipped'])
            self.assertIn('owned fresh fixed AVD',report['failure'])
    def test_setup_preservation_never_queries_unowned_transport(self):
        with tempfile.TemporaryDirectory() as d:
            args=SimpleNamespace(source='b'*40,nonce='a'*32,arm=m.ARMS[0],out=Path(d)/'out',owner=Path(d)/'absent')
            with patch.object(m,'source_contract',return_value=({'source_sha':'b'*40},{},{})),patch.object(p,'Recorder') as recorder:
                m.preserve_setup(args);recorder.assert_not_called()
            report=json.loads((args.out/'setup-evidence-report.json').read_text());self.assertTrue(report['owned_emulator_never_launched'])
    def test_actual_AVD_mismatch_stops_before_any_finally_transport_query(self):
        nonce=m.arm_nonce('a'*32,m.ARMS[0]);owner={'source_sha':'b'*40,'arm_nonce':nonce,'arm':m.ARMS[0],'PID':100,'argv':['emulator','-avd','shikuang-memoryinfra-'+nonce,'-memory','4096','-cores','2','-no-snapshot']}
        auth={'source_sha':'b'*40,'unit_nonce':'a'*32,'run_id':'123','run_attempt':1};build={'plan_sha256':'c'*64,'source_sha':'b'*40,'run_id':'123','actual_packaged_assets_verified':168};labels=[]
        class FakeRecorder:
            def __init__(self,out,**kwargs):self.out=out
            def command(self,label,argv,**kwargs):labels.append(label);return b'unowned-avd\nOK\n'
            def run(self,*args,**kwargs):raise AssertionError('unverified transport must not be queried again')
        def bounded(path,cap):
            if path.name=='memoryinfra-build-receipt.json':return json.dumps(build).encode()
            if path.name=='owner':return json.dumps(owner).encode()
            return b'{}'
        with tempfile.TemporaryDirectory() as d:
            args=SimpleNamespace(source='b'*40,nonce='a'*32,arm=m.ARMS[0],plan_sha='c'*64,out=Path(d)/'out',owner=Path(d)/'owner',sdk=Path(d)/'sdk')
            with patch.object(m,'source_contract',return_value=(auth,{},{})),patch.object(p,'bounded',side_effect=bounded),patch.object(p,'check_plan',return_value={'apks':[]}),patch.object(p,'Recorder',FakeRecorder),patch.dict(m.os.environ,{'GITHUB_RUN_ID':'123'}):
                with self.assertRaises(ValueError):m.run_arm(args)
            self.assertEqual(labels,['actual-avd']);self.assertFalse(json.loads((args.out/'arm-report.json').read_text())['owned_transport_verified'])
    def test_log_cleanup_unconfirmed_or_exception_keeps_collection_and_failure(self):
        for stop in [None,RuntimeError('synthetic cleanup error'),0]:
            nonce=m.arm_nonce('a'*32,m.ARMS[0]);avd='shikuang-memoryinfra-'+nonce
            owner={'source_sha':'b'*40,'arm_nonce':nonce,'arm':m.ARMS[0],'PID':100,'argv':['emulator','-avd',avd,'-memory','4096','-cores','2','-no-snapshot']}
            auth={'source_sha':'b'*40,'unit_nonce':'a'*32,'run_id':'123','run_attempt':1};build={'plan_sha256':'c'*64,'source_sha':'b'*40,'run_id':'123','actual_packaged_assets_verified':168};labels=[]
            class FakeRecorder:
                def __init__(self,out,**kwargs):self.out=out
                def network(self,label):pass
                def command(self,label,argv,**kwargs):
                    labels.append(label)
                    values={'actual-avd':(avd+'\nOK\n').encode(),'qemu':b'1','sdk':b'35','abi':b'x86_64','page':b'16384','os-build-id':m.OS_BUILD_ID.encode(),'os-fingerprint':m.FINGERPRINT.encode(),'guest-memory':b'MemTotal: 4000000 kB','before-app-pid':b''}
                    return b'123' if label.startswith('app-pid-') else values[label]
                def run(self,label,argv,**kwargs):
                    labels.append(label)
                    if label=='instrumentation':kwargs['monitor'](time.monotonic()+5)
                    (self.out/(label+'.stdout.bin')).write_bytes(b'partial');return b'partial'
            def bounded(path,cap):
                if path.name=='memoryinfra-build-receipt.json':return json.dumps(build).encode()
                if path.name=='owner':return json.dumps(owner).encode()
                return b'{}'
            log=SimpleNamespace(pid=99,poll=lambda:None)
            with tempfile.TemporaryDirectory() as d:
                args=SimpleNamespace(source='b'*40,nonce='a'*32,arm=m.ARMS[0],plan_sha='c'*64,out=Path(d)/'out',owner=Path(d)/'owner',sdk=Path(d)/'sdk')
                stop_patch=patch.object(p,'stop_owned',side_effect=stop) if isinstance(stop,Exception) else patch.object(p,'stop_owned',return_value={'terminal_return_code':stop})
                with patch.object(m,'source_contract',return_value=(auth,{},{})),patch.object(p,'bounded',side_effect=bounded),patch.object(p,'check_plan',return_value={'apks':[]}),patch.object(p,'Recorder',FakeRecorder),patch.object(m,'stock_provider',return_value={}),patch.object(m,'installed_image',return_value=(b'p',b'x')),patch.object(m.subprocess,'Popen',return_value=log),stop_patch,patch.object(m.journal,'collect',return_value={'diagnostic_observation_complete':True}),patch.dict(m.os.environ,{'GITHUB_RUN_ID':'123'}):
                    if stop==0:m.run_arm(args)
                    else:
                        with self.assertRaises(ValueError):m.run_arm(args)
                report=json.loads((args.out/'arm-report.json').read_text());self.assertEqual(report['passed'],stop==0)
                self.assertIn('journal-tar',labels);self.assertIn('final-provider',labels)
                if stop!=0:self.assertTrue(report['cleanup_errors'])
    def test_actual_static_library_metadata_join_without_fixed_package_suffix(self):
        use=m.static_use(b'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.google.android.webview"><application><uses-static-library android:name="com.vendor.trichromelibrary" android:version="42"/></application></manifest>')
        rows=m.static_candidates(b'<packages><package name="com.vendor.trichromelibrary_ARBITRARY" realName="com.vendor.trichromelibrary" codePath="/data/app/real" version="42"/></packages>',use)
        self.assertEqual(rows[0]['package'],'com.vendor.trichromelibrary_ARBITRARY')
        manifest=b'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.vendor.trichromelibrary"><application><static-library android:name="com.vendor.trichromelibrary" android:version="42"/></application></manifest>'
        self.assertTrue(m.static_definition(manifest,use));self.assertFalse(m.static_definition(manifest,{**use,'version':'43'}))
        with self.assertRaises(ValueError):m.static_candidates(b'<packages><package name="com.vendor.trichromelibrary_42" codePath="/data/app/../bad" version="42"/></packages>',use)
        self.assertNotIn('com.google.android.trichromelibrary_636771938',(ROOT/'tools/android_memoryinfra_diagnostic.py').read_text())
    def test_actual_apkanalyzer_and_qualified_same_value_attribute_shapes(self):
        import xml.etree.ElementTree as ET
        raw=(ROOT/'tools/fixtures/memoryinfra-webview-static-use.actual.xml').read_bytes()
        provenance=json.loads((ROOT/'tools/fixtures/memoryinfra-webview-static-use.provenance.json').read_text())
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'aa8b2ede2747c2bf2b1002fcf6a4c458f421630cb236373a8787ce69b2d4a5a8')
        self.assertEqual(provenance['fixture_sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(provenance['original_manifest_sha256'],'db766f0eb32aab98a70954e3f1c283ced9a4b18e03ae5affd9d01b23909c1d16')
        self.assertEqual((provenance['run_id'],provenance['run_attempt']),(41403807314,1))
        self.assertEqual(provenance['member'],'arm/calls/webview-actual-manifest.stdout.bin')
        expected={'name':'com.google.android.trichromelibrary','version':'636771938'}
        self.assertEqual(m.static_use(raw),expected)
        ns='{http://schemas.android.com/apk/res/android}'
        for carrier in ['uses-static-library','static-library']:
            for representation in ['actual-unqualified','source-qualified','both-same-value']:
                with self.subTest(carrier=carrier,representation=representation):
                    manifest=ET.Element('manifest',{'package':'com.google.android.webview' if carrier=='uses-static-library' else expected['name']})
                    item=ET.SubElement(ET.SubElement(manifest,'application'),carrier)
                    for name,value in expected.items():
                        if representation!='source-qualified':item.set(name,value)
                        if representation!='actual-unqualified':item.set(ns+name,value)
                    encoded=ET.tostring(manifest)
                    if carrier=='uses-static-library':self.assertEqual(m.static_use(encoded),expected)
                    else:self.assertTrue(m.static_definition(encoded,expected))

    def test_Android_manifest_mixed_attribute_conflicts_fail_closed(self):
        import xml.etree.ElementTree as ET
        expected={'name':'com.google.android.trichromelibrary','version':'636771938'}
        ns='{http://schemas.android.com/apk/res/android}'
        for carrier in ['uses-static-library','static-library']:
            for conflict in ['name','version']:
                with self.subTest(carrier=carrier,conflict=conflict):
                    manifest=ET.Element('manifest',{'package':'com.google.android.webview' if carrier=='uses-static-library' else expected['name']})
                    item=ET.SubElement(ET.SubElement(manifest,'application'),carrier)
                    for name,value in expected.items():item.set(name,value);item.set(ns+name,value)
                    item.set(ns+conflict,'com.wrong.trichromelibrary' if conflict=='name' else '636771939')
                    with self.assertRaisesRegex(ValueError,'conflicting Android manifest attribute: '+conflict):
                        if carrier=='uses-static-library':m.static_use(ET.tostring(manifest))
                        else:m.static_definition(ET.tostring(manifest),expected)

    def test_parent_default_runtime_is_unchanged_and_memoryinfra_route_is_mixed_safe(self):
        import yaml
        parent=yaml.load((ROOT/'.github/workflows/android-runtime.yml').read_text(),Loader=yaml.BaseLoader)
        # Semantic SHA snapshots from App BASE 5a004ef9 (YAML BaseLoader,
        # sorted compact JSON). No candidate tree, git history or network required.
        def semantic_sha(value):
            return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        runtime=dict(parent['jobs']['runtime']);new_if=runtime.pop('if')
        self.assertEqual(semantic_sha(runtime),'18d23945e60406f9b59b72527e4b4ba501c1fa216b315476835372a3e6ab37be')
        old_if="${{ !(github.event_name == 'workflow_dispatch' && (inputs.lifecycle_diagnostic || inputs.native_dialog_diagnostic || inputs.pretest_install_diagnostic)) }}"
        self.assertEqual(new_if,old_if.replace('inputs.pretest_install_diagnostic','inputs.pretest_install_diagnostic || inputs.memoryinfra_diagnostic'))
        expected_jobs={'lifecycle-diagnostic': '317d8cf29493f34dc28e22a44d0e7992f05968c32c89c809fe7dcd08b86412d5', 'native-dialog-diagnostic': '6d8b87aebf39e1148d2a4e5dae923f5ea45f7fd4a87993c907e92e2d1fc4fe99', 'pretest-install-diagnostic': 'ac376c84f065fb1f025d033259f6d2074a5026e4effa25fb3e21968e85336dff'}
        for name,wanted in expected_jobs.items():self.assertEqual(semantic_sha(parent['jobs'][name]),wanted)
        old_inputs={name:value for name,value in parent['on']['workflow_dispatch']['inputs'].items() if name!='memoryinfra_diagnostic'}
        self.assertEqual(semantic_sha(old_inputs),'00dde5291caf4a14e37e776743b204e22caa04326f894c3efd62314aa7d187b7')
        self.assertEqual(parent['on']['workflow_dispatch']['inputs']['memoryinfra_diagnostic']['default'],'false')
        self.assertEqual(parent['jobs']['memoryinfra-diagnostic']['needs'],'dispatch-contract')
        run=parent['jobs']['dispatch-contract']['steps'][0]['run'];code=run.split("<<'PY_RENDER_DISPATCH'\n",1)[1].rsplit('PY_RENDER_DISPATCH',1)[0]
        flags=['NETWORK_PROBE','NATIVE_DIALOG_DIAGNOSTIC','LIFECYCLE_DIAGNOSTIC','RUNTIME_16K_ONLY','RENDER_DIAGNOSTIC','PRETEST_INSTALL']
        env={**os.environ,**{k:'false' for k in flags},'MEMORYINFRA_DIAGNOSTIC':'false','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','EXPECTED_SOURCE':'b'*40,'GITHUB_SHA':'b'*40,'UNIT_NONCE':'a'*32}
        self.assertEqual(subprocess.run([sys.executable,'-c',code],env=env,capture_output=True).returncode,0)
        env['MEMORYINFRA_DIAGNOSTIC']='true';self.assertEqual(subprocess.run([sys.executable,'-c',code],env=env,capture_output=True).returncode,0)
        for flag in flags:self.assertNotEqual(subprocess.run([sys.executable,'-c',code],env={**env,flag:'true'},capture_output=True).returncode,0)
        build=yaml.load((ROOT/'.github/workflows/android-memoryinfra-diagnostic.yml').read_text(),Loader=yaml.BaseLoader)['jobs']['build']
        self.assertTrue(any(step.get('if')=='always()' and step.get('uses','').startswith('actions/upload-artifact') for step in build['steps']))
    def test_candidate_workflow_optin_and_same_build_matrix(self):
        source=(ROOT/'.github/workflows/android-memoryinfra-diagnostic.yml').read_text()
        self.assertIn('workflow_dispatch:',source);self.assertIn('workflow_call:',source);self.assertNotIn('\n  push:',source)
        self.assertIn('max-parallel: 3',source);self.assertIn('fail-fast: false',source)
        self.assertEqual(source.count(':app:exportPretestInstallInputs'),1)
        self.assertIn('name: memoryinfra-same-build-${{ github.run_id }}',source)
        self.assertIn('if: always()',source);self.assertNotIn('disable-memory',source)
    def test_config_explicit_enable_and_current_not_historical_revision(self):
        config=json.loads((ROOT/'tools/memoryinfra-config.json').read_text())
        self.assertIs(type(config['enabled']),bool);self.assertEqual(config['image']['revision'],5)
        self.assertIsNone(config['image']['historical_failed_revision'])
        self.assertFalse(config['image']['archive_downloaded_in_preparation'])
        for path,wanted in config['tool_sha256'].items():self.assertEqual(m.digest((ROOT/path).read_bytes()),wanted)

if __name__=='__main__':unittest.main()

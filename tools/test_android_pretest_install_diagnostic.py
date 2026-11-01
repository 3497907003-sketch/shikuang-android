"""Synthetic APK bytes and real local subprocess fixtures, never an Android pass."""
import contextlib
import copy
import io
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch

import android_pretest_install_diagnostic as probe

REPO = Path(__file__).resolve().parents[1]
SOURCE, NONCE = 'a'*40, 'b'*32

FAKE_ADB = r'''
import json,os,sys,time
from pathlib import Path
root=Path(os.environ['FAKE_DEVICE_ROOT']);argv=sys.argv[1:]
with (root/'trace.jsonl').open('a') as f:f.write(json.dumps(argv)+'\n')
if argv==['devices']:
 print('List of devices attached\nemulator-5554\tdevice\n');sys.exit(0)
assert argv[:2]==['-s','emulator-5554'];a=argv[2:]
scenario=os.environ.get('FAKE_SCENARIO','pass')
if a[:1]==['logcat']:
 print('11-01 00:00:00.000 1 1 I Fixture: boot log',flush=True)
 while True:
  if (root/'fatal').exists():
   print('11-01 00:00:01.000 500 501 F libc: Fatal signal 11 system_server',flush=True)
   time.sleep(10)
  time.sleep(.01)
if a==['emu','avd','name']:print('shikuang-pretest-'+os.environ['FAKE_NONCE']+'\nOK')
elif a[:1]==['install']:
 name=Path(a[-1]).name
 print('install started '+name,flush=True)
 if scenario=='timeout' and name=='01-app.apk':time.sleep(10)
 if scenario=='services-fail' and name=='02-test-services.apk':
  print('package service Broken pipe',file=sys.stderr);sys.exit(1)
 if scenario=='app-fail' and name=='01-app.apk':sys.exit(1)
 if scenario=='pid-change' and name=='01-app.apk':(root/'pid-changed').touch()
 if scenario=='boot-change' and name=='02-test-services.apk':(root/'boot-changed').touch()
 if scenario=='fatal' and name=='01-app.apk':(root/'fatal').touch();time.sleep(.2)
 (root/name).touch();print('Success')
elif a==['shell','getprop','ro.kernel.qemu']:print('1')
elif a==['shell','getprop','ro.build.version.sdk']:print('35')
elif a==['shell','getconf','PAGE_SIZE']:print('16384')
elif a==['shell','id','-u']:print('0')
elif a==['shell','cat','/proc/meminfo']:print('MemTotal: 4014392 kB')
elif a==['shell','dumpsys','connectivity']:print('Active default network: none')
elif a[:3]==['shell','ip','route'] or a[:3]==['shell','ip','-6']:pass
elif a==['shell','cat','/proc/sys/kernel/random/boot_id']:
 print('11111111-2222-3333-4444-555555555556' if (root/'boot-changed').exists() else '11111111-2222-3333-4444-555555555555')
elif a==['shell','pidof','system_server']:
 count=int((root/'health-count').read_text()) if (root/'health-count').exists() else 0
 (root/'health-count').write_text(str(count+1))
 if scenario=='preinstall-slow-health' and count>=1:time.sleep(1)
 print('501' if (root/'pid-changed').exists() else '500')
elif a==['shell','service','check','package']:print('Service package: found')
elif a[:3]==['shell','pm','path']:
 names={'com.shikuang.app.preview':'01-app.apk','androidx.test.services':'02-test-services.apk','com.shikuang.app.preview.test':'03-app-test.apk'}
 if (root/names[a[3]]).exists():print('package:/data/app/base.apk')
 else:sys.exit(1)
elif a[:3]==['shell','dumpsys','package']:print('versionCode=1 minSdk=24')
else:raise RuntimeError(a)
'''


def fixture(root):
    (root/'apks').mkdir();rows=[]
    for role,name,package in probe.ROLES:
        raw=('synthetic-'+name).encode();(root/'apks'/name).write_bytes(raw)
        rows.append({'role':role,'path':'apks/'+name,'package':package,'bytes':len(raw),
                     'sha256':probe.sha(raw),'version_code':'1'})
    fake=root/'adb-fixture';fake.write_text('#!'+sys.executable+'\n'+textwrap.dedent(FAKE_ADB));fake.chmod(0o700)
    plan={'schema':'pretest-three-APKs-v1','source_sha':SOURCE,'unit_nonce':NONCE,'run_attempt':1,'run_id':'123',
          'apks':rows,'distributableRelease':False,'instrumentation_started':False,'fullRuntimeVerified':False}
    return fake,plan


class InputTests(unittest.TestCase):
    def test_metadata_resolves_exact_unsplit_output_and_rejects_ambiguous_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'output-metadata.json'
            p.write_text(json.dumps({'elements':[{'outputFile':'actual-renamed.apk','filters':[]}]}))
            self.assertEqual(probe.built_apk(p),root/'actual-renamed.apk')
            for row in [{'outputFile':'../else.apk'}, {'outputFile':'one.apk','filters':[{'filterType':'ABI','value':'arm64'}]}]:
                p.write_text(json.dumps({'elements':[row]}))
                with self.assertRaises(ValueError):probe.built_apk(p)
            p.write_text(json.dumps({'elements':[{'outputFile':'one.apk'},{'outputFile':'two.apk'}]}))
            with self.assertRaises(ValueError):probe.built_apk(p)

    def test_exact_three_source_nonce_and_frozen_byte_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);_,plan=fixture(root)
            with patch.object(probe,'HELPER_SHA',plan['apks'][1]['sha256']):
                raw=json.dumps(plan).encode();probe.check_plan(raw,probe.sha(raw),SOURCE,NONCE,root)
                with self.assertRaises(ValueError):probe.check_plan(raw,probe.sha(raw),SOURCE,NONCE,root,run_id='456')
                for change in ['source','nonce','order','missing','release']:
                    d=copy.deepcopy(plan)
                    if change=='source':d['source_sha']='c'*40
                    if change=='nonce':d['unit_nonce']='c'*32
                    if change=='order':d['apks'].reverse()
                    if change=='missing':d['apks'].pop()
                    if change=='release':d['distributableRelease']=True
                    r=json.dumps(d).encode()
                    with self.subTest(change=change),self.assertRaises(ValueError):probe.check_plan(r,probe.sha(r),SOURCE,NONCE,root)
                (root/'apks/01-app.apk').write_bytes(b'changed')
                with self.assertRaises(ValueError):probe.check_plan(raw,probe.sha(raw),SOURCE,NONCE,root)


class ActualSubprocessTests(unittest.TestCase):
    def observe(self,root,scenario):
        fake,plan=fixture(root);out=root/'result'
        if scenario=='preinstalled':(root/'02-test-services.apk').touch()
        env={'FAKE_DEVICE_ROOT':str(root),'FAKE_NONCE':NONCE,'FAKE_SCENARIO':scenario}
        with patch.dict(os.environ,env),patch.object(probe,'INSTALL_SECONDS',.5 if scenario in ('timeout','preinstall-slow-health') else 3):
            if scenario=='pass':result=probe.observe_install(plan,root,out,adb=str(fake),seconds=15)
            else:
                with self.assertRaises(ValueError):probe.observe_install(plan,root,out,adb=str(fake),seconds=15)
                result=json.loads((out/'report.json').read_bytes())
        trace=[json.loads(l) for l in (root/'trace.jsonl').read_text().splitlines()]
        installs=[a for a in trace if a[2:3]==['install']]
        return result,installs,out

    def test_three_real_fixture_subprocesses_have_receipts_but_no_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,out=self.observe(Path(tmp),'pass')
            self.assertEqual([Path(a[-1]).name for a in installs],['01-app.apk','02-test-services.apk','03-app-test.apk'])
            self.assertEqual(result['state'],'installation_observed')
            self.assertIs(result['instrumentation_started'],False);self.assertIs(result['fullRuntimeVerified'],False)
            self.assertTrue(all(s['finished_monotonic'] <= s['deadline_monotonic'] for s in result['package_stages']))
            receipts=json.loads((out/'command-receipts.json').read_bytes())
            for row in receipts:
                self.assertLessEqual(row['finished_monotonic'],row['deadline_monotonic']+.2)
                for s in ['stdout','stderr']:
                    self.assertEqual(row[s+'_sha256'],probe.sha((out/(row['label']+'.'+s+'.bin')).read_bytes()))
            snapshot=result['original_logs'][0]['snapshot'];p=Path(snapshot['path'])
            self.assertEqual(snapshot['sha256'],probe.sha(p.read_bytes()))

    def test_second_package_failure_executes_no_third_package_and_keeps_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,out=self.observe(Path(tmp),'services-fail')
            self.assertEqual(len(installs),2);self.assertEqual(result['state'],'pretest_install_failed')
            self.assertIsNone(result['root_cause_attributed_to_package'])
            self.assertTrue(result['device_current_install_completion_unknown'])
            self.assertIn(b'Broken pipe',(out/'install-services.stderr.bin').read_bytes())

    def test_system_PID_change_after_first_package_prevents_all_later_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,_=self.observe(Path(tmp),'pid-change')
            self.assertEqual(len(installs),1);self.assertEqual(result['state'],'pretest_install_failed')
            self.assertIn('system_server_or_boot_changed',result['failure'])

    def test_first_package_nonzero_never_starts_service_or_test_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,_=self.observe(Path(tmp),'app-fail')
            self.assertEqual(len(installs),1);self.assertEqual(result['state'],'pretest_install_failed')

    def test_guest_boot_change_after_service_prevents_test_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,_=self.observe(Path(tmp),'boot-change')
            self.assertEqual(len(installs),2);self.assertEqual(result['state'],'pretest_install_failed')
            self.assertIn('system_server_or_boot_changed',result['failure'])

    def test_preexisting_service_is_preserved_and_no_package_is_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);result,installs,_=self.observe(root,'preinstalled')
            self.assertEqual(installs,[]);self.assertTrue((root/'02-test-services.apk').exists())
            self.assertIn('package_preexists_no_uninstall',result['failure'])

    def test_native_fatal_in_real_log_stream_stops_all_later_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,_=self.observe(Path(tmp),'fatal')
            self.assertEqual(len(installs),1);self.assertEqual(result['state'],'pretest_install_failed')
            self.assertTrue(result['observed_crash_lines'])

    def test_install_timeout_keeps_partial_stdout_and_no_followup_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,out=self.observe(Path(tmp),'timeout')
            self.assertEqual(len(installs),1);self.assertEqual(result['state'],'pretest_install_failed')
            self.assertIn(b'install started',(out/'install-app.stdout.bin').read_bytes())
            self.assertTrue(result['device_current_install_completion_unknown'])

    def test_package_deadline_includes_health_before_the_install_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,installs,_=self.observe(Path(tmp),'preinstall-slow-health')
            self.assertEqual(installs,[])
            self.assertEqual(result['package_stages'][0]['state'],'failed')
            self.assertIn('command_deadline',result['failure'])

    def test_total_deadline_includes_nested_health_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);host=probe.Recorder(root,seconds=.4);started=time.monotonic()
            def health(end):host.run('slow-health',[sys.executable,'-c','import time;time.sleep(10)'],seconds=3,deadline=end)
            with self.assertRaises(ValueError):
                host.run('slow-install',[sys.executable,'-c','import time;time.sleep(10)'],seconds=90,monitor=health)
            self.assertLess(time.monotonic()-started,1)
            self.assertTrue(host.receipts[0]['stopped_on_health'])
            self.assertTrue(host.receipts[1]['timed_out'])


class RoutingTests(unittest.TestCase):
    def test_actual_shared_guard_rejects_mixed_modes_retry_and_wrong_source(self):
        text=(REPO/'.github/workflows/android-runtime.yml').read_text()
        code=textwrap.dedent(text.split("python3 -B - <<'PY_RENDER_DISPATCH'\n",1)[1].split('          PY_RENDER_DISPATCH',1)[0])
        base={'PRETEST_INSTALL':'true','RENDER_DIAGNOSTIC':'false','GITHUB_EVENT_NAME':'workflow_dispatch',
              'GITHUB_RUN_ATTEMPT':'1','EXPECTED_SOURCE':SOURCE,'GITHUB_SHA':SOURCE,'UNIT_NONCE':NONCE}
        flags=['NETWORK_PROBE','NATIVE_DIALOG_DIAGNOSTIC','LIFECYCLE_DIAGNOSTIC','RUNTIME_16K_ONLY']
        for values in itertools.product(['true','false'],repeat=4):
            e={**base,**dict(zip(flags,values))}
            with patch.dict(os.environ,e,clear=True),contextlib.redirect_stdout(io.StringIO()):
                if 'true' in values:
                    with self.assertRaises(SystemExit):exec(compile(code,'actual-guard','exec'),{})
                else:exec(compile(code,'actual-guard','exec'),{})
        for key,value in [('RENDER_DIAGNOSTIC','true'),('GITHUB_RUN_ATTEMPT','2'),('EXPECTED_SOURCE','c'*40),('UNIT_NONCE','')]:
            with patch.dict(os.environ,{**base,**dict.fromkeys(flags,'false'),key:value},clear=True),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
                exec(compile(code,'actual-guard','exec'),{})

    def version_preflight_fixture(self, backend_fails=False):
        workflow=(REPO/'.github/workflows/android-runtime.yml').read_text()
        setup=workflow.split('      - name: Prepare official build tools and one fresh 16K AVD\n',1)[1].split('      - name: Build only ',1)[0]
        # Execute the actual SDK identity/version commands, not a copied shell implementation.
        lines=[line.strip() for line in setup.splitlines() if '/emulator/' in line and
               any(token in line for token in ['source.properties', 'emulator-binary.sha256', 'emulator-version'])]
        with tempfile.TemporaryDirectory(prefix='headless SDK fixture ') as tmp:
            root=Path(tmp);sdk=root/'SDK with spaces';(sdk/'emulator').mkdir(parents=True)
            out=root/'runtime-artifacts/pretest-install';out.mkdir(parents=True)
            metadata=b'Pkg.Revision=99.0.0.fixture\n';(sdk/'emulator/source.properties').write_bytes(metadata)
            emulator=sdk/'emulator/emulator'
            emulator.write_text('#!'+sys.executable+'\n'+textwrap.dedent(r"""
                import json,os,sys
                from pathlib import Path
                Path('version-argv.json').write_text(json.dumps(sys.argv[1:]))
                if sys.argv[1:]!=['-no-window','-no-audio','-verbose','-version']:
                    print('fixture non-headless loader: libpulse.so.0 missing',file=sys.stderr);sys.exit(127)
                if os.environ.get('FAKE_HEADLESS_BACKEND_FAIL')=='true':
                    print('fixture headless loader failure',file=sys.stderr);sys.exit(127)
                print('Android emulator version 99.0.0.fixture')
                print('fixture version diagnostic retained',file=sys.stderr)
            """))
            emulator.chmod(0o700)
            env={**os.environ,'SHIKUANG_PRETEST_SDK':str(sdk),
                 'FAKE_HEADLESS_BACKEND_FAIL':str(backend_fails).lower()}
            run=subprocess.run(['bash','-e','-o','pipefail','-c','\n'.join(lines)+'\ntouch version-completed'],
                               cwd=root,env=env,capture_output=True,text=True,timeout=5)
            expected=127 if backend_fails else 0
            self.assertEqual(run.returncode,expected,(run.stdout,run.stderr,lines))
            self.assertEqual(json.loads((root/'version-argv.json').read_text()),['-no-window','-no-audio','-verbose','-version'])
            self.assertEqual((out/'emulator-source.properties').read_bytes(),metadata)
            self.assertEqual((out/'emulator-binary.sha256').read_text().split()[0],probe.sha(emulator.read_bytes()))
            self.assertEqual((root/'version-completed').exists(),not backend_fails)
            stdout=(out/'emulator-version.txt').read_text()
            stderr=(out/'emulator-version.stderr.txt').read_text()
            self.assertEqual(stdout,'' if backend_fails else 'Android emulator version 99.0.0.fixture\n')
            self.assertEqual(stderr,'fixture headless loader failure\n' if backend_fails else
                             'fixture version diagnostic retained\n')

    def test_headless_version_uses_boot_mode_and_preserves_actual_identity(self):
        self.version_preflight_fixture()

    def test_headless_version_failure_remains_failure_with_identity_and_stderr(self):
        self.version_preflight_fixture(backend_fails=True)

    def test_job_is_separate_and_never_invokes_instrumentation_or_old_five_APK_binder(self):
        text=(REPO/'.github/workflows/android-runtime.yml').read_text();job=text.split('\n  pretest-install-diagnostic:',1)[1]
        self.assertIn('default: false',text.split('      pretest_install_diagnostic:',1)[1].split('      expected_source_sha:',1)[0])
        self.assertIn(':app:exportPretestInstallInputs',job)
        self.assertNotIn('connectedDebugAndroidTest',job);self.assertNotIn('am instrument',job)
        self.assertNotIn('freeze_current.py',job);self.assertNotIn('pm clear',job);self.assertNotIn('uninstall',job)
        self.assertIn('shikuang-pretest-install-35-16k-',job)
        self.assertIn('--plan-sha "${{ steps.freeze.outputs.plan_sha }}"',job)
        init=(REPO/'tools/pretest_install_artifacts.init.gradle').read_text()
        self.assertIn("dependsOn 'assembleDebug', 'assembleDebugAndroidTest'",init)
        self.assertIn('detachedConfiguration',init);self.assertIn('resolved.singleFile',init)


if __name__=='__main__':unittest.main()

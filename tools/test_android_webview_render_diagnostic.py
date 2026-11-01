"""Pure SOURCE/log fixtures only; these tests never run Android or infer minerals."""
import contextlib
import io
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import android_webview_render_diagnostic as diagnostic

REPO = Path(__file__).resolve().parents[1]
SOURCE = 'a' * 40
NONCE = 'b' * 32


def environment(case='accelerated'):
    return {'SHIKUANG_RENDER_DIAGNOSTIC':'true','SHIKUANG_RENDER_CASE':case,
            'ORG_GRADLE_PROJECT_shikuangSoftwareDrawProbe':diagnostic.CASES[case][0],
            'SHIKUANG_RENDER_EXPECTED_SOURCE':SOURCE,'SHIKUANG_RENDER_UNIT_NONCE':NONCE,
            'GITHUB_SHA':SOURCE,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1'}


def draw(phase, *, view_hardware=True, canvas_hardware=True):
    row = {'schema':'debug-first-draw-v1','phase':phase,'pid':101,'viewIdentity':42,
           'elapsedRealtimeNanos':1000 if phase=='enter' else 2000}
    if phase=='enter':
        row.update(viewHardwareAccelerated=view_hardware,canvasHardwareAccelerated=canvas_hardware,layerType=0)
    return '11-01 12:00:00.000 101 101 I ShikuangRendering: '+json.dumps(row)+'\n'


class DrawingEvidenceTests(unittest.TestCase):
    def test_exact_profile_is_requested_configuration_not_observation(self):
        for case, (prop, expected) in diagnostic.CASES.items():
            value=diagnostic.profile_from_environment(environment(case),SOURCE)
            self.assertIs(value['desired_activity_hardware_acceleration'],expected)
            self.assertEqual(value['software_draw_Gradle_property'],prop)
            self.assertIs(value['product_acceptance'],False)
            self.assertIs(value['GPU_thread_absence_claim'],False)
            self.assertNotIn('observations',value)

    def test_profile_rejects_property_source_nonce_or_retry_drift(self):
        for key,value in [('ORG_GRADLE_PROJECT_shikuangSoftwareDrawProbe','true'),
                          ('SHIKUANG_RENDER_EXPECTED_SOURCE','c'*40),
                          ('SHIKUANG_RENDER_UNIT_NONCE',''),('GITHUB_RUN_ATTEMPT','2')]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                diagnostic.profile_from_environment({**environment(),key:value},SOURCE)

    def fixture_root(self, folder, *, case='accelerated', canvas=True, include_exit=True):
        profile=diagnostic.profile_from_environment(environment(case),SOURCE)
        text=draw('enter',view_hardware=diagnostic.CASES[case][1],canvas_hardware=canvas)
        if include_exit:text+=draw('exit')
        (folder/'logcat.txt').write_text(text+'unrelated log with tensor data not copied\n')
        (folder/'logcat-final.txt').write_text(text)
        (folder/'device-page-size.txt').write_text('16384\n')
        (folder/'emulator-configured-memory-mib.txt').write_text('4096\n')
        (folder/'guest-meminfo-before-install.txt').write_text('MemTotal: 4014392 kB\n')
        (folder/'runtime-smoke').mkdir()
        (folder/'runtime-smoke/runtime-report.json').write_text(json.dumps({'phase':'passed','coldProcessBaseline':{'firstPhasePid':101}}))
        return profile

    def test_raw_log_dedup_keeps_two_provenance_locations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=self.fixture_root(root)
            result=diagnostic.collect(profile,root,'success','success')
            self.assertEqual(result['diagnostic_status'],'observed')
            self.assertEqual(len(result['observations']),2)
            self.assertTrue(all(len(row['origins'])==2 for row in result['observations']))
            self.assertNotIn('unrelated',json.dumps(result))
            self.assertIs(result['runtime_failure_reclassified'],False)

    def test_software_case_requires_actual_software_window_and_canvas(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=self.fixture_root(root,case='software',canvas=False)
            result=diagnostic.collect(profile,root,'success','success')
            self.assertEqual(result['diagnostic_status'],'observed')
            self.assertIs(result['observations'][0]['facts']['canvasHardwareAccelerated'],False)
            (root/'logcat.txt').write_text(draw('enter',view_hardware=True)+draw('exit'))
            (root/'logcat-final.txt').unlink()
            result=diagnostic.collect(profile,root,'success','success')
            self.assertTrue(any('disagrees' in f for f in result['diagnostic_failures']))

    def test_hardware_window_can_have_a_real_software_bitmap_canvas(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=self.fixture_root(root,canvas=False)
            result=diagnostic.collect(profile,root,'success','success')
            self.assertEqual(result['diagnostic_status'],'observed')
            self.assertIs(result['observations'][0]['facts']['viewHardwareAccelerated'],True)
            self.assertIs(result['observations'][0]['facts']['canvasHardwareAccelerated'],False)

    def test_missing_exit_failed_runtime_remains_partial_not_passed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=self.fixture_root(root,include_exit=False)
            result=diagnostic.collect(profile,root,'failure','skipped')
            self.assertEqual((result['native_tests_outcome'],result['cold_process_outcome']),('failure','skipped'))
            self.assertEqual(result['diagnostic_status'],'partial_or_invalid')
            self.assertIs(result['product_acceptance'],False)

    def test_desired_profile_cannot_supply_missing_real_drawing_or_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=diagnostic.profile_from_environment(environment(),SOURCE)
            result=diagnostic.collect(profile,root,'success','skipped')
            self.assertEqual(result['observations'],[])
            self.assertEqual(result['diagnostic_status'],'partial_or_invalid')
            self.assertGreaterEqual(len(result['diagnostic_failures']),3)

    def test_boolean_strings_are_not_real_observations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=self.fixture_root(root)
            (root/'logcat.txt').write_text(draw('enter').replace('true','"true"'))
            (root/'logcat-final.txt').unlink()
            result=diagnostic.collect(profile,root,'success','success')
            self.assertTrue(result['parse_errors'])
            self.assertEqual(result['observations'],[])

    def test_CLI_retains_partial_evidence_but_cannot_greenwash_successful_runtime(self):
        for native,expected_code in [('success',1),('failure',0)]:
            with self.subTest(native=native),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);profile=diagnostic.profile_from_environment(environment(),SOURCE)
                source=root/'profile.json';source.write_text(json.dumps(profile));out=root/'actual.json'
                env={**os.environ,'SHIKUANG_NATIVE_OUTCOME':native,'SHIKUANG_COLD_OUTCOME':'skipped'}
                result=subprocess.run([sys.executable,'-B',str(REPO/'tools/android_webview_render_diagnostic.py'),
                    'collect','--profile',str(source),'--root',str(root),'--out',str(out)],
                    env=env,capture_output=True,timeout=3)
                self.assertEqual(result.returncode,expected_code)
                value=json.loads(out.read_text())
                self.assertEqual(value['native_tests_outcome'],native)
                self.assertEqual(value['diagnostic_status'],'partial_or_invalid')
                self.assertIs(value['runtime_failure_reclassified'],False)


class DrawingRoutingSourceTests(unittest.TestCase):
    def workflow(self):return (REPO/'.github/workflows/android-runtime.yml').read_text()

    def test_shared_gate_precedes_checkout_SDK_and_existing_jobs_depend_on_it(self):
        source=self.workflow();guard=source.split('  dispatch-contract:',1)[1].split('  runtime:',1)[0]
        self.assertNotIn('checkout@',guard);self.assertNotIn('setup-java',guard);self.assertNotIn('sdkmanager',guard)
        for name in ['runtime','lifecycle-diagnostic','native-dialog-diagnostic']:
            self.assertIn('  '+name+':\n    needs: dispatch-contract\n',source)
        self.assertIn("webview_render_diagnostic:\n        description:",source)
        flag=source.split('      webview_render_diagnostic:',1)[1].split('      expected_source_sha:',1)[0]
        self.assertIn('default: false',flag)

    def test_actual_inline_dispatch_code_rejects_every_mixed_mode_and_retry(self):
        source=self.workflow();code=textwrap.dedent(source.split("          python3 -B - <<'PY_RENDER_DISPATCH'\n",1)[1].split('          PY_RENDER_DISPATCH',1)[0])
        base={'RENDER_DIAGNOSTIC':'true','EXPECTED_SOURCE':SOURCE,'GITHUB_SHA':SOURCE,'UNIT_NONCE':NONCE,
              'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1'}
        flags=['NETWORK_PROBE','NATIVE_DIALOG_DIAGNOSTIC','LIFECYCLE_DIAGNOSTIC','RUNTIME_16K_ONLY']
        for values in itertools.product(('false','true'),repeat=4):
            e={**base,**dict(zip(flags,values))}
            with patch.dict(os.environ,e,clear=True),contextlib.redirect_stdout(io.StringIO()):
                if any(v=='true' for v in values):
                    with self.assertRaises(SystemExit):exec(compile(code,'actual-dispatch-gate','exec'),{})
                else:exec(compile(code,'actual-dispatch-gate','exec'),{})
        for key,value in [('GITHUB_RUN_ATTEMPT','2'),('EXPECTED_SOURCE',''),('UNIT_NONCE','bad')]:
            with patch.dict(os.environ,{**base,**dict.fromkeys(flags,'false'),key:value},clear=True),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit):
                exec(compile(code,'actual-dispatch-gate','exec'),{})
        # All old routing combinations remain outside this new mode's restrictions.
        with patch.dict(os.environ,{'RENDER_DIAGNOSTIC':'false',**dict.fromkeys(flags,'true')},clear=True),contextlib.redirect_stdout(io.StringIO()):
            exec(compile(code,'actual-dispatch-gate','exec'),{})

    def test_case_property_unique_artifacts_and_full_runtime_gates_remain(self):
        source=self.workflow();runtime=source.split('\n  lifecycle-diagnostic:',1)[0]
        self.assertIn("ORG_GRADLE_PROJECT_shikuangSoftwareDrawProbe: ${{ matrix.softwareDrawProbe || 'false' }}",runtime)
        self.assertIn("format('shikuang-drawing-diagnostic-{0}-{1}-{2}', matrix.id, matrix.renderCase, github.run_id)",runtime)
        self.assertIn('python3 -B tools/verify_ordinary_nine_test_results.py',runtime)
        self.assertIn('connectedDebugAndroidTest',runtime)
        self.assertIn('com.shikuang.app.MineralModelContractTest,com.shikuang.app.ReviewedPhotoAssetsInstrumentedTest,com.shikuang.app.MineralEngineInstrumentedTest',runtime)
        self.assertIn('python3 -B tools/android_cold_restart.py',runtime)
        self.assertIn("if: ${{ always() && inputs.webview_render_diagnostic }}",runtime)
        self.assertIn("assert cold['forceStopColdProcessVerified'] is True",runtime)
        self.assertIn('assert photo[\'photosDecoded\']',runtime)
        self.assertIn("and report['photoRecognitionVerified'] is True",runtime)

    def test_only_debug_manifest_overrides_activity_acceleration_and_observer_calls_super_once(self):
        main=(REPO/'android/app/src/main/AndroidManifest.xml').read_text()
        debug=(REPO/'android/app/src/debug/AndroidManifest.xml').read_text()
        self.assertIn('android:hardwareAccelerated="true"',main)
        self.assertNotIn('shikuangDiagnosticHardwareAcceleration',main)
        self.assertIn('android:hardwareAccelerated="${shikuangDiagnosticHardwareAcceleration}"',debug)
        gradle=(REPO/'android/app/build.gradle').read_text();release=gradle.split('        release {',1)[1].split('\n        }',1)[0]
        self.assertNotIn('shikuangSoftwareDrawProbe',release)
        self.assertIn("orElse('false')",gradle)
        view=(REPO/'android/app/src/debug/java/com/shikuang/app/DiagnosticCapacitorWebView.java').read_text()
        self.assertEqual(view.count('super.onDraw(canvas);'),1)
        self.assertIn('canvas.isHardwareAccelerated()',view)
        self.assertNotIn('setLayerType',view);self.assertNotIn('catch',view)


if __name__=='__main__':unittest.main()

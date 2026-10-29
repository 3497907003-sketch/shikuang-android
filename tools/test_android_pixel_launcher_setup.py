"""UNIT_ONLY fake adb responses; no device/App/photograph/model is accessed."""
import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from android_pixel_launcher_setup import PACKAGE, SERIAL, prepare_pixel_launcher

DEVICE = b'List of devices attached\nemulator-5554\tdevice\n\n'
SYSTEM = ('package:' + PACKAGE + '\n').encode()
APK = b'package:/system_ext/priv-app/NexusLauncherRelease/NexusLauncherRelease.apk\n'
DISABLE = ['shell', 'pm', 'disable-user', '--user', '0', PACKAGE]
STOP = ['shell', 'am', 'force-stop', '--user', '0', PACKAGE]


class PixelLauncherSetupTests(unittest.TestCase):
    def run_setup(self, parent, overrides=None, serial=SERIAL, ci='true'):
        responses = {
            ('devices',): (0, DEVICE, b''),
            ('shell', 'getprop', 'ro.kernel.qemu'): (0, b'1\n', b''),
            ('shell', 'getprop', 'ro.build.version.sdk'): (0, b'35\n', b''),
            ('shell', 'getconf', 'PAGE_SIZE'): (0, b'4096\n', b''),
            ('shell', 'id', '-u'): (0, b'0\n', b''),
            ('emu', 'avd', 'name'): (0, b'shikuang-api35\nOK\n', b''),
            ('shell', 'pm', 'list', 'packages', '-s', PACKAGE): (0, SYSTEM, b''),
            ('shell', 'pm', 'path', PACKAGE): (0, APK, b''),
            tuple(DISABLE): (0, ('Package ' + PACKAGE + ' new state: disabled-user\n').encode(), b''),
            tuple(STOP): (0, b'', b''),
            ('shell', 'pidof', PACKAGE): (1, b'', b'')}
        responses.update(overrides or {})
        self.calls = []
        def fake(argv, **kwargs):
            self.calls.append(argv)
            self.assertEqual(argv[:3], ['adb', '-s', SERIAL])
            self.assertEqual(kwargs, {'capture_output': True, 'timeout': 30})
            args = tuple(argv[3:])
            if args == ('shell', 'pm', 'list', 'packages', '-d', PACKAGE):
                value = responses.get(args, (0, b'' if sum(c == argv for c in self.calls) == 1 else SYSTEM, b''))
            else:
                self.assertIn(args, responses, 'Unexpected UNIT_ONLY command')
                value = responses[args]
            if callable(value): value = value(sum(c == argv for c in self.calls))
            if isinstance(value, Exception): raise value
            return subprocess.CompletedProcess(argv, *value)
        with patch.dict('os.environ', {'GITHUB_ACTIONS': ci}), patch('android_cold_restart.subprocess.run', side_effect=fake):
            return prepare_pixel_launcher(serial, parent / 'setup')

    def no_mutations(self):
        self.assertFalse(any(c[3:] in (DISABLE, STOP) for c in self.calls))

    def test_exact_fresh_4K_CI_AVD_disables_only_the_external_launcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp); report = self.run_setup(parent)
            self.assertTrue(report['passed']); self.assertTrue(report['disabledAfter']); self.assertTrue(report['processAbsentAfter'])
            mutations = [c[3:] for c in self.calls if c[3:] in (DISABLE, STOP)]
            self.assertEqual(mutations, [DISABLE, STOP])
            self.assertFalse(report['appDataTouched']); self.assertFalse(report['globalErrorDialogsChanged'])
            self.assertFalse(report['runtimeAssertionsChanged'])
            receipts = json.loads((parent / 'setup/command-receipts.json').read_text())
            self.assertEqual(len(receipts), len(self.calls)); self.assertEqual(report['commandReceiptCount'], len(self.calls))
            self.assertEqual(len({r['label'] for r in receipts}), len(receipts))
            self.assertTrue(all(not r['timed_out'] for r in receipts))
            self.assertTrue(all((parent / 'setup' / (r['label'] + '.stdout.bin')).exists() for r in receipts))
            self.assertTrue(all((parent / 'setup' / (r['label'] + '.stderr.bin')).exists() for r in receipts))
            self.assertFalse(any('com.shikuang.' in ' '.join(c) or 'settings' in c or 'clear' in c for c in self.calls))

    def test_non_CI_or_physical_serial_is_rejected_before_adb(self):
        for serial, ci in [('R58-REAL-PHONE', 'true'), ('emulator-5556', 'true'), (SERIAL, 'false'), (SERIAL, '')]:
            with self.subTest(serial=serial, ci=ci), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError): self.run_setup(Path(tmp), serial=serial, ci=ci)
                self.assertEqual(self.calls, [])

    def test_multiple_offline_or_wrong_transport_never_mutates(self):
        for raw in [DEVICE + b'R58-phone\tdevice\n', DEVICE + b'emulator-5556\toffline\n',
                    b'List of devices attached\nemulator-5556\tdevice\n', DEVICE + b'emulator-5554\tdevice\n',
                    b'List of devices attached\nemulator-5554\tunauthorized\n']:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError, 'one_exact_emulator_transport'): self.run_setup(Path(tmp), {('devices',): (0, raw, b'')})
                self.no_mutations()

    def test_wrong_qemu_SDK_pages_root_or_AVD_never_mutates(self):
        changes = [(('shell','getprop','ro.kernel.qemu'), b'0\n'),
                   (('shell','getprop','ro.build.version.sdk'), b'30\n'),
                   (('shell','getconf','PAGE_SIZE'), b'16384\n'),
                   (('shell','id','-u'), b'2000\n'),
                   (('emu','avd','name'), b'shikuang-api35-16k\nOK\n'),
                   (('emu','avd','name'), b'user-owned-api35\nOK\n')]
        for args, raw in changes:
            with self.subTest(args=args, raw=raw), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError): self.run_setup(Path(tmp), {args: (0, raw, b'')})
                self.no_mutations()

    def test_non_system_ambiguous_or_data_installed_package_never_mutates(self):
        changes = [(('shell','pm','list','packages','-s',PACKAGE), b''),
                   (('shell','pm','list','packages','-s',PACKAGE), SYSTEM + b'package:com.google.android.apps.nexuslauncher.extra\n'),
                   (('shell','pm','list','packages','-s',PACKAGE), b'package:com.shikuang.app.preview\n'),
                   (('shell','pm','path',PACKAGE), b'package:/data/app/Launcher/base.apk\n'),
                   (('shell','pm','path',PACKAGE), APK + APK),
                   (('shell','pm','path',PACKAGE), b'package:/system_ext/../data/Launcher.apk\n')]
        for args, raw in changes:
            with self.subTest(args=args, raw=raw), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError): self.run_setup(Path(tmp), {args: (0, raw, b'')})
                self.no_mutations()

    def test_unknown_disabled_state_before_never_mutates(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'ambiguous_disabled_package_before'):
                self.run_setup(Path(tmp), {('shell','pm','list','packages','-d',PACKAGE): (0, SYSTEM + b'package:other\n', b'')})
            self.no_mutations()

    def test_disable_failure_or_surviving_PID_is_retained_without_retry(self):
        changes = [(tuple(DISABLE), (1, b'', b'UNIT_ONLY failure')),
                   (tuple(DISABLE), (0, b'Package other new state: disabled-user\n', b'')),
                   (('shell','pidof',PACKAGE), (0, b'1164\n', b''))]
        for args, value in changes:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as tmp:
                parent = Path(tmp)
                with self.assertRaises(ValueError): self.run_setup(parent, {args: value})
                report = json.loads((parent/'setup/setup-report.json').read_text())
                self.assertFalse(report['passed']); self.assertEqual(report['phase'], 'launcher_setup_failed')
                self.assertEqual(sum(c[3:] == list(args) for c in self.calls), 1)
                self.assertTrue((parent/'setup/command-receipts.json').exists())

    def test_disabled_state_must_actually_hold_after_the_mutation(self):
        key = ('shell','pm','list','packages','-d',PACKAGE)
        for after in (b'', SYSTEM + b'package:other\n'):
            with self.subTest(after=after), tempfile.TemporaryDirectory() as tmp:
                parent=Path(tmp)
                with self.assertRaisesRegex(ValueError, 'launcher_disabled_state_not_verified'):
                    self.run_setup(parent, {key: lambda count: (0, b'' if count == 1 else after, b'')})
                self.assertEqual([c[3:] for c in self.calls if c[3:] in (DISABLE,STOP)], [DISABLE,STOP])
                report=json.loads((parent/'setup/setup-report.json').read_text())
                self.assertFalse(report['passed']); self.assertNotIn('processAbsentAfter',report)

    def test_overall_deadline_prevents_a_new_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent=Path(tmp)
            with patch('android_pixel_launcher_setup.time.monotonic',side_effect=[0,151,152]):
                with self.assertRaisesRegex(ValueError, 'launcher_setup_deadline_before_command'):
                    self.run_setup(parent)
            self.assertEqual(self.calls,[])
            self.assertFalse(json.loads((parent/'setup/setup-report.json').read_text())['passed'])

    def test_preflight_timeout_stderr_or_oversized_output_is_retained_without_mutation(self):
        key = ('shell','getprop','ro.kernel.qemu')
        values = [subprocess.TimeoutExpired('UNIT_ONLY adb', 30, output=b'partial', stderr=b''),
                  (0, b'1\n', b'UNIT_ONLY error'), (0, b'1'*65537, b'')]
        for value in values:
            with self.subTest(value=type(value).__name__), tempfile.TemporaryDirectory() as tmp:
                parent=Path(tmp)
                with self.assertRaises(ValueError): self.run_setup(parent, {key:value})
                self.no_mutations(); self.assertFalse(json.loads((parent/'setup/setup-report.json').read_text())['passed'])

    def test_actual_workflow_guard_selects_only_the_ordinary_API35_4K_profile(self):
        workflow=(Path(__file__).resolve().parents[1]/'.github/workflows/android-runtime.yml').read_text()
        command='python3 -B tools/android_pixel_launcher_setup.py --out runtime-artifacts/external-pixel-launcher-setup'
        self.assertEqual(workflow.count(command),1)
        lines=workflow.splitlines(); call=next(i for i,line in enumerate(lines) if command in line)
        start=call
        while not lines[start].lstrip().startswith('if [['): start-=1
        self.assertEqual(lines[call+1].strip(),'fi')
        script=textwrap.dedent('\n'.join(lines[start:call+2])).replace(command,"printf 'UNIT_ONLY launcher setup\\n'")
        cases=[(35,'35','google_apis',4096,'false',True),
               (24,'24','google_apis',4096,'false',False),
               (30,'30','google_apis',4096,'false',False),
               (35,'35-16k','google_apis_ps16k',16384,'false',False),
               (35,'35','google_apis',4096,'true',False),
               (35,'35','google_apis_playstore',4096,'false',False),
               (35,'35-16k','google_apis',4096,'false',False),
               (35,'35','google_apis',16384,'false',False)]
        for api,identity,tag,page,probe,selected in cases:
            values={'matrix.api':api,'matrix.id':identity,'matrix.tag':tag,'matrix.pageSize':page,'inputs.network_probe':probe}
            fixture=script
            for key,value in values.items(): fixture=fixture.replace('${{ '+key+' }}',str(value))
            with self.subTest(values=values):
                result=subprocess.run(['bash','-c',fixture],capture_output=True,timeout=3)
                self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,b'')
                self.assertEqual(result.stdout,b'UNIT_ONLY launcher setup\n' if selected else b'')


if __name__ == '__main__': unittest.main()

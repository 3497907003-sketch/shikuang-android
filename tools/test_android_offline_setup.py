"""UNIT_ONLY route strings/subprocess receipts, no App/device/photo/model reads."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from android_offline_setup import dummy_default_plan, prepare_offline_routes

DUMMY4 = b'default dev dummy0 table dummy0 proto static scope link \n'
DUMMY6 = b'default dev dummy0 table dummy0 proto static metric 1024 pref medium\n'
LOCAL4 = b'local 127.0.0.1 dev lo table local proto kernel scope host src 127.0.0.1\n'
LOCAL6 = b'local ::1 dev lo table local proto kernel metric 0 pref medium\n'


class StrictOfflineSetupTests(unittest.TestCase):
    def test_exact_system_defaults_plan_fixed_commands_only(self):
        self.assertEqual(dummy_default_plan(LOCAL4, LOCAL6), [])
        plan = dummy_default_plan(DUMMY4 + LOCAL4, DUMMY6 + LOCAL6)
        self.assertEqual(plan, [
            ('ipv4', ['shell', 'ip', 'route', 'del', 'default', 'dev', 'dummy0', 'table', 'dummy0']),
            ('ipv6', ['shell', 'ip', '-6', 'route', 'del', 'default', 'dev', 'dummy0', 'table', 'dummy0'])])

    def test_external_unknown_or_duplicate_defaults_are_never_deleted(self):
        for route in (b'default via 10.0.2.2 dev eth0 table eth0\n',
                      b'default dev wlan0 table wlan0 proto static scope link\n',
                      b'default dev tun0 table vpn\n',
                      b'default dev rmnet_data0 table 1001\n',
                      DUMMY4.replace(b'table dummy0', b'table main'),
                      DUMMY4.replace(b'dev dummy0', b'dev dummy1'),
                      DUMMY4 + DUMMY4, DUMMY4 + b'default dev eth1\n'):
            with self.subTest(route=route), self.assertRaisesRegex(ValueError, 'setup_unknown_or_external_default_ipv4'):
                dummy_default_plan(route, LOCAL6)
        with self.assertRaisesRegex(ValueError, 'setup_unknown_or_external_default_ipv6'):
            dummy_default_plan(LOCAL4, DUMMY6.replace(b'metric 1024', b'metric 999'))

    def test_unqualified_api35_listing_may_include_the_same_ipv6_default(self):
        self.assertEqual(dummy_default_plan(DUMMY4 + LOCAL4 + DUMMY6 + LOCAL6, DUMMY6 + LOCAL6),
                         dummy_default_plan(DUMMY4 + LOCAL4, DUMMY6 + LOCAL6))
        with self.assertRaisesRegex(ValueError, 'setup_unknown_or_external_default_ipv4'):
            dummy_default_plan(DUMMY4 + DUMMY6 + DUMMY6, DUMMY6)
        with self.assertRaisesRegex(ValueError, 'setup_route_snapshots_disagree'):
            dummy_default_plan(DUMMY4 + DUMMY6, LOCAL6)
        with self.assertRaisesRegex(ValueError, 'setup_unknown_or_external_default_ipv6'):
            dummy_default_plan(LOCAL4, DUMMY4 + DUMMY6)

    def _run(self, parent, route4=DUMMY4 + LOCAL4, route6=DUMMY6 + LOCAL6, fail_delete=False, revived=False):
        calls = []
        def fake(argv, **kwargs):
            calls.append(argv)
            args = argv[3:]
            if args == ['shell', 'id', '-u']: out = b'0\n'
            elif args == ['shell', 'dumpsys', 'connectivity']: out = b'Active default network: none\n'
            elif 'del' in args:
                if fail_delete: return subprocess.CompletedProcess(argv, 2, b'', b'UNIT_ONLY delete failed')
                out = b''
            elif args == ['shell', 'ip', 'route', 'show', 'table', 'all']:
                out = route4 if sum(c == argv for c in calls) == 1 else (DUMMY4 if revived else LOCAL4)
            elif args == ['shell', 'ip', '-6', 'route', 'show', 'table', 'all']:
                out = route6 if sum(c == argv for c in calls) == 1 else LOCAL6
            else: raise AssertionError('Unexpected UNIT_ONLY command: ' + repr(argv))
            return subprocess.CompletedProcess(argv, 0, out, b'')
        with patch('android_cold_restart.subprocess.run', side_effect=fake):
            report = prepare_offline_routes('emulator-5554', parent / 'setup')
        return report, calls

    def test_setup_wrapper_records_exact_deletions_and_unchanged_final_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp); report, calls = self._run(parent)
            self.assertTrue(report['passed']); self.assertEqual(report['actualDummyDefaultsRemoved'], 2)
            self.assertFalse(report['noDefaultRouteGateRelaxed'])
            self.assertEqual(len([c for c in calls if 'del' in c]), 2)
            receipts = json.loads((parent / 'setup/command-receipts.json').read_text())
            self.assertTrue(all(r['return_code'] == 0 and not r['timed_out'] for r in receipts))
            self.assertEqual((parent / 'setup/before-ipv4.stdout.bin').read_bytes(), DUMMY4 + LOCAL4)
            self.assertEqual((parent / 'setup/after-setup-ipv4.stdout.bin').read_bytes(), LOCAL4)

    def test_sdk_without_dummy_routes_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, calls = self._run(Path(tmp), LOCAL4, LOCAL6)
            self.assertEqual(report['actualDummyDefaultsRemoved'], 0)
            self.assertFalse(any('del' in c for c in calls))

    def test_delete_failure_or_returning_route_fails_and_preserves_receipts(self):
        for mode in ('fail_delete', 'revived'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                parent = Path(tmp)
                with self.assertRaises(ValueError): self._run(parent, **{mode: True})
                report = json.loads((parent / 'setup/offline-route-setup-report.json').read_text())
                self.assertFalse(report['passed'])
                self.assertEqual(report['phase'], 'strict-offline-route-setup-failed')
                self.assertTrue((parent / 'setup/command-receipts.json').is_file())

    def test_unknown_external_default_prevents_every_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'setup_unknown_or_external_default_ipv4'):
                self._run(parent, DUMMY4 + b'default via 10.0.2.2 dev eth0\n')
            receipts = json.loads((parent / 'setup/command-receipts.json').read_text())
            self.assertFalse(any('del' in r['argv'] for r in receipts))


if __name__ == '__main__': unittest.main()

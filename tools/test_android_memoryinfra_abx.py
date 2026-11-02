"""Real local stdin transport, with explicit fake device converter output.

The ABX input is original stock-AVD metadata, not generated XML or an invented
ABX decoder. This suite does not execute Android's actual abx2xml; CI must do so.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import android_memoryinfra_diagnostic as m
import android_pretest_install_diagnostic as p

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT/'tools/fixtures/memoryinfra-packages.actual.abx.gz'
RAW_SHA = 'fedfc4bb317f4059dd231d92704dc98094a1f58d2b7569f6f89520c3f82d1826'
XML = b'<packages><package name="com.vendor.trichromelibrary_42" codePath="/data/app/library"/></packages>'


def actual_abx():
    compressed = FIXTURE.read_bytes()
    assert hashlib.sha256(compressed).hexdigest() == '1c9353ca420d2d1b91f18ae6f96ffe269d226449ba46706cfbb3e2aac1181e45'
    raw = gzip.decompress(compressed)
    assert len(raw) == 364693 and hashlib.sha256(raw).hexdigest() == RAW_SHA
    return raw


class FakeDevice(p.Recorder):
    """Substitute two fixed local subprocesses; never run ADB or decode ABX."""
    def __init__(self, out, raw, *, converter_failure=False):
        super().__init__(out, seconds=8)
        self.raw = raw
        self.requested = []
        self.converter_failure = converter_failure

    def run(self, label, argv, **kwargs):
        self.requested.append((label, argv))
        if label == 'package-manager-original-metadata':
            # Avoid exec argv limits for real 365KB binary metadata.
            source = self.out/'FAKE-source.bin'; source.write_bytes(self.raw)
            producer = "from pathlib import Path;import sys;sys.stdout.buffer.write(Path("+repr(str(source))+").read_bytes())"
            return super().run(label, [sys.executable, '-c', producer], **kwargs)
        assert label == 'package-manager-abx2xml'
        assert argv == ['adb','-s','emulator-5554','shell','-T','-e','none','/system/bin/abx2xml','-','-']
        script = "import hashlib,sys;raw=sys.stdin.buffer.read();assert hashlib.sha256(raw).hexdigest()=="+repr(RAW_SHA)+";"
        if self.converter_failure:
            script += "sys.stderr.write('FAKE converter failure');sys.exit(7)"
        else:
            script += "sys.stdout.buffer.write("+repr(XML)+")"
        return super().run(label, [sys.executable, '-c', script], **kwargs)


class ABXTests(unittest.TestCase):
    def test_actual_ABX_bytes_reach_converter_stdin_exactly(self):
        raw = actual_abx()
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory); host=FakeDevice(out,raw)
            xml,proof=m.package_manager_metadata(host,out)
            self.assertEqual(xml,XML);self.assertEqual(proof['format'],'ABX-v0')
            self.assertEqual(proof['original_sha256'],RAW_SHA)
            self.assertEqual((out/'package-manager-original-metadata.stdout.bin').read_bytes(),raw)
            stdin=host.receipts[-1]['stdin']
            self.assertEqual(stdin['sha256'],RAW_SHA)
            self.assertEqual(stdin['consumed_bytes'],len(raw));self.assertTrue(stdin['verified_after'])
            self.assertEqual(host.receipts[-1]['return_code'],0)

    def test_plain_XML_uses_original_bytes_without_converter(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=FakeDevice(out,XML)
            xml,proof=m.package_manager_metadata(host,out)
            self.assertEqual(xml,XML);self.assertEqual(proof['format'],'XML')
            self.assertIsNone(proof['converter']);self.assertEqual(len(host.requested),1)

    def test_converter_failure_keeps_original_and_cannot_create_success_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=FakeDevice(out,actual_abx(),converter_failure=True)
            with self.assertRaisesRegex(ValueError,'command_failed:package-manager-abx2xml'):
                m.package_manager_metadata(host,out)
            self.assertEqual(host.receipts[-1]['return_code'],7)
            self.assertEqual(hashlib.sha256((out/'package-manager-original-metadata.stdout.bin').read_bytes()).hexdigest(),RAW_SHA)
            self.assertFalse((out/'package-manager-metadata-binding.json').exists())

    def test_unknown_ABX_version_is_not_treated_as_XML(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=FakeDevice(out,b'ABX\x01unsupported')
            with self.assertRaisesRegex(ValueError,'unsupported PackageManager binary XML version'):
                m.package_manager_metadata(host,out)
            self.assertEqual(len(host.requested),1)

    def test_unregistered_stdin_is_rejected_before_child_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=p.Recorder(out,seconds=3);source=out/'foreign.bin';source.write_bytes(b'not registered')
            marker=out/'MUST-NOT-EXIST'
            with self.assertRaisesRegex(ValueError,'registered_successful_output'):
                host.run('denied',[sys.executable,'-c',"from pathlib import Path;Path("+repr(str(marker))+").touch()"],stdin_path=source)
            self.assertFalse(marker.exists());self.assertNotIn('owned_client_PID',host.receipts[-1])

    def test_modified_or_symlinked_registered_output_is_not_read_as_stdin(self):
        for kind in ['modified','symlink']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                out=Path(directory);host=p.Recorder(out,seconds=5)
                host.run('source',[sys.executable,'-c',"print('original')"])
                source=out/'source.stdout.bin'
                if kind=='modified':source.write_bytes(b'changed!\n')
                else:
                    other=out/'other.bin';other.write_bytes(b'original\n');source.unlink();source.symlink_to(other)
                with self.assertRaises((ValueError,OSError)):
                    host.run('denied',[sys.executable,'-c','raise AssertionError()'],stdin_path=source)
                self.assertNotIn('owned_client_PID',host.receipts[-1])

    def test_successful_child_that_ignores_stdin_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=p.Recorder(out,seconds=4)
            host.run('source',[sys.executable,'-c',"print('original')"])
            with self.assertRaisesRegex(ValueError,'stdin_not_fully_consumed'):
                host.run('ignored',[sys.executable,'-c',"print('output')"],stdin_path=out/'source.stdout.bin')
            self.assertEqual(host.receipts[-1]['stdin']['consumed_bytes'],0)

    def test_timeout_retains_partial_transport_and_reaps_owned_child(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=p.Recorder(out,seconds=4)
            host.run('source',[sys.executable,'-c',"print('original')"])
            with self.assertRaisesRegex(ValueError,'command_deadline:stalled'):
                host.run('stalled',[sys.executable,'-c','import time;time.sleep(10)'],seconds=.25,stdin_path=out/'source.stdout.bin')
            row=host.receipts[-1];self.assertTrue(row['timed_out'])
            self.assertIsNotNone(row['owned_client_cleanup']['terminal_return_code'])
            self.assertTrue(row['stdin']['verified_after'])

    def test_oversized_registered_stdin_is_rejected_before_read_or_child(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory);host=p.Recorder(out,seconds=3);source=out/'source.stdout.bin'
            with source.open('wb') as stream:stream.truncate(p.MAX_STDIN+1)
            host.receipts.append({'label':'source','return_code':0,'timed_out':False,'stdout_bytes':p.MAX_STDIN+1,'stdout_sha256':'0'*64})
            with self.assertRaisesRegex(ValueError,'bounded_regular_stdin'):
                host.run('denied',[sys.executable,'-c','raise AssertionError()'],stdin_path=source)
            self.assertNotIn('owned_client_PID',host.receipts[-1])


if __name__=='__main__':unittest.main()

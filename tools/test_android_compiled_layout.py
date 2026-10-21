"""Synthetic compiled-table query counterexamples, no real APK/build/runtime."""
import unittest
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

from android_compiled_layout import inspect, rows, unique_layout


class CompiledLayoutTests(unittest.TestCase):
    def fixture(self, configs=b'default\nv21\n', paths=None):
        self.calls = []
        paths = {'default': 'r/Ab'} if paths is None else paths
        def query(label, argv):
            self.calls.append((label, argv))
            if label == 'packages': return b'com.shikuang.app\n'
            if label == 'layout-configs': return configs
            config = argv[argv.index('--config') + 1]
            if label.endswith('-names'): return b'other_layout\nbridge_layout_main\n' if config in paths else b'other_layout\n'
            return (paths[config] + '\n').encode()
        return query

    def test_optimized_path_comes_only_from_actual_value_not_filename_guess(self):
        selected = unique_layout(self.fixture(), ['resources.arsc', 'r/Ab'], 'release.apk')
        self.assertEqual(selected['path'], 'r/Ab')
        self.assertEqual(len([r for r in self.calls if r[0].endswith('bridge-value')]), 1)

    def test_empty_default_token_is_preserved_without_guessing_default_name(self):
        selected = unique_layout(self.fixture(b'\nv21\n', {'': 'res/x.xml'}), ['res/x.xml'], 'release.apk')
        self.assertEqual(selected['config'], '')
        self.assertTrue(any('--config' in argv and argv[argv.index('--config') + 1] == '' for _, argv in self.calls))

    def test_multiple_configured_definitions_or_missing_definition_fail(self):
        for paths in ({}, {'default': 'r/a', 'v21': 'r/b'}):
            with self.assertRaises(ValueError): unique_layout(self.fixture(paths=paths), ['r/a', 'r/b'], 'release.apk')

    def test_duplicate_ZIP_member_or_missing_exact_table_member_fails(self):
        for entries in (['r/Ab', 'r/Ab'], ['res/layout/bridge_layout_main.xml']):
            with self.assertRaises(ValueError): unique_layout(self.fixture(), entries, 'release.apk')

    def test_unsafe_or_ambiguous_resource_paths_are_not_repaired(self):
        for path in ('/res/a.xml', '../a.xml', 'res/../a.xml', 'res//a.xml', 'res\\a.xml', 'r/a\nr/b'):
            with self.assertRaises(ValueError): unique_layout(self.fixture(paths={'default': path}), [path], 'release.apk')

    def test_duplicate_configuration_or_multiple_packages_fail(self):
        with self.assertRaises(ValueError): unique_layout(self.fixture(b'default\ndefault\n'), ['r/Ab'], 'release.apk')
        query = self.fixture()
        with self.assertRaises(ValueError): unique_layout(lambda label, argv: b'p.one\np.two\n' if label == 'packages' else query(label, argv), ['r/Ab'], 'release.apk')

    def test_blank_configuration_is_not_discarded_or_invented(self):
        self.assertEqual(rows(b'\n', 64, allow_empty=True), [''])
        with self.assertRaises(ValueError): rows(b'', 64, allow_empty=True)

    def test_inspection_saves_real_table_and_uses_only_resolved_xml_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); apk = root / 'synthetic.apk'; out = root / 'proof'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('resources.arsc', b'synthetic-table')
                archive.writestr('r/Ab', b'synthetic-binary-layout')
            calls = []
            outputs = [b'com.shikuang.app\n', b'default\n', b'bridge_layout_main\n', b'r/Ab\n', b'<FrameLayout/>']
            def command(argv, **kwargs):
                calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, outputs[len(calls) - 1], b'')
            with patch('android_compiled_layout.subprocess.run', side_effect=command):
                inspect(Path('/observed/apkanalyzer'), apk, out, root / 'layout.xml')
            self.assertEqual(calls[-1][1:], ['resources', 'xml', '--file', '/r/Ab', str(apk)])
            self.assertEqual((out / 'resources.arsc').read_bytes(), b'synthetic-table')
            self.assertEqual((root / 'layout.xml').read_bytes(), b'<FrameLayout/>')
            self.assertTrue(json.loads((out / 'resolution.json').read_text())['passed'])
            self.assertEqual(len(json.loads((out / 'command-receipts.json').read_text())), 5)

    def test_failed_query_is_saved_authoritative_and_does_not_try_guessed_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); apk = root / 'synthetic.apk'; out = root / 'proof'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('resources.arsc', b'synthetic-table')
                archive.writestr('res/layout/bridge_layout_main.xml', b'not-a-fallback')
            with patch('android_compiled_layout.subprocess.run', return_value=subprocess.CompletedProcess([], 1, b'', b'query failed')) as command:
                with self.assertRaises(ValueError):
                    inspect(Path('/observed/apkanalyzer'), apk, out, root / 'layout.xml')
            self.assertEqual(command.call_count, 1)
            self.assertFalse((root / 'layout.xml').exists())
            self.assertFalse(json.loads((out / 'resolution.json').read_text())['passed'])
            self.assertEqual((out / 'packages.stderr.bin').read_bytes(), b'query failed')
            self.assertEqual(json.loads((out / 'command-receipts.json').read_text())[0]['return_code'], 1)


if __name__ == '__main__': unittest.main()

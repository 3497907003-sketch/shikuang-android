#!/usr/bin/env python3
"""Resolve one compiled layout through its actual table, without path guesses."""
import argparse
import hashlib
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath

from android_cold_restart import need


def rows(raw, maximum, allow_empty=False):
    need(0 < len(raw) <= 2 * 1024 * 1024, 'bounded_actual_resource_query')
    result = raw.decode('utf-8', errors='strict').splitlines()
    need(0 < len(result) <= maximum and len(set(result)) == len(result), 'unique_bounded_resource_rows')
    need(all('\x00' not in row and (allow_empty or row != '') for row in result), 'valid_resource_rows')
    return result


def unique_layout(query, archive_names, apk):
    """Query every observed configuration; exactly one definition must exist."""
    packages = rows(query('packages', ['resources', 'packages', apk]), 8)
    need(len(packages) == 1 and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', packages[0]),
         'one_actual_resource_table_package')
    package = packages[0]
    configs = rows(query('layout-configs', ['resources', 'configs', '--type', 'layout', '--package', package, apk]),
                   64, allow_empty=True)
    need(all(re.fullmatch(r'(?:[A-Za-z0-9][A-Za-z0-9_+.\-]*)?', c) for c in configs), 'actual_configuration_tokens')
    candidates = []
    for index, config in enumerate(configs):
        selection = ['--config', config, '--type', 'layout', '--package', package]
        names = rows(query(f'config-{index:02d}-names', ['resources', 'names', *selection, apk]), 32768)
        need(all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', n) for n in names), 'actual_layout_key_names')
        if 'bridge_layout_main' not in names:
            continue
        values = rows(query(f'config-{index:02d}-bridge-value',
            ['resources', 'value', *selection, '--name', 'bridge_layout_main', apk]), 1)
        path = values[0]; posix = PurePosixPath(path)
        need(path and '\\' not in path and not posix.is_absolute()
             and not any(p in ('', '.', '..') for p in path.split('/'))
             and all(ord(c) >= 32 for c in path), 'literal_relative_table_file_path')
        need(archive_names.count(path) == 1, 'unique_exact_table_file_in_APK')
        candidates.append({'package': package, 'config': config, 'name': 'bridge_layout_main', 'path': path})
    need(len(candidates) == 1, 'one_compiled_bridge_layout_definition_no_fallback')
    return candidates[0]


def inspect(apkanalyzer, apk, out, xml_out):
    out.mkdir(parents=True, exist_ok=False)
    receipts = []
    started = time.monotonic()
    result = {'schema': 'android-actual-compiled-layout-v1', 'passed': False,
              'apk': str(apk), 'fallbackGuesses': 0, 'maximumSeconds': 180}
    def query(label, arguments):
        remaining = 180 - (time.monotonic() - started)
        need(remaining > 0, 'compiled_layout_inspection_deadline')
        argv = [str(apkanalyzer), *arguments]
        tick = time.monotonic()
        code, stdout, stderr, timed_out = None, b'', b'', False
        try:
            p = subprocess.run(argv, capture_output=True, timeout=min(30, remaining))
            code, stdout, stderr = p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as error:
            stdout, stderr, timed_out = error.stdout or b'', error.stderr or b'', True
        (out / (label + '.stdout.bin')).write_bytes(stdout)
        (out / (label + '.stderr.bin')).write_bytes(stderr)
        receipts.append({'label': label, 'argv': argv, 'return_code': code, 'timed_out': timed_out,
            'started_monotonic': tick, 'ended_monotonic': time.monotonic(),
            'stdout_bytes': len(stdout), 'stdout_sha256': hashlib.sha256(stdout).hexdigest(),
            'stderr_bytes': len(stderr), 'stderr_sha256': hashlib.sha256(stderr).hexdigest()})
        (out / 'command-receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
        need(not timed_out and code == 0 and stderr == b'' and 0 < len(stdout) <= 2 * 1024 * 1024,
             'actual_compiled_resource_command_failed:' + label)
        return stdout
    try:
        need(apk.is_file() and not apk.is_symlink(), 'actual_APK_file_required')
        with zipfile.ZipFile(apk) as z:
            names = z.namelist()
            need(names.count('resources.arsc') == 1, 'one_actual_compiled_resource_table')
            table_info = z.getinfo('resources.arsc')
            need(0 < table_info.file_size <= 32 * 1024 * 1024, 'compiled_resource_table_bound')
            table = z.read(table_info)
            (out / 'resources.arsc').write_bytes(table)
            (out / 'archive-entry-names.json').write_text(json.dumps(names, indent=2) + '\n')
            result['resourceTable'] = {'bytes': len(table), 'sha256': hashlib.sha256(table).hexdigest()}
            selected = unique_layout(query, names, str(apk))
            info = z.getinfo(selected['path'])
            need(0 < info.file_size <= 2 * 1024 * 1024 and not info.is_dir(), 'actual_compiled_layout_bound')
            binary = z.read(info)
            (out / 'selected-layout.binary').write_bytes(binary)
            result['selection'] = selected
            result['binaryLayout'] = {'bytes': len(binary), 'sha256': hashlib.sha256(binary).hexdigest()}
        # Prefix only the exact relative table value for the tool's APK root;
        # this is one lookup, never a retry or an alternate filename candidate.
        xml = query('selected-layout-xml', ['resources', 'xml', '--file', '/' + selected['path'], str(apk)])
        ET.fromstring(xml)
        xml_out.parent.mkdir(parents=True, exist_ok=True)
        with xml_out.open('xb') as output: output.write(xml)
        result.update(passed=True, decodedXmlBytes=len(xml), decodedXmlSha256=hashlib.sha256(xml).hexdigest())
    except Exception as error:
        result['failure'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        result['elapsedSeconds'] = time.monotonic() - started
        (out / 'resolution.json').write_text(json.dumps(result, indent=2) + '\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apkanalyzer', type=Path, required=True)
    p.add_argument('--apk', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--xml-out', type=Path, required=True)
    a = p.parse_args()
    inspect(a.apkanalyzer, a.apk, a.out, a.xml_out)


if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Prepare one fresh CI API35/4K AVD by stopping its external Pixel Launcher.

Never suppress error dialogs, operate on the App, or change runtime assertions.
The original Launcher ANR/failure evidence remains a failure of the prior run.
"""
import argparse
import json
import os
import re
import time
from pathlib import Path

from android_cold_restart import Host, need

SERIAL = 'emulator-5554'
PACKAGE = 'com.google.android.apps.nexuslauncher'
AVD = 'shikuang-api35'
MAX_COMMAND_BYTES = 65536
SETUP_DEADLINE_SECONDS = 180
# Host.command has a fixed 30-second subprocess timeout. Reserve its full
# interval before each command rather than starting an unbounded last attempt.
HOST_COMMAND_TIMEOUT_SECONDS = 30


def preinstalled_paths(raw):
    paths = raw.splitlines()
    need(1 <= len(paths) <= 8, 'exact_preinstalled_launcher_APK_paths_required')
    pattern = rb'package:/(?:system|system_ext|product|vendor|odm)/(?:[A-Za-z0-9_.@+-]+/)*[A-Za-z0-9_.@+-]+\.apk'
    need(all(re.fullmatch(pattern, p) and not any(part in (b'.', b'..') for part in p.split(b'/')) for p in paths)
         and len(set(paths)) == len(paths), 'launcher_must_be_on_a_system_image_partition')
    return [p.decode('ascii') for p in paths]


def prepare_pixel_launcher(serial, out):
    out = Path(out); out.mkdir(parents=True, exist_ok=False)
    host, started = Host(serial, out), time.monotonic()
    report = {'schema': 'android-CI-external-pixel-launcher-setup-v1', 'passed': False,
              'phase': 'started', 'serial': serial, 'package': PACKAGE, 'avd': AVD,
              'requiredSDK': 35, 'requiredPageSize': 4096, 'CIOnly': True,
              'appDataTouched': False, 'globalErrorDialogsChanged': False,
              'runtimeAssertionsChanged': False, 'setupDeadlineSeconds': SETUP_DEADLINE_SECONDS,
              'hostCommandTimeoutSeconds': HOST_COMMAND_TIMEOUT_SECONDS, 'commandsAttempted': []}

    def command(label, args, allow_absent=False):
        need(time.monotonic() - started <= SETUP_DEADLINE_SECONDS - HOST_COMMAND_TIMEOUT_SECONDS,
             'launcher_setup_deadline_before_command')
        report['commandsAttempted'].append({'label': label, 'argv': ['adb', '-s', serial, *args]})
        raw = host.command(label, args, allow_absent=allow_absent)
        need(len(raw) <= MAX_COMMAND_BYTES, label + '_output_bound')
        need(time.monotonic() - started <= SETUP_DEADLINE_SECONDS, 'launcher_setup_deadline')
        return raw

    try:
        need(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_only_launcher_setup')
        need(serial == SERIAL, 'exact_fresh_workflow_emulator_required')
        devices = command('devices', ['devices']).splitlines()
        need(devices and devices[0] == b'List of devices attached'
             and [r.split() for r in devices[1:] if r.strip()] == [[SERIAL.encode(), b'device']],
             'one_exact_emulator_transport_required')
        need(command('qemu', ['shell', 'getprop', 'ro.kernel.qemu']).strip() == b'1', 'actual_emulator_required')
        need(command('sdk', ['shell', 'getprop', 'ro.build.version.sdk']).strip() == b'35', 'actual_SDK35_required')
        need(command('page-size', ['shell', 'getconf', 'PAGE_SIZE']).strip() == b'4096', 'actual_4K_pages_required')
        need(command('root-uid', ['shell', 'id', '-u']).strip() == b'0', 'actual_root_required')
        need(command('avd-name', ['emu', 'avd', 'name']).splitlines() == [AVD.encode(), b'OK'],
             'exact_workflow_AVD_required')
        system = command('system-package', ['shell', 'pm', 'list', 'packages', '-s', PACKAGE])
        need(system.splitlines() == [('package:' + PACKAGE).encode()], 'exact_system_launcher_package_required')
        report['preinstalledAPKPaths'] = preinstalled_paths(command('package-paths', ['shell', 'pm', 'path', PACKAGE]))
        disabled_before = command('disabled-before', ['shell', 'pm', 'list', 'packages', '-d', PACKAGE])
        need(disabled_before.splitlines() in ([], [('package:' + PACKAGE).encode()]), 'ambiguous_disabled_package_before')
        report['disabledBefore'] = bool(disabled_before.strip())
        disabled = command('disable-exact-external-package', ['shell', 'pm', 'disable-user', '--user', '0', PACKAGE])
        need(disabled.strip() == ('Package ' + PACKAGE + ' new state: disabled-user').encode(),
             'exact_launcher_disable_confirmation_required')
        need(command('stop-exact-external-package', ['shell', 'am', 'force-stop', '--user', '0', PACKAGE]).strip() == b'',
             'launcher_force_stop_output')
        after = command('disabled-after', ['shell', 'pm', 'list', 'packages', '-d', PACKAGE])
        need(after.splitlines() == [('package:' + PACKAGE).encode()], 'launcher_disabled_state_not_verified')
        report['disabledAfter'] = True
        need(command('external-pid-after', ['shell', 'pidof', PACKAGE], allow_absent=True).strip() == b'',
             'launcher_process_still_present')
        report.update(passed=True, phase='exact_external_pixel_launcher_disabled', processAbsentAfter=True)
    except Exception as error:
        report.update(phase='launcher_setup_failed', failure=type(error).__name__ + ': ' + str(error))
        raise
    finally:
        report['elapsedSeconds'] = time.monotonic() - started
        report['commandReceiptCount'] = len(host.receipts)
        (out / 'setup-report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default=SERIAL)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    prepare_pixel_launcher(args.serial, args.out)


if __name__ == '__main__':
    main()

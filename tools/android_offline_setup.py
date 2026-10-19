#!/usr/bin/env python3
"""Prepare the emulator's strict route-free test environment; never touch App data.

AOSP DummyNetwork installs drop-only defaults in its dedicated dummy0 table.
Remove only the two exact observed system forms during setup, retaining the
cold-process verifier's unchanged requirement that no default route exists.
"""
import argparse
import json
import re
from pathlib import Path

from android_cold_restart import Host, need

AOSP_DUMMY_NETWORK_SOURCE = (
    'https://android.googlesource.com/platform/system/netd/+'
    '/refs/heads/android14-mainline-healthfitness-release/server/DummyNetwork.cpp')


def dummy_default_plan(ipv4, ipv6):
    """Fixed commands only; unknown, external or duplicate defaults fail closed."""
    expected = {
        'ipv4': b'default dev dummy0 table dummy0 proto static scope link'.split(),
        'ipv6': b'default dev dummy0 table dummy0 proto static metric 1024 pref medium'.split(),
    }
    observed = {}
    for family, raw in (('ipv4', ipv4), ('ipv6', ipv6)):
        need(len(raw) <= 1024 * 1024, 'setup_route_snapshot_bound')
        defaults = [line.split() for line in raw.splitlines()
                    if re.match(rb'^\s*default\s', line)]
        seen = set()
        for row in defaults:
            matches = [kind for kind, tokens in expected.items() if row == tokens]
            need(len(matches) == 1 and matches[0] not in seen
                 and (family != 'ipv6' or matches[0] == 'ipv6'),
                 'setup_unknown_or_external_default_' + family)
            seen.add(matches[0])
        observed[family] = seen
    # API35's unqualified all-table listing includes IPv6 too. That same
    # physical default appears in the explicit -6 snapshot; remove it once.
    need('ipv6' not in observed['ipv4'] or 'ipv6' in observed['ipv6'],
         'setup_route_snapshots_disagree')
    plan = []
    for family in ('ipv4', 'ipv6'):
        if family in observed['ipv4'] | observed['ipv6']:
            ip = ['shell', 'ip'] + (['-6'] if family == 'ipv6' else [])
            plan.append((family, ip + ['route', 'del', 'default', 'dev', 'dummy0', 'table', 'dummy0']))
    return plan


def prepare_offline_routes(serial, out):
    need(re.fullmatch(r'emulator-[0-9]+', serial) is not None, 'explicit_test_emulator_required')
    out = Path(out); out.mkdir(parents=True, exist_ok=False)
    host = Host(serial, out)
    report = {'schema': 'android-strict-offline-route-setup-v1', 'phase': 'started', 'passed': False,
              'aospSource': AOSP_DUMMY_NETWORK_SOURCE, 'appDataTouched': False,
              'noDefaultRouteGateRelaxed': False}
    try:
        need(host.command('root-uid', ['shell', 'id', '-u']).strip() == b'0', 'setup_actual_root_required')
        connectivity = host.command('before-connectivity', ['shell', 'dumpsys', 'connectivity'])
        need(b'Active default network: none' in connectivity, 'setup_active_network')
        ipv4 = host.command('before-ipv4', ['shell', 'ip', 'route', 'show', 'table', 'all'])
        ipv6 = host.command('before-ipv6', ['shell', 'ip', '-6', 'route', 'show', 'table', 'all'])
        plan = dummy_default_plan(ipv4, ipv6)
        report['plannedDummyDefaultRemovals'] = [family for family, _ in plan]
        for family, argv in plan:
            host.command('remove-exact-dummy-default-' + family, argv)
        # No filtering, retry, broad flush or route repair is used here.
        # A revived route or failed deletion still fails the original gate.
        host.network('after-setup')
        report.update(phase='strict-offline-routes-prepared', passed=True,
                      actualDummyDefaultsRemoved=len(plan), allTablesDefaultFreeVerified=True)
    except Exception as error:
        report.update(phase='strict-offline-route-setup-failed', failure=type(error).__name__ + ': ' + str(error))
        raise
    finally:
        (out / 'offline-route-setup-report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    prepare_offline_routes(args.serial, args.out)


if __name__ == '__main__':
    main()

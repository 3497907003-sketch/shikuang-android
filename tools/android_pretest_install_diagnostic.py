"""One source-bound, fresh-emulator three-APK installation observation, never acceptance."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

from android_cold_restart import Host, need
from android_webview_render_diagnostic import snapshot_logs

HELPER_SHA = 'c6bc74268b29bdabad8da962e00e2f6fd613c24b42c69e81b258397b4819f156'
VERSION_DEFAULT_SOURCE = ('https://android.googlesource.com/platform/frameworks/base/+/'
    '4e43ad12e1b211f15152e9c5b16b0fe88e6b93f3/core/java/com/android/internal/pm/parsing/pkg/PackageImpl.java#2721')
ROLES = [('app', '01-app.apk', 'com.shikuang.app.preview'),
         ('services', '02-test-services.apk', 'androidx.test.services'),
         ('test', '03-app-test.apk', 'com.shikuang.app.preview.test')]
INSTALL_SECONDS, PHASE_SECONDS = 90, 360
MAX_STDOUT, MAX_LOG, MAX_APK = 2 * 1024**2, 32 * 1024**2, 256 * 1024**2
FATAL = re.compile(rb'Fatal signal [0-9]+|FATAL EXCEPTION:|Kernel panic|WATCHDOG KILLING SYSTEM PROCESS', re.I)
sha = lambda raw: hashlib.sha256(raw).hexdigest()
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(path, value):
    """Checkpoint only inside this invocation's exclusively created directory."""
    temp = path.with_suffix(path.suffix + '.pending')
    with temp.open('x') as out:
        json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False); out.write('\n')
    os.replace(temp, path)


def bounded(path, cap):
    need(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= cap,
         'bounded_regular_file:' + str(path))
    with path.open('rb') as stream:
        raw = stream.read(cap + 1)
    need(0 < len(raw) <= cap, 'file_grew_past_bound')
    return raw


def identity(expected, nonce, repo):
    e = os.environ
    need(re.fullmatch('[a-f0-9]{40}', expected or '') and re.fullmatch('[a-f0-9]{32}', nonce or ''), 'source_nonce')
    need(e.get('GITHUB_ACTIONS') == 'true' and e.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
         and e.get('GITHUB_RUN_ATTEMPT') == '1' and e.get('SHIKUANG_PRETEST_INSTALL') == 'true'
         and e.get('GITHUB_SHA') == expected and re.fullmatch('[1-9][0-9]*', e.get('GITHUB_RUN_ID', '')),
         'one_explicit_CI_dispatch')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, timeout=5).decode().strip()
    need(head == expected, 'checkout_source_mismatch')
    need(subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=repo, timeout=5).returncode == 0,
         'tracked_source_drift')
    return {'source_sha': expected, 'unit_nonce': nonce, 'run_id': e.get('GITHUB_RUN_ID'), 'run_attempt': 1}


def built_apk(metadata, *, apk_folder=None):
    rows = json.loads(bounded(metadata, 65536)).get('elements')
    need(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), 'one_actual_APK')
    row = rows[0]; name = row.get('outputFile')
    need(not row.get('filters') and isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+\.apk', name),
         'single_unsplit_relative_APK')
    return (apk_folder or metadata.parent) / name


def version_fields(raw, declared, major, role):
    """Badging's empty field alone never proves a missing manifest attribute."""
    def integer(value, label):
        need(isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]*', value)
             and int(value) <= 0x7fffffff, label)
        return int(value)
    if raw == '':
        need(role == 'test' and declared is None and major is None,
             'empty_versionCode_requires_undeclared_test_manifest')
        minor, high, basis = 0, 0, VERSION_DEFAULT_SOURCE
    else:
        minor = integer(raw, 'actual_APK_versionCode_badging')
        need(declared is not None and integer(declared, 'actual_APK_versionCode_manifest') == minor,
             'actual_APK_versionCode_mismatch')
        high = 0 if major is None else integer(major, 'actual_APK_versionCodeMajor_manifest')
        basis = 'declared_manifest_integer'
    # Android15 PackageInfo.composeLongVersionCode: major << 32 | minor & 0xffffffffL.
    return {'version_code_raw': raw, 'version_code_declared': declared,
            'version_code_major_declared': major, 'version_code': str((high << 32) | minor),
            'version_code_basis': basis}


def badging_fields(raw, role, package):
    lines = re.findall(rb'^package: (.*)$', raw, re.M)
    need(len(lines) == 1, 'actual_APK_package_line:' + role)
    def field(name):
        values = re.findall(rb'(?:^| )' + name.encode() + rb"='([^'\r\n]*)'(?= |$)", lines[0])
        need(len(values) == 1, 'actual_APK_' + name + '_field:' + role)
        return values[0].decode('utf-8')
    need(field('name') == package, 'actual_APK_package:' + role)
    return field('versionCode'), field('versionName')


def snapshot_metadata(paths, folder):
    folder.mkdir(exist_ok=False); records = []
    for name, source in paths:
        raw = bounded(source, 65536); target = folder/name
        with target.open('xb') as stream: stream.write(raw)
        target.chmod(0o444)
        records.append({'source_path': str(source), 'snapshot_path': str(target),
                        'bytes': len(raw), 'sha256': sha(raw)})
        save(folder/'inputs.json', records)
    return records


def installed_base_path(raw):
    match = re.fullmatch(rb'package:(/data/app/(?:[A-Za-z0-9_+=~.-]+/){1,3}base\.apk)', raw)
    need(match is not None, 'installed_single_legal_data_app_base_path')
    path = match[1].decode('ascii')
    need(all(part not in ('.', '..') for part in path.split('/')), 'installed_path_traversal')
    return path


def installed_version(raw, expected):
    need(isinstance(expected, str) and re.fullmatch(r'0|[1-9][0-9]*', expected)
         and int(expected) <= 0x7fffffffffffffff, 'nonempty_effective_version_required')
    values = re.findall(rb'^\s*versionCode=(0|[1-9][0-9]*)(?=\s|$)', raw, re.M)
    need(len(values) == 1 and values[0].decode() == expected, 'installed_version_mismatch')
    return values[0].decode()


def tool(argv, out, label):
    code, stdout, stderr, timed_out = None, b'', b'', False
    started = time.monotonic()
    try:
        p = subprocess.run(argv, capture_output=True, timeout=90)
        code, stdout, stderr = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as error:
        stdout, stderr, timed_out = error.stdout or b'', error.stderr or b'', True
    bounded_output = len(stdout) <= MAX_STDOUT and len(stderr) <= MAX_STDOUT
    (out / (label + '.stdout.bin')).write_bytes(stdout[:MAX_STDOUT])
    (out / (label + '.stderr.bin')).write_bytes(stderr[:MAX_STDOUT])
    save(out / (label + '.receipt.json'), {'argv': argv, 'return_code': code, 'timed_out': timed_out,
         'started_monotonic': started, 'finished_monotonic': time.monotonic(),
         'stored_stdout_sha256': sha(stdout[:MAX_STDOUT]), 'stored_stderr_sha256': sha(stderr[:MAX_STDOUT]),
         'output_truncated': not bounded_output})
    need(not timed_out and code == 0 and bounded_output, 'build_tool_failed:' + label)
    return stdout


def freeze(args):
    repo = Path.cwd(); auth = identity(args.source, args.nonce, repo)
    app_meta = repo / 'android/app/build/outputs/apk/debug/output-metadata.json'
    test_meta = repo / 'android/app/build/outputs/apk/androidTest/debug/output-metadata.json'
    args.out.mkdir(parents=True, exist_ok=False); (args.out / 'apks').mkdir()
    evidence = args.out / 'build-evidence'; evidence.mkdir()
    metadata_folder = args.out/'metadata'
    metadata = snapshot_metadata([('app-output-metadata.json', app_meta),
        ('test-output-metadata.json', test_meta), ('resolved-build-inputs.json', args.resolved)], metadata_folder)
    resolved = json.loads(bounded(metadata_folder/'resolved-build-inputs.json', 65536))
    need(resolved.get('schema') == 'pretest-resolved-build-inputs-v1'
         and resolved.get('utility_coordinate') == 'androidx.test.services:test-services:1.4.2@apk'
         and resolved.get('instrumentation_started') is False, 'exact_resolved_utility')
    need(Path(resolved['app_metadata']) == app_meta and Path(resolved['test_metadata']) == test_meta, 'actual_metadata_locations')
    utility = Path(resolved['utility_path'])
    need(re.search(r'/androidx\.test\.services/test-services/1\.4\.2/[a-f0-9]{40}/test-services-1\.4\.2\.apk$', str(utility)),
         'exact_Gradle_resolved_utility_path')
    tools = args.sdk / 'build-tools/35.0.0'; analyzer = args.sdk / 'cmdline-tools/latest/bin/apkanalyzer'
    sources = {'app': built_apk(metadata_folder/'app-output-metadata.json', apk_folder=app_meta.parent),
               'test': built_apk(metadata_folder/'test-output-metadata.json', apk_folder=test_meta.parent),
               'services': utility}; rows = []
    for role, name, package in ROLES:
        original = sources[role]; raw = bounded(original, MAX_APK); destination = args.out / 'apks' / name
        with destination.open('xb') as out: out.write(raw)
        need(bounded(destination, MAX_APK) == raw, 'frozen_APK_copy')
        if role == 'services': need(sha(raw) == HELPER_SHA, 'vendor_helper_SHA')
        badging = tool([str(tools/'aapt'), 'dump', 'badging', str(destination)], evidence, role+'-package')
        version_raw, version_name = badging_fields(badging, role, package)
        sign = tool([str(tools/'apksigner'), 'verify', '--verbose', '--print-certs', str(destination)], evidence, role+'-signature')
        certs = re.findall(rb'^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$', sign, re.M)
        need(len(certs) == 1 and not re.search(rb'^Signer #[2-9]', sign, re.M), 'single_APK_signer')
        xml = ET.fromstring(tool([str(analyzer), 'manifest', 'print', str(destination)], evidence, role+'-manifest'))
        ns = '{http://schemas.android.com/apk/res/android}'
        need(xml.tag == 'manifest' and xml.get('package') == package, 'actual_APK_manifest_package:' + role)
        versions = version_fields(version_raw, xml.get(ns+'versionCode'), xml.get(ns+'versionCodeMajor'), role)
        if role == 'test':
            instruments = xml.findall('instrumentation')
            need(len(instruments) == 1 and instruments[0].get(ns+'name') == 'androidx.test.runner.AndroidJUnitRunner'
                 and instruments[0].get(ns+'targetPackage') == ROLES[0][2], 'actual_instrumentation_target')
        if role == 'app':
            activities = [a for a in xml.findall('./application/activity') if a.get(ns+'name') == 'com.shikuang.app.MainActivity']
            need(len(activities) == 1 and activities[0].get(ns+'hardwareAccelerated') == 'true', 'unchanged_accelerated_App')
        destination.chmod(0o444)
        rows.append({'role': role, 'path': 'apks/'+name, 'source_path': str(original), 'package': package,
                     **versions, 'version_name': version_name,
                     'bytes': len(raw), 'sha256': sha(raw), 'certificate_sha256': certs[0].decode().lower()})
    need(rows[0]['certificate_sha256'] == rows[2]['certificate_sha256'], 'App_and_test_same_signer')
    plan = {**auth, 'schema': 'pretest-three-APKs-v1', 'apks': rows,
            'metadata': metadata,
            'distributableRelease': False, 'instrumentation_started': False, 'fullRuntimeVerified': False}
    save(args.out/'apk-plan.json', plan)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output: output.write('plan_sha='+sha((args.out/'apk-plan.json').read_bytes())+'\n')
    print(json.dumps({'plan_sha': sha((args.out/'apk-plan.json').read_bytes()), 'APKs': 3, 'product_acceptance': False}))


def stop_owned(process):
    receipt = {'PID': process.pid, 'terminate_sent': False, 'kill_sent': False}
    if process.poll() is None:
        process.terminate(); receipt['terminate_sent'] = True
        try: process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            process.kill(); receipt['kill_sent'] = True
            try: process.wait(timeout=0.1)
            except subprocess.TimeoutExpired: pass  # SIGKILL sent only to this owned client.
    receipt['terminal_return_code'] = process.poll()
    return receipt


class Recorder(Host):
    def __init__(self, out, *, adb='adb', seconds=PHASE_SECONDS):
        super().__init__('emulator-5554', out)
        self.adb = adb; self.deadline = time.monotonic() + seconds

    def run(self, label, argv, *, seconds=3, deadline=None, monitor=None, allowed=(0,)):
        start = time.monotonic(); end = min(self.deadline, deadline or self.deadline, start+seconds)
        reserve = min(0.25, max(0, end-start)/10); action_end = end-reserve
        need(start < action_end, 'phase_deadline_before_command:' + label)
        row = {'label': label, 'argv': argv, 'started_UTC': utc(), 'started_monotonic': start,
               'deadline_monotonic': end, 'return_code': None, 'timed_out': False, 'stopped_on_health': False}
        self.receipts.append(row); save(self.out/'command-receipts.json', self.receipts)
        process = None; failure = None
        stdout_path = self.out/(label+'.stdout.bin'); stderr_path = self.out/(label+'.stderr.bin')
        try:
            with stdout_path.open('xb') as stdout, stderr_path.open('xb') as stderr:
                process = subprocess.Popen(argv, stdout=stdout, stderr=stderr)
                row['owned_client_PID'] = process.pid; next_sample = start
                while process.poll() is None:
                    need(stdout_path.stat().st_size <= MAX_STDOUT and stderr_path.stat().st_size <= MAX_STDOUT, 'command_output_bound')
                    if time.monotonic() >= action_end:
                        row['timed_out'] = True; raise ValueError('command_deadline:' + label)
                    if monitor and time.monotonic() >= next_sample:
                        try: monitor(action_end)
                        except Exception:
                            row['stopped_on_health'] = True; raise
                        next_sample = time.monotonic()+1
                    time.sleep(min(0.05, max(0, action_end-time.monotonic())))
                row['return_code'] = process.returncode
        except Exception as error:
            failure = error
        finally:
            if process: row['owned_client_cleanup'] = stop_owned(process)
            row.update(finished_UTC=utc(), finished_monotonic=time.monotonic())
            for stream, path in [('stdout', stdout_path), ('stderr', stderr_path)]:
                size = path.stat().st_size if path.exists() else 0
                row[stream+'_bytes'] = size
                row[stream+'_sha256'] = sha(path.read_bytes() if path.exists() else b'') if size <= MAX_STDOUT else None
            if failure: row['failure'] = type(failure).__name__+': '+str(failure)
            save(self.out/'command-receipts.json', self.receipts)
        if failure: raise failure
        need(row['return_code'] in allowed and not row['timed_out'], 'command_failed:' + label)
        need(row['stdout_bytes'] <= MAX_STDOUT and row['stderr_bytes'] <= MAX_STDOUT, 'command_output_bound')
        return stdout_path.read_bytes()

    def command(self, label, args, allow_absent=False, *, deadline=None):
        raw = self.run(label, [self.adb, '-s', self.serial, *args], deadline=deadline,
                       allowed=(0, 1) if allow_absent else (0,))
        need(self.receipts[-1]['stderr_bytes'] == 0, 'ADB_stderr:' + label)
        return raw


def check_plan(raw, expected_sha, source, nonce, folder, *, run_id=None):
    need(re.fullmatch('[a-f0-9]{64}', expected_sha or '') and sha(raw) == expected_sha, 'frozen_plan_SHA')
    plan = json.loads(raw)
    need(plan.get('schema') == 'pretest-three-APKs-v1' and plan.get('source_sha') == source
         and plan.get('unit_nonce') == nonce and plan.get('run_attempt') == 1
         and plan.get('distributableRelease') is False and plan.get('instrumentation_started') is False
         and plan.get('fullRuntimeVerified') is False, 'frozen_plan_identity')
    if run_id is not None: need(plan.get('run_id') == run_id, 'same_run_build_required')
    rows = plan.get('apks'); need(isinstance(rows, list) and len(rows) == 3, 'exact_three_APKs')
    for row, (role, name, package) in zip(rows, ROLES):
        need(row.get('role') == role and row.get('path') == 'apks/'+name and row.get('package') == package,
             'fixed_APK_order_identity')
        body = bounded(folder/row['path'], MAX_APK)
        need(len(body) == row.get('bytes') and sha(body) == row.get('sha256'), 'frozen_APK_bytes')
        versions = version_fields(row.get('version_code_raw'), row.get('version_code_declared'),
                                  row.get('version_code_major_declared'), role)
        need(all(row.get(key) == value for key, value in versions.items()), 'frozen_effective_version_identity')
        if role == 'services': need(row['sha256'] == HELPER_SHA, 'vendor_helper_SHA')
    metadata = plan.get('metadata')
    need(isinstance(metadata, list) and len(metadata) == 3, 'three_metadata_snapshots')
    for record, name in zip(metadata, ['app-output-metadata.json', 'test-output-metadata.json', 'resolved-build-inputs.json']):
        snapshot = folder/'metadata'/name
        need(record.get('snapshot_path') == str(snapshot), 'fixed_metadata_snapshot_path')
        body = bounded(snapshot, 65536)
        need(len(body) == record.get('bytes') and sha(body) == record.get('sha256'), 'frozen_metadata_bytes')
    return plan


def observe_install(plan, folder, out, *, adb='adb', seconds=PHASE_SECONDS, emulator_owner=None):
    """No Activity/instrumentation commands; stop later packages on any health fault."""
    out.mkdir(parents=True, exist_ok=False); host = Recorder(out, adb=adb, seconds=seconds)
    result = {'schema': 'pretest-install-observation-v1', 'state': 'pretest_install_failed',
              'source_sha': plan['source_sha'], 'unit_nonce': plan['unit_nonce'], 'installed': [], 'package_stages': [],
              'distributableRelease': False, 'instrumentation_started': False, 'fullRuntimeVerified': False,
              'root_cause_attributed_to_package': None, 'device_current_install_completion_unknown': False}
    if emulator_owner is not None: result['emulator_owner'] = emulator_owner
    log_path = out/'system-logcat.txt'; log_error = out/'system-logcat.stderr.txt'
    stream = None; log_offset = 0; carry = b''; sample = 0
    def scan(require_live=True):
        nonlocal log_offset, carry
        need(log_path.stat().st_size <= MAX_LOG and log_error.stat().st_size <= MAX_STDOUT, 'system_log_bound')
        with log_path.open('rb') as original:
            original.seek(log_offset); extra = original.read(MAX_LOG+1); log_offset += len(extra)
        lines = (carry+extra).split(b'\n'); carry = lines.pop()
        fatal = [line for line in lines if FATAL.search(line)]
        if FATAL.search(carry): fatal.append(carry)
        if fatal:
            result['observed_crash_lines'] = [{'sha256': sha(line+b'\n'), 'text': line.decode('utf-8', 'replace')} for line in fatal]
            raise ValueError('system_crash_observed_not_package_attribution')
        if require_live: need(stream is not None and stream.poll() is None, 'owned_system_log_stream_lost')
    def health(expected=None, deadline=None):
        nonlocal sample
        label = 'health-%04d' % sample; sample += 1
        boot = host.command(label+'-boot', ['shell', 'cat', '/proc/sys/kernel/random/boot_id'], deadline=deadline).strip().decode()
        pid = host.command(label+'-pid', ['shell', 'pidof', 'system_server'], deadline=deadline).strip().decode()
        service = host.command(label+'-package', ['shell', 'service', 'check', 'package'], deadline=deadline).strip()
        need(re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot) and re.fullmatch('[1-9][0-9]*', pid)
             and service == b'Service package: found', 'system_identity_or_package_service_missing')
        actual = {'boot_id': boot, 'system_server_PID': int(pid)}
        if expected is not None: need(actual == expected, 'system_server_or_boot_changed')
        scan(); return actual
    try:
        for label, args, expected in [('qemu',['shell','getprop','ro.kernel.qemu'],b'1'),
                ('sdk',['shell','getprop','ro.build.version.sdk'],b'35'),
                ('page',['shell','getconf','PAGE_SIZE'],b'16384'),('root',['shell','id','-u'],b'0')]:
            need(host.command(label,args).strip() == expected, 'fixed_fresh_16K_emulator:' + label)
        avd = host.command('avd', ['emu','avd','name']).decode().splitlines()
        need(avd == ['shikuang-pretest-'+plan['unit_nonce'], 'OK'], 'nonce_owned_AVD')
        devices = host.run('devices',[adb,'devices']).decode().splitlines()[1:]
        need([line.split() for line in devices if line.strip()] == [[host.serial,'device']], 'one_emulator_transport')
        memory = host.command('guest-memory',['shell','cat','/proc/meminfo'])
        match = re.search(rb'^MemTotal:\s+(\d+) kB',memory,re.M)
        need(match and 3900000 <= int(match.group(1)) <= 4194304, 'actual_4096MiB_guest')
        result['guest_MemTotal_kB'] = int(match.group(1)); host.network('baseline')
        for row in plan['apks']:
            need(host.command('absent-'+row['role'],['shell','pm','path',row['package']],allow_absent=True).strip() == b'', 'package_preexists_no_uninstall')
        with log_path.open('xb') as stdout, log_error.open('xb') as stderr:
            argv = [adb,'-s',host.serial,'logcat','-b','all','-v','threadtime']
            stream = subprocess.Popen(argv,stdout=stdout,stderr=stderr)
            result['owned_log_stream'] = {'PID':stream.pid,'argv':argv}
            baseline = health(); result['baseline_system'] = baseline
            for row in plan['apks']:
                start = time.monotonic(); end = min(host.deadline,start+INSTALL_SECONDS)
                stage = {'role':row['role'],'started_UTC':utc(),'started_monotonic':start,
                         'deadline_monotonic':end,'state':'started'}
                result['package_stages'].append(stage); result['current_install_role'] = row['role']
                # The package deadline includes pre/post health, hashing and
                # package/version queries, not merely the install client.
                health(baseline,end)
                body = bounded(folder/row['path'],MAX_APK)
                need(len(body) == row['bytes'] and sha(body) == row['sha256'], 'APK_drift_before_install')
                label = 'install-'+row['role']
                result['device_current_install_completion_unknown'] = True
                save(out/'report.json',result)
                host.run(label,[adb,'-s',host.serial,'install','-r','-t',str(folder/row['path'])],
                         seconds=INSTALL_SECONDS,deadline=end,monitor=lambda stop: health(baseline,stop))
                health(baseline,end)
                path = host.command('installed-'+row['role'],['shell','pm','path',row['package']],deadline=end).strip()
                base = installed_base_path(path)
                label = 'installed-sha256-'+row['role']
                checksum = host.run(label,[adb,'-s',host.serial,'shell','sha256sum',base],
                    seconds=INSTALL_SECONDS,deadline=end,monitor=lambda stop: health(baseline,stop))
                checksum_receipt = next(r for r in host.receipts if r['label'] == label)
                need(checksum_receipt['stderr_bytes'] == 0 and
                     checksum == (row['sha256']+'  '+base+'\n').encode(), 'installed_base_APK_SHA_mismatch')
                version = host.command('version-'+row['role'],['shell','dumpsys','package',row['package']],deadline=end)
                observed = installed_version(version, row.get('version_code'))
                stage.update(finished_UTC=utc(),finished_monotonic=time.monotonic())
                need(stage['finished_monotonic'] <= end,'package_stage_deadline')
                stage['state'] = 'installation_observed'
                result['installed'].append({'role':row['role'],'package':row['package'],'sha256':row['sha256'],
                    'installed_base_APK_path':base,'installed_base_APK_sha256':row['sha256'],
                    'observed_version_code':observed,'expected_effective_version_code':row['version_code']})
                result['device_current_install_completion_unknown'] = False
            health(baseline); host.network('final'); scan()
            result['state'] = 'installation_observed'
    except Exception as error:
        result['failure'] = type(error).__name__+': '+str(error)
        if result['package_stages'] and result['package_stages'][-1]['state'] == 'started':
            result['package_stages'][-1].update(state='failed',finished_UTC=utc(),finished_monotonic=time.monotonic())
        raise
    finally:
        if stream:
            result['owned_log_stream_cleanup'] = stop_owned(stream)
            if stream.poll() is None: result['state'] = 'pretest_install_failed'; result['cleanup_unconfirmed'] = True
        if log_path.exists():
            try: scan(require_live=False)
            except Exception as error:
                result['final_log_failure'] = str(error); result['state'] = 'pretest_install_failed'
        paths = [p for p in [log_path,log_error] if p.exists()]
        if paths:
            try:
                _, result['original_logs'] = snapshot_logs(paths,out/'input-log-snapshots')
            except Exception as error: result['snapshot_failure'] = str(error); result['state'] = 'pretest_install_failed'
        result['phase_elapsed_seconds'] = seconds-(host.deadline-time.monotonic())
        if result['phase_elapsed_seconds'] > seconds:
            result['phase_budget_exceeded'] = True; result['state'] = 'pretest_install_failed'
        result['actual_health_samples'] = sample
        save(out/'report.json',result)
    need(result['state'] == 'installation_observed' and 'snapshot_failure' not in result, 'pretest_install_failed')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='mode',required=True)
    for name in ['freeze','install']:
        q = sub.add_parser(name); q.add_argument('--source',required=True); q.add_argument('--nonce',required=True)
        q.add_argument('--out',type=Path,required=True)
        if name == 'freeze': q.add_argument('--resolved',type=Path,required=True); q.add_argument('--sdk',type=Path,required=True)
        else:
            q.add_argument('--plan',type=Path,required=True); q.add_argument('--plan-sha',required=True)
            q.add_argument('--emulator-owner',type=Path,required=True)
    args = p.parse_args()
    if args.mode == 'freeze': freeze(args)
    else:
        identity(args.source,args.nonce,Path.cwd())
        plan = check_plan(bounded(args.plan,65536),args.plan_sha,args.source,args.nonce,args.plan.parent,
                          run_id=os.environ['GITHUB_RUN_ID'])
        owner = json.loads(bounded(args.emulator_owner,8192)); argv = owner.get('argv',[])
        need(owner.get('source_sha') == args.source and owner.get('nonce') == args.nonce
             and type(owner.get('PID')) is int and owner['PID'] > 0
             and '-avd' in argv and argv[argv.index('-avd')+1] == 'shikuang-pretest-'+args.nonce
             and '-memory' in argv and argv[argv.index('-memory')+1] == '4096', 'actual_emulator_launch_receipt')
        observe_install(plan,args.plan.parent,args.out,emulator_owner=owner)
        print(json.dumps({'installation_observed':True,'product_acceptance':False}))


if __name__ == '__main__': main()

"""Opt-in MemoryInfra experiment coordinator. Candidate only; no execution at import.

Reuse the canonical artifact freezer, recorder, package checks, offline-route
setup and offline journal collector. This is never ordinary product acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import zipfile
import xml.etree.ElementTree as ET
from types import SimpleNamespace

import android_pretest_install_diagnostic as pre
from android_offline_setup import prepare_offline_routes
import collect_memoryinfra as journal

CONFIG = Path('tools/memoryinfra-config.json')
FROZEN = Path('memoryinfra-frozen')
SERIAL = 'emulator-5554'
PACKAGE = 'com.shikuang.app.preview'
ARMS = ('catalog-detail-only', 'native-inference-only', 'combined-first-detail')
FINGERPRINT = 'google/sdk_gphone16k_x86_64/emu64xa16k:15/AE3A.240806.043/12960925:userdebug/dev-keys'
OS_BUILD_ID = 'AE3A.240806.043'
ELF_BUILD_ID = '2fdf3a989203643cc036b36c2d7975dfe53e8ca3'
BASE = '5a004ef9e121c3039df0645b0e08e2b27decb99f'


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def arm_nonce(nonce, arm):
    need(re.fullmatch('[a-f0-9]{32}', nonce) and arm in ARMS, 'exact unit/arm nonce scope')
    return hashlib.sha256(('memoryinfra-v1:' + nonce + ':' + arm).encode()).hexdigest()[:32]


def authentication(source, nonce, config, env=None, actual_head=None):
    e = os.environ if env is None else env
    need(config.get('schema') == 'memoryinfra-dispatch-config-v1' and config.get('enabled') is True,
         'committed reviewed diagnostic config remains disabled')
    need(re.fullmatch('[a-f0-9]{40}', source) and source != BASE
         and re.fullmatch('[a-f0-9]{32}', nonce), 'new exact source and nonce')
    need(e.get('GITHUB_ACTIONS') == 'true' and e.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
         and e.get('GITHUB_RUN_ATTEMPT') == '1' and e.get('GITHUB_SHA') == source
         and re.fullmatch('[1-9][0-9]*', e.get('GITHUB_RUN_ID', ''))
         and e.get('SHIKUANG_MEMORYINFRA_DIAGNOSTIC') == 'true', 'one explicit diagnostic dispatch')
    need(all(e.get(k, 'false') == 'false' for k in ['SHIKUANG_PRETEST_INSTALL',
         'SHIKUANG_RENDER_DIAGNOSTIC', 'SHIKUANG_LIFECYCLE_DIAGNOSTIC']), 'mixed diagnostic modes forbidden')
    if actual_head is not None:
        need(actual_head == source, 'actual checkout differs')
    return {'source_sha': source, 'unit_nonce': nonce, 'run_id': e['GITHUB_RUN_ID'], 'run_attempt': 1}


def source_contract(source, nonce, *, verify_dist=False):
    config = json.loads(pre.bounded(CONFIG, 65536))
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], timeout=5).decode().strip()
    auth = authentication(source, nonce, config, actual_head=head)
    need(subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], timeout=5).returncode == 0,
         'tracked source drift')
    pins = json.loads(pre.bounded(Path('tools/memoryinfra-product-pins.json'), 65536))
    need(pins.get('android_base_commit') == BASE and pins.get('compiled_dist_count') == 168,
         'reviewed unchanged App5a product pins')
    # AGENTS/REQUIREMENTS are contextual dirty-file snapshots, not runtime inputs.
    # The neutral freezer refactor has its own immutable reviewed source pin.
    excluded = {'AGENTS.md', 'REQUIREMENTS.md', 'tools/android_pretest_install_diagnostic.py',
                '.github/workflows/android-runtime.yml'}
    for row in pins['protected_existing_files']:
        if row['path'] in excluded:
            continue
        body = pre.bounded(Path(row['path']), 2 * 1024 * 1024)
        need(len(body) == row['bytes'] and digest(body) == row['sha256'], 'ordinary/product source drift:' + row['path'])
    if verify_dist:
        for row in pins['compiled_dist']:
            body = pre.bounded(Path('dist') / row['path'], 256 * 1024 * 1024)
            need(len(body) == row['bytes'] and digest(body) == row['sha256'], 'compiled App asset drift:' + row['path'])
    for path, wanted in config['tool_sha256'].items():
        need(path.startswith('tools/') and re.fullmatch('[a-f0-9]{64}', wanted), 'fixed tool pin')
        need(digest(pre.bounded(Path(path), 1024 * 1024)) == wanted, 'reviewed diagnostic tool drift')
    need(set(config.get('ci_control_sha256', {})) == {'.github/workflows/android-runtime.yml',
         '.github/workflows/android-memoryinfra-diagnostic.yml'}, 'both reviewed CI control pins required')
    for path, wanted in config['ci_control_sha256'].items():
        need(path in ('.github/workflows/android-runtime.yml', '.github/workflows/android-memoryinfra-diagnostic.yml')
             and re.fullmatch('[a-f0-9]{64}', wanted), 'fixed reviewed CI control pin')
        need(digest(pre.bounded(Path(path), 256 * 1024)) == wanted, 'reviewed CI control drift')
    return auth, config, pins


def freeze(args):
    auth, config, pins = source_contract(args.source, args.nonce, verify_dist=True)
    need(args.out == FROZEN, 'fixed cross-job freeze location')
    # Same body/SDK/signature/manifest checks as existing canonical freeze, own auth.
    pre.freeze_artifacts(SimpleNamespace(source=args.source, nonce=args.nonce,
        resolved=args.resolved, sdk=args.sdk, out=FROZEN), auth)
    raw = pre.bounded(FROZEN / 'apk-plan.json', 65536)
    plan = pre.check_plan(raw, digest(raw), args.source, args.nonce, FROZEN,
                          run_id=os.environ['GITHUB_RUN_ID'])
    # Actual packaged bytes, not just dist source/build success.
    app = FROZEN / plan['apks'][0]['path']
    with zipfile.ZipFile(app) as apk:
        names = apk.namelist(); need(len(names) == len(set(names)), 'duplicate APK ZIP member')
        for row in pins['compiled_dist']:
            info = apk.getinfo('assets/public/' + row['path'])
            need(info.file_size == row['bytes'], 'packaged asset size drift')
            need(digest(apk.read(info)) == row['sha256'], 'packaged asset SHA drift')
    save(FROZEN / 'memoryinfra-build-receipt.json', {'schema':'memoryinfra-frozen-build-v1',
        **auth, 'base_app_source':BASE, 'plan_sha256':digest(raw),
        'actual_packaged_assets_verified':168, 'same_app_test_signer':True,
        'three_apks':[{k:r[k] for k in ['role','path','bytes','sha256','certificate_sha256']} for r in plan['apks']],
        'product_acceptance':False, 'no_instrumentation_during_build':True})


def installed_image(sdk, config):
    folder = sdk / 'system-images/android-35/google_apis_ps16k/x86_64'
    raw = pre.bounded(folder / 'source.properties', 65536)
    values = dict(re.findall(r'^([^#=\r\n]+)=(.*)$', raw.decode(), re.M))
    values = {k.strip():v.strip() for k,v in values.items()}
    need(values.get('Pkg.Revision') == str(config['image']['revision'])
         and values.get('AndroidVersion.ApiLevel') == '35' and values.get('SystemImage.Abi') == 'x86_64',
         'installed official image revision/API/ABI differ; do not substitute or skip')
    return raw, pre.bounded(folder / 'package.xml', 1024 * 1024)


def provider_path(raw):
    need(len(raw) < 4096, 'bounded stock provider path')
    match = re.fullmatch(rb'package:(/[A-Za-z0-9_+=~./-]+\.apk)', raw.strip())
    need(match and all(p not in ('.', '..') for p in match[1].decode().split('/')), 'single fixed stock provider APK')
    value = match[1].decode()
    need(value.startswith(('/data/app/', '/system/', '/product/')), 'unexpected stock provider prefix')
    return value


def elf_build_id(raw):
    ids = re.findall(rb'^\s*Build ID: ([a-f0-9]+)\s*$', raw, re.M)
    need(ids == [ELF_BUILD_ID.encode()], 'exact original libmonochrome ELF BuildId required')
    return ids[0].decode()


def xml_root(raw):
    need(0<len(raw)<=8*1024*1024 and b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw,
         'bounded literal package XML')
    return ET.fromstring(raw)


def android_manifest_attribute(element, name):
    # apkanalyzer's decoded XML may emit unqualified attributes, while source
    # XML uses the Android namespace. Both identify the same attribute; never
    # choose one silently when both representations contain conflicting values.
    qualified = element.get('{http://schemas.android.com/apk/res/android}' + name)
    plain = element.get(name)
    need(qualified is None or plain is None or qualified == plain,
         'conflicting Android manifest attribute: ' + name)
    return qualified if qualified is not None else (plain if plain is not None else '')


def static_use(raw):
    root=xml_root(raw)
    need(root.tag=='manifest' and root.get('package')=='com.google.android.webview', 'actual WebView APK manifest')
    rows=[{'name':android_manifest_attribute(r,'name'),'version':android_manifest_attribute(r,'version')}
          for r in root.findall('./application/uses-static-library')]
    # Select the actual declared Trichrome dependency, never an installed package suffix.
    selected=[r for r in rows if r['name'].endswith('.trichromelibrary')]
    need(len(selected)==1 and re.fullmatch('[A-Za-z0-9_.]{1,200}',selected[0]['name'])
         and re.fullmatch('[0-9]{1,19}',selected[0]['version']), 'actual Trichrome static-library declaration')
    return selected[0]


def static_candidates(raw, use):
    root=xml_root(raw);need(root.tag=='packages','actual PackageManager installed metadata')
    rows=[]
    for r in root.findall('package'):
        name=r.get('name','');real=r.get('realName','');code=r.get('codePath','')
        # These are discovery filters only. Each candidate must still bind its
        # actual static-library manifest name/version, PackageManager path and ELF.
        if name==use['name'] or real==use['name'] or name.startswith(use['name']+'_'):
            need(re.fullmatch('[A-Za-z0-9_.]{1,256}',name)
                 and re.fullmatch('/[A-Za-z0-9_+=~./-]+',code)
                 and all(v not in ('.','..') for v in code.split('/')), 'bounded installed static-library candidate')
            rows.append({'package':name,'realName':real,'codePath':code})
    need(0<len(rows)<=4 and len({r['package'] for r in rows})==len(rows),
         'finite unique actual installed static-library candidates')
    return rows


def static_definition(raw, use):
    root=xml_root(raw)
    rows=root.findall('./application/static-library')
    return (root.tag=='manifest' and len(rows)==1 and android_manifest_attribute(rows[0],'name')==use['name']
            and android_manifest_attribute(rows[0],'version')==use['version'])


def package_manager_metadata(host, out):
    # Android 15 may persist packages.xml as ABX, despite its filename. Keep
    # the original bytes; the platform converter reads that exact saved stdin.
    raw=host.run('package-manager-original-metadata',
        ['adb','-s',SERIAL,'exec-out','cat','/data/system/packages.xml'],seconds=15,stdout_cap=8*1024*1024)
    proof={'original_bytes':len(raw),'original_sha256':digest(raw),
           'original_member':'package-manager-original-metadata.stdout.bin'}
    if raw.startswith(b'ABX\x00'):
        command=['adb','-s',SERIAL,'shell','-T','-e','none','/system/bin/abx2xml','-','-']
        # exec-out only copies device stdout; it does not forward host stdin.
        xml=host.run('package-manager-abx2xml',command,seconds=30,stdout_cap=8*1024*1024,
                     stdin_path=out/'package-manager-original-metadata.stdout.bin')
        receipt=host.receipts[-1].get('stdin',{})
        need(receipt.get('bytes')==len(raw) and receipt.get('sha256')==digest(raw)
             and receipt.get('verified_after') is True and receipt.get('consumed_bytes')==len(raw),
             'converter stdin does not bind original PackageManager bytes')
        need(host.receipts[-1].get('stderr_bytes')==0,'platform ABX converter stderr')
        proof.update(format='ABX-v0',converter=command,stdin_verified=True,
            converter_contract='https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/cmds/abx/src/com/android/commands/abx/Abx.java')
    else:
        need(not raw.startswith(b'ABX'),'unsupported PackageManager binary XML version')
        xml=raw;proof.update(format='XML',converter=None)
    need(xml_root(xml).tag=='packages','actual PackageManager installed metadata')
    proof.update(xml_bytes=len(xml),xml_sha256=digest(xml))
    save(out/'package-manager-metadata-binding.json',proof)
    return xml,proof


def stock_provider(host, out, sdk):
    provider=host.command('stock-webview',['shell','dumpsys','webviewupdate'])
    need(b'Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)' in provider
         and b'versionCode: 636771938' in provider, 'stock provider exact version/code drift')
    analyzer=sdk/'cmdline-tools/latest/bin/apkanalyzer'
    temporary=[]
    def capture(label,path):
        target=out/(label+'.stdout.bin');temporary.append(target)
        host.run(label,['adb','-s',SERIAL,'exec-out','cat',path],seconds=60,stdout_cap=256*1024*1024)
        return target
    try:
        web_path=provider_path(host.command('webview-apk-path',['shell','pm','path','com.google.android.webview']))
        web_apk=capture('webview-original-apk',web_path)
        use=static_use(host.run('webview-actual-manifest',[str(analyzer),'manifest','print',str(web_apk)],seconds=30))
        packages,package_binding=package_manager_metadata(host,out)
        candidates=static_candidates(packages,use);matches=[]
        for i,candidate in enumerate(candidates):
            actual=provider_path(host.command('static-candidate-%d-path'%i,['shell','pm','path',candidate['package']]))
            code=candidate['codePath'].rstrip('/')
            need(actual==code or str(Path(actual).parent)==code, 'PackageManager codePath/pm path mismatch')
            apk=capture('static-candidate-%d-apk'%i,actual)
            manifest=host.run('static-candidate-%d-manifest'%i,[str(analyzer),'manifest','print',str(apk)],seconds=30)
            if not static_definition(manifest,use):
                continue
            declared=xml_root(manifest).get('package','')
            need(re.fullmatch('[A-Za-z0-9_.]{1,200}',declared) and
                 (candidate['realName']==declared or candidate['package']==declared
                  or candidate['package'].startswith(declared+'_')), 'actual installed/manifest package binding')
            matches.append({**candidate,'apk':apk,'path':actual,'manifest_package':declared})
        need(len(matches)==1,'exactly one installed static-library name/version binding')
        chosen=matches[0];apk=chosen.pop('apk');elf=out/'libmonochrome_64.so';temporary.append(elf)
        with zipfile.ZipFile(apk) as archive:
            need(len(archive.namelist())==len(set(archive.namelist())), 'provider APK duplicate member')
            info=archive.getinfo('lib/x86_64/libmonochrome_64.so');need(0<info.file_size<=256*1024*1024,'bounded exact stock ELF')
            with archive.open(info) as source,elf.open('xb') as target:
                total=0
                while True:
                    chunk=source.read(1024*1024)
                    if not chunk:break
                    total+=len(chunk);need(total<=info.file_size,'ELF expansion bound');target.write(chunk)
                need(total==info.file_size,'complete ELF')
        notes=host.run('stock-elf-notes',['readelf','--notes',str(elf)],seconds=30)
        result={'provider_version':'124.0.6367.219','provider_code':636771938,
                'provider_package':'com.google.android.webview','webview_apk_path':web_path,
                'webview_apk_sha256':digest(web_apk.read_bytes()),'actual_uses_static_library':use,
                'installed_static_library_join':chosen,'elf_build_id':elf_build_id(notes),
                'package_manager_metadata_binding':package_binding,
                'stock_apk_sha256':digest(apk.read_bytes()),'stock_apk_bytes':apk.stat().st_size,
                'elf_sha256':digest(elf.read_bytes()),'elf_bytes':elf.stat().st_size,
                'candidate_filter_does_not_assign_dependency':True,
                'official_provider_binary_not_redistributed':True}
        save(out/'stock-provider-proof.json',result);return result
    finally:
        # Preserve original manifests/PackageManager XML/notes/SHA receipts, no Google binaries.
        for path in temporary:path.unlink(missing_ok=True)


def owned_receipt(owner, source, nonce, arm):
    expected='shikuang-memoryinfra-'+arm_nonce(nonce,arm)
    argv=owner.get('argv',[])
    need(owner.get('source_sha')==source and owner.get('arm_nonce')==arm_nonce(nonce,arm)
         and owner.get('arm')==arm and type(owner.get('PID')) is int and owner['PID']>0
         and isinstance(argv,list) and '-avd' in argv and argv[argv.index('-avd')+1]==expected
         and '-memory' in argv and argv[argv.index('-memory')+1]=='4096'
         and '-cores' in argv and argv[argv.index('-cores')+1]=='2'
         and '-no-snapshot' in argv, 'owned fresh fixed AVD launch receipt')
    return expected


def stop_log_client(log, report):
    if log is None:
        return
    try:
        receipt=pre.stop_owned(log);report['owned_log_cleanup']=receipt
        if receipt.get('terminal_return_code') is None:
            report['cleanup_errors'].append('owned log client termination unconfirmed')
    except Exception as error:
        report['cleanup_errors'].append('owned log cleanup: '+type(error).__name__+': '+str(error))


def run_arm(args):
    auth,config,pins=source_contract(args.source,args.nonce)
    need(args.arm in ARMS and re.fullmatch('[a-f0-9]{64}',args.plan_sha), 'exact arm/frozen plan')
    raw=pre.bounded(FROZEN/'apk-plan.json',65536)
    frozen=pre.check_plan(raw,args.plan_sha,args.source,args.nonce,FROZEN,run_id=os.environ['GITHUB_RUN_ID'])
    build=json.loads(pre.bounded(FROZEN/'memoryinfra-build-receipt.json',65536))
    need(build.get('plan_sha256')==args.plan_sha and build.get('source_sha')==args.source
         and build.get('run_id')==os.environ['GITHUB_RUN_ID'] and build.get('actual_packaged_assets_verified')==168,
         'same run/same build APK receipt')
    args.out.mkdir(parents=True,exist_ok=False);calls=args.out/'calls';calls.mkdir()
    host=pre.Recorder(calls,seconds=780);nonce=arm_nonce(args.nonce,args.arm)
    report={'schema':'memoryinfra-arm-run-v1',**auth,'arm':args.arm,'arm_nonce':nonce,
            'base_app_source':BASE,'frozen_plan_sha256':args.plan_sha,'passed':False,
            'product_acceptance':False,'root_cause_proven':False,'observed_app_pids':[], 'cleanup_errors':[]}
    log=None;primary=None;actual_pid=None;owned_transport_verified=False
    try:
        owner_raw=pre.bounded(args.owner,8192)
        (args.out/'owner-receipt.original.json').write_bytes(owner_raw)
        owner=json.loads(owner_raw);avd=owned_receipt(owner,args.source,args.nonce,args.arm)
        need(host.command('actual-avd',['emu','avd','name']).decode().splitlines()==[avd,'OK'],'actual nonce AVD')
        owned_transport_verified=True
        report['owned_transport_verified']=True
        for label,command,wanted in [('qemu',['getprop','ro.kernel.qemu'],b'1'),('sdk',['getprop','ro.build.version.sdk'],b'35'),
                ('abi',['getprop','ro.product.cpu.abi'],b'x86_64'),('page',['getconf','PAGE_SIZE'],b'16384'),
                ('os-build-id',['getprop','ro.build.id'],OS_BUILD_ID.encode()),('os-fingerprint',['getprop','ro.build.fingerprint'],FINGERPRINT.encode())]:
            need(host.command(label,['shell',*command]).strip()==wanted,'original stock profile drift:'+label)
        image,package_xml=installed_image(args.sdk,config)
        (args.out/'image-source.properties').write_bytes(image);(args.out/'image-package.xml').write_bytes(package_xml)
        mem=host.command('guest-memory',['shell','cat','/proc/meminfo']);match=re.search(rb'^MemTotal:\s+(\d+) kB',mem,re.M)
        need(match and 3900000<=int(match[1])<=4194304,'actual 4096MiB guest')
        report['stock_provider']=stock_provider(host,calls,args.sdk)
        host.network('before-install')
        for row in frozen['apks']:
            need(host.command('absent-'+row['role'],['shell','pm','path',row['package']],allow_absent=True).strip()==b'', 'fresh AVD package already present')
            host.run('install-'+row['role'],['adb','-s',SERIAL,'install','-t',str(FROZEN/row['path'])],seconds=90)
            actual=pre.installed_base_path(host.command('installed-'+row['role'],['shell','pm','path',row['package']]).strip())
            checksum=host.command('installed-sha-'+row['role'],['shell','sha256sum',actual])
            need(checksum==(row['sha256']+'  '+actual+'\n').encode(),'installed APK differs from single frozen build')
            pre.installed_version(host.command('installed-version-'+row['role'],['shell','dumpsys','package',row['package']]),row['version_code'])
        need(host.command('before-app-pid',['shell','pidof',PACKAGE],allow_absent=True).strip()==b'','AppPID existed before instrumentation')
        report['before_app_pid_absent']=True
        log_path=args.out/'logcat.txt';error_path=args.out/'logcat.stderr.txt'
        with log_path.open('xb') as stdout,error_path.open('xb') as stderr:
            log=subprocess.Popen(['adb','-s',SERIAL,'logcat','-b','all','-v','threadtime'],stdout=stdout,stderr=stderr)
        next_pid=0;sample=0
        def monitor(deadline):
            nonlocal next_pid,sample
            need(log.poll() is None and log_path.stat().st_size<=32*1024*1024
                 and error_path.stat().st_size<=2*1024*1024,'bounded live log stream')
            if time.monotonic()>=next_pid:
                rawpid=host.command('app-pid-%03d'%sample,['shell','pidof',PACKAGE],allow_absent=True,deadline=deadline).strip();sample+=1
                need(rawpid==b'' or re.fullmatch(rb'[1-9][0-9]*',rawpid),'unambiguous actual app PID')
                if rawpid:
                    pid=int(rawpid)
                    if pid not in report['observed_app_pids']:report['observed_app_pids'].append(pid)
                    need(len(report['observed_app_pids'])<=1,'AppPID restarted during single arm')
                next_pid=time.monotonic()+2
        command=['adb','-s',SERIAL,'shell','am','instrument','-w','-r',
            '-e','class','com.shikuang.app.MemoryInfraDiagnosticTest#observeArm',
            '-e','memoryInfraDiagnostic','true','-e','memoryInfraArm',args.arm,
            '-e','diagnosticNonce',nonce,'-e','expectedSourceSha',args.source,
            '-e','baseAppSourceSha',BASE,'-e','expectedBuildId',OS_BUILD_ID,
            '-e','useTestStorageService','true',PACKAGE+'.test/androidx.test.runner.AndroidJUnitRunner']
        host.run('instrumentation',command,seconds=480,monitor=monitor)
        host.network('after-instrumentation')
    except Exception as error:
        primary=error;report['failure']=type(error).__name__+': '+str(error)
    finally:
        stop_log_client(log,report)
        if owned_transport_verified:
            # Independent finite cleanup budget even when the action deadline expired.
            cleanup_path=args.out/'finally';cleanup_path.mkdir();cleanup=pre.Recorder(cleanup_path,seconds=90)
            queries=[('final-logcat',['logcat','-b','all','-d','-v','threadtime'],32*1024*1024),
                     ('final-provider',['shell','dumpsys','webviewupdate'],2*1024*1024),
                     ('final-app-package',['shell','dumpsys','package',PACKAGE],2*1024*1024),
                     ('final-test-package',['shell','dumpsys','package',PACKAGE+'.test'],2*1024*1024),
                     ('final-exit-info',['shell','dumpsys','activity','exit-info',PACKAGE],2*1024*1024),
                     ('final-tombstone-index',['shell','ls','-l','/data/tombstones'],2*1024*1024),
                     ('journal-tar',['exec-out','run-as',PACKAGE,'tar','-C','files','-cf','-', 'memoryinfra-diagnostic-'+nonce+'/'+args.arm],8*1024*1024)]
            for label,argv,cap in queries:
                try:cleanup.run(label,['adb','-s',SERIAL,*argv],seconds=10,stdout_cap=cap)
                except Exception as error:report['cleanup_errors'].append(label+': '+str(error))
            try:
                need(len(report['observed_app_pids'])==1,'host actual fresh AppPID not observed')
                actual_pid=report['observed_app_pids'][0]
                expected=journal.contract(args.source,nonce,args.arm,actual_pid,OS_BUILD_ID)
                result=journal.collect(cleanup_path/'journal-tar.stdout.bin',calls/'instrumentation.stdout.bin',args.out/'journal-collection',expected)
                report['journal_assessment']=result
                need(result['diagnostic_observation_complete'],'journal incomplete or exact one-method runtime failed')
                need(primary is None and not report['cleanup_errors'],'action or mandatory evidence collection failed')
                report['passed']=True
            except Exception as error:
                report['assessment_failure']=str(error)
        else:
            report['owned_transport_verified']=False
            report['transport_cleanup_skipped']='receipt or actual AVD not verified; no further transport access'
        save(args.out/'arm-report.json',report)
    need(report['passed'],'diagnostic arm failed; preserved stage evidence; no retry/skip')
    return report


def preserve_setup(args):
    """Always-step only; never touch a transport without the owned AVD receipt."""
    args.out.mkdir(parents=True, exist_ok=False)
    report={'schema':'memoryinfra-setup-final-evidence-v1','product_acceptance':False,
            'source_sha':args.source,'unit_nonce':args.nonce,'arm':args.arm,'errors':[]}
    try:
        auth,config,pins=source_contract(args.source,args.nonce)
        report['verified_host_identity']=auth
        if not args.owner.is_file():
            report['owned_emulator_never_launched']=True
            return
        owner_raw=pre.bounded(args.owner,8192)
        (args.out/'owner-receipt.original.json').write_bytes(owner_raw)
        owner=json.loads(owner_raw);avd=owned_receipt(owner,args.source,args.nonce,args.arm)
        host=pre.Recorder(args.out,seconds=60)
        need(host.command('setup-actual-avd',['emu','avd','name']).decode().splitlines()==[avd,'OK'],
             'setup collector actual AVD differs; no further transport access')
        report['owned_transport_verified']=True
        for label,command,cap in [('setup-final-getprop',['shell','getprop'],2*1024*1024),
                ('setup-final-provider',['shell','dumpsys','webviewupdate'],2*1024*1024),
                ('setup-final-logcat',['logcat','-b','all','-d','-v','threadtime'],32*1024*1024)]:
            try:host.run(label,['adb','-s',SERIAL,*command],seconds=15,stdout_cap=cap)
            except Exception as error:report['errors'].append(label+': '+str(error))
    except Exception as error:
        report['errors'].append(type(error).__name__+': '+str(error))
    finally:
        save(args.out/'setup-evidence-report.json',report)
    need(not report['errors'], 'mandatory final setup evidence failed; see preserved report')


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='mode',required=True)
    for name in ['guard','freeze','run','preserve']:
        p=sub.add_parser(name);p.add_argument('--source',required=True);p.add_argument('--nonce',required=True)
        if name!='guard':p.add_argument('--sdk',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
        if name=='freeze':p.add_argument('--resolved',type=Path,required=True)
        if name in ('run','preserve'):
            p.add_argument('--arm',choices=ARMS,required=True);p.add_argument('--owner',type=Path,required=True)
        if name=='run':p.add_argument('--plan-sha',required=True)
    args=parser.parse_args()
    if args.mode=='guard':source_contract(args.source,args.nonce)
    elif args.mode=='freeze':freeze(args)
    elif args.mode=='preserve':preserve_setup(args)
    else:run_arm(args)

if __name__=='__main__':main()

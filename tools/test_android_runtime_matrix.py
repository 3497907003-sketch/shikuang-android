"""SOURCE/configuration-only routing tests; no adb, emulator, App or models."""
from pathlib import Path
import json,re,subprocess,textwrap,unittest

WORKFLOW=Path(__file__).resolve().parents[1]/'.github/workflows/android-runtime.yml'
FOUR=[{'api':24,'id':'24','tag':'google_apis','pageSize':4096},
      {'api':30,'id':'30','tag':'google_apis','pageSize':4096},
      {'api':35,'id':'35','tag':'google_apis','pageSize':4096},
      {'api':35,'id':'35-16k','tag':'google_apis_ps16k','pageSize':16384}]

class RuntimeMatrixTests(unittest.TestCase):
    def test_default_four_and_optional_16K_selection_preserve_exact_profiles_with_probe_priority(self):
        source=WORKFLOW.read_text()
        expression=next(line.strip()[len('include: '):] for line in source.splitlines() if line.strip().startswith('include: '))
        match=re.fullmatch(r"\$\{\{ fromJSON\(inputs\.network_probe && '([^']+)' \|\| inputs\.runtime_api35_16k_only && '([^']+)' \|\| '([^']+)'\) \}\}",expression)
        self.assertIsNotNone(match,'network probe must remain the first selection')
        network,single,default=[json.loads(x) for x in match.groups()]
        self.assertEqual(default,FOUR);self.assertEqual(single,[FOUR[3]]);self.assertEqual(network,[FOUR[2]])
        for probe,only,expected in [(False,False,FOUR),(False,True,[FOUR[3]]),(True,False,[FOUR[2]]),(True,True,[FOUR[2]])]:
            selected=network if probe else single if only else default
            self.assertEqual(selected,expected)
        flag=source.split('      runtime_api35_16k_only:',1)[1].split('      native_dialog_diagnostic:',1)[0]
        self.assertRegex(flag,r'type: boolean');self.assertRegex(flag,r'default: false')

    def test_actual_guest_RAM_shell_block_changes_only_the_exact_16K_runtime_profile(self):
        source=WORKFLOW.read_text();lines=source.splitlines()
        start=next(i for i,x in enumerate(lines) if x.strip()=='SHIKUANG_EMULATOR_MEMORY_MIB=3072')
        end=next(i for i in range(start,len(lines)) if lines[i].strip()=='fi')
        script=textwrap.dedent('\n'.join(lines[start:end+1]))+"\nprintf '%s' \"$SHIKUANG_EMULATOR_MEMORY_MIB\"\n"
        cases=[(row,4096 if row==FOUR[3] else 3072) for row in FOUR]
        cases.extend([({**FOUR[3],'tag':'google_apis'},3072),({**FOUR[3],'pageSize':4096},3072),({**FOUR[3],'id':'other-16k'},3072)])
        for row,expected in cases:
            fixture=script
            for key,value in row.items():fixture=fixture.replace('${{ matrix.'+key+' }}',str(value))
            with self.subTest(row=row):
                result=subprocess.run(['bash','-c',fixture],capture_output=True,timeout=3)
                self.assertEqual((result.returncode,result.stderr,result.stdout),(0,b'',str(expected).encode()))
        marker='\n  lifecycle-diagnostic:'
        self.assertEqual(source.count(marker),1,'exact diagnostic-job boundary must exist')
        runtime=source.split(marker,1)[0]
        self.assertIn('-memory "$SHIKUANG_EMULATOR_MEMORY_MIB"',runtime)
        self.assertIn('emulator-configured-memory-mib.txt',runtime)

    def test_preinstall_evidence_is_read_only_and_existing_test_gates_remain(self):
        source=WORKFLOW.read_text()
        evidence=source.split('      - name: Record guest resources and package service before UTP installation',1)[1].split('      - name: Run packaged WebView',1)[0]
        for command in ['shell cat /proc/meminfo','shell getprop ro.build.fingerprint','shell pidof system_server','shell service check package']:
            self.assertIn(command,evidence)
        for forbidden in ['force-stop','kill','disable','settings put','reboot','adb root','install -r']:
            self.assertNotIn(forbidden,evidence)
        self.assertEqual(evidence.count('timeout 15 adb -s emulator-5554'),4)
        self.assertIn('pre-install-command-status.txt',evidence)
        self.assertIn('-Pandroid.testInstrumentationRunnerArguments.expectedPageSize=${{ matrix.pageSize }}',source)
        self.assertIn('com.shikuang.app.MineralModelContractTest,com.shikuang.app.ReviewedPhotoAssetsInstrumentedTest,com.shikuang.app.MineralEngineInstrumentedTest',source)
        self.assertIn('--expected-page-size ${{ matrix.pageSize }}',source)
        # Dedicated diagnostic jobs retain their pre-existing RAM and dispatch isolation.
        self.assertEqual(source.count('-memory 3072'),2)
        self.assertIn("if: ${{ !(github.event_name == 'workflow_dispatch' && (inputs.lifecycle_diagnostic || inputs.native_dialog_diagnostic)) }}",source)

if __name__=='__main__':unittest.main()

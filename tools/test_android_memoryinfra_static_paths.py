"""Actual PM XML metadata; explicitly synthetic list output and APK/ELF bytes.

No pm --match-libraries command, ADB, emulator, real APK or App executes here.
The new CLI branch still requires actual Android CI verification.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
import android_memoryinfra_diagnostic as m

ROOT=Path(__file__).resolve().parents[1]
FIXTURE=ROOT/'tools/fixtures/memoryinfra-static-package.actual.xml'
PROVENANCE=ROOT/'tools/fixtures/memoryinfra-static-package.provenance.json'
USE={'name':'com.google.android.trichromelibrary','version':'636771938'}


def candidate():
    raw=FIXTURE.read_bytes()
    assert hashlib.sha256(raw).hexdigest()=='5b055c6921426993c515114703c32100d2e13ad20365311f62c10585625b660e'
    return m.static_candidates(raw,USE)[0]


def synthetic_line(path=None,package=None,version=None):
    row=candidate()
    # Only a test fixture chooses base.apk. Production must use actual sourceDir.
    path=path or row['codePath']+'/base.apk'
    return ('package:'+path+'='+(package or USE['name'])+' versionCode:'+
            (version or row['package_version'])+'\n').encode()


class FakeHost:
    """Pure method fake, fixed synthetic APK ZIP and ELF-note output only."""
    def __init__(self,out,*,package=None,library=None,lib_version=None,elf_id=None):
        self.out=out;self.commands=[];self.runs=[]
        self.package=package or USE['name'];self.library=library or USE['name']
        self.lib_version=lib_version or USE['version'];self.elf_id=elf_id or m.ELF_BUILD_ID
    def command(self,label,args):
        self.commands.append((label,args))
        if label=='stock-webview':
            return b'Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)\nversionCode: 636771938\n'
        if label=='webview-apk-path':
            assert args==['shell','pm','path','com.google.android.webview']
            return b'package:/product/app/FixtureWebView/FixtureWebView.apk\n'
        assert label=='static-library-source-paths'
        assert args==['shell','pm','list','packages','--match-libraries','-f','--show-versioncode','--user','0',USE['name']]
        return synthetic_line()
    def run(self,label,argv,**kwargs):
        self.runs.append((label,argv))
        if label=='webview-original-apk':
            raw=b'SYNTHETIC-WEBVIEW-APK-NOT-EXECUTABLE'
        elif label=='webview-actual-manifest':
            raw=('<manifest package="com.google.android.webview"><application><uses-static-library name="'+USE['name']+'" version="'+USE['version']+'"/></application></manifest>').encode()
        elif label=='static-candidate-0-apk':
            assert argv[-1]==candidate()['codePath']+'/base.apk'
            buf=io.BytesIO()
            with zipfile.ZipFile(buf,'w') as archive:
                archive.writestr('lib/x86_64/libmonochrome_64.so',b'SYNTHETIC-ELF-NOT-EXECUTABLE')
            raw=buf.getvalue()
        elif label=='static-candidate-0-manifest':
            raw=('<manifest package="'+self.package+'"><application><static-library name="'+self.library+'" version="'+self.lib_version+'"/></application></manifest>').encode()
        else:
            assert label=='stock-elf-notes'
            raw=('  Build ID: '+self.elf_id+'\n').encode()
        (self.out/(label+'.stdout.bin')).write_bytes(raw)
        return raw


class StaticPathTests(unittest.TestCase):
    def test_actual_metadata_fixture_retains_exact_three_attributes_and_provenance(self):
        proof=json.loads(PROVENANCE.read_text());raw=FIXTURE.read_bytes()
        self.assertEqual(proof['source_run'],41411622226)
        self.assertEqual(proof['source_xml_sha256'],'a36b821535968a340e69d24d65345834c6b3498b48634861a0c50f89e51be1f2')
        self.assertEqual(proof['fixture_sha256'],hashlib.sha256(raw).hexdigest())
        self.assertFalse(proof['pm_list_match_libraries_actual_output_observed'])
        row=candidate();self.assertEqual(row['package'],USE['name']+'_636771938')
        self.assertFalse(row['codePath'].endswith('.apk'))
        self.assertEqual(row['package_version'],'636771938')

    def test_synthetic_external_name_and_equals_path_join_actual_directory(self):
        row=candidate();self.assertIn('==/',row['codePath'])
        paths=m.static_library_paths(synthetic_line());selected=m.static_candidate_path(row,paths)
        self.assertEqual(selected['manifest_package'],USE['name'])
        self.assertNotEqual(selected['manifest_package'],row['package'])
        self.assertEqual(selected['path'],row['codePath']+'/base.apk')

    def test_multiple_versions_join_by_exact_codepath_never_first_or_highest(self):
        listing=synthetic_line('/data/app/other-version/new.apk',version='999999999')+synthetic_line()
        paths=m.static_library_paths(listing)
        self.assertEqual(m.static_candidate_path(candidate(),paths),paths[1])
        self.assertEqual(m.static_candidate_path(candidate(),list(reversed(paths))),paths[1])

    def test_actual_single_apk_codepath_can_match_same_path(self):
        row={**candidate(),'codePath':'/product/app/Trichrome/Trichrome.apk'}
        paths=m.static_library_paths(synthetic_line(row['codePath']))
        self.assertEqual(m.static_candidate_path(row,paths)['path'],row['codePath'])

    def test_invalid_paths_cannot_enter_listing(self):
        for path in ['/tmp/library.apk','/data/app/../bad.apk','/data/app/./bad.apk',
                     '/data/app/$(touch).apk','/data/app/quote".apk','/data/app/has space.apk',
                     '/data/app/back\\slash.apk','relative.apk','/data/app/library.zip']:
            with self.subTest(path=path),self.assertRaises(ValueError):
                m.static_library_paths(synthetic_line(path))

    def test_malformed_listing_is_not_partially_parsed(self):
        good=synthetic_line()
        for raw in [b'',b'\n',good+b'\n',good+b'banner\n',good.replace(b'package:',b'path:',1),
                    good.replace(b' versionCode:',b' version:'),good.replace(b'636771938\n',b'01\n'),
                    good.replace(b'636771938\n',b'-1\n'),good.replace(b'.apk=',b'.apk=invalid-package-'),
                    good.replace(b'.apk=',b'.apk=\xff'),good+b'\x00',b'x'*16385]:
            with self.subTest(raw=raw[:80]),self.assertRaises(ValueError):m.static_library_paths(raw)

    def test_duplicate_paths_and_excessive_records_fail(self):
        good=synthetic_line()
        for raw in [good*2,good+synthetic_line(package='com.other.library'),
                    b''.join(synthetic_line('/data/app/lib'+str(i)+'/base.apk') for i in range(5))]:
            with self.subTest(raw=raw[:80]),self.assertRaises(ValueError):m.static_library_paths(raw)

    def test_version_integer_is_bounded(self):
        self.assertEqual(m.static_library_paths(synthetic_line(version='9223372036854775807'))[0]['package_version'],'9223372036854775807')
        with self.assertRaises(ValueError):m.static_library_paths(synthetic_line(version='9223372036854775808'))

    def test_wrong_codepath_or_version_and_ambiguous_cluster_fail(self):
        row=candidate()
        for raw in [synthetic_line('/data/app/other/base.apk'),synthetic_line(version='1'),
                    synthetic_line()+synthetic_line(row['codePath']+'/split.apk')]:
            with self.subTest(raw=raw[:80]),self.assertRaises(ValueError):
                m.static_candidate_path(row,m.static_library_paths(raw))

    def test_xml_package_version_is_mandatory_and_literal(self):
        raw=FIXTURE.read_bytes()
        for malformed in [raw.replace(b' version="636771938"',b''),raw.replace(b' version="636771938"',b' version="-1"'),raw.replace(b' version="636771938"',b' version="9223372036854775808"')]:
            with self.assertRaises(ValueError):m.static_candidates(malformed,USE)

    def run_stock(self,**kwargs):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        out=Path(temporary.name);host=FakeHost(out,**kwargs)
        with patch.object(m,'package_manager_metadata',return_value=(FIXTURE.read_bytes(),{'format':'ACTUAL-XML-FIXTURE-ONLY'})):
            result=m.stock_provider(host,out,out/'SDK-NOT-EXECUTED')
        return result,host,out

    def test_synthetic_complete_stock_pipeline_uses_explicit_library_flag_and_keeps_gates(self):
        result,host,out=self.run_stock()
        self.assertEqual(result['elf_build_id'],m.ELF_BUILD_ID)
        self.assertEqual(result['provider_code'],636771938)
        self.assertEqual(result['installed_static_library_join']['package'],USE['name']+'_636771938')
        self.assertEqual(result['installed_static_library_join']['manifest_package'],USE['name'])
        listing=result['static_library_path_listing']
        self.assertEqual(listing['sha256'],hashlib.sha256(synthetic_line()).hexdigest())
        self.assertEqual(len([x for x in host.commands if x[0]=='static-library-source-paths']),1)
        self.assertFalse(any(args[:3]==['shell','pm','path'] and args[-1]!= 'com.google.android.webview' for _,args in host.commands))
        self.assertTrue((out/'stock-provider-proof.json').exists())
        self.assertFalse((out/'static-candidate-0-apk.stdout.bin').exists())
        self.assertFalse((out/'libmonochrome_64.so').exists())

    def test_actual_manifest_package_must_equal_listing_external_package(self):
        with self.assertRaisesRegex(ValueError,'actual installed/manifest package binding'):
            self.run_stock(package='com.other.library')

    def test_wrong_static_library_name_or_version_never_assigns_dependency(self):
        for options in ({'library':'com.other.library'},{'lib_version':'1'}):
            with self.subTest(options=options),self.assertRaisesRegex(ValueError,'exactly one installed static-library'):
                self.run_stock(**options)

    def test_wrong_elf_build_id_still_fails_exact_hard_gate(self):
        with self.assertRaisesRegex(ValueError,'exact original libmonochrome ELF BuildId'):
            self.run_stock(elf_id='0'*40)


if __name__=='__main__':unittest.main()

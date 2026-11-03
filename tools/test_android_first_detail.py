"""Host/parser fixtures only; no emulator, Android, native inference or CI."""
import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest

from android_first_detail import verify_first_result_detail

ROOT = Path(__file__).resolve().parents[1]
JAVA = ROOT / 'android/app/src/androidTest/java/com/shikuang/app/MineralEngineInstrumentedTest.java'
MANIFEST_RAW = (ROOT / 'web/model-manifest.json').read_bytes()
MANIFEST_SHA = hashlib.sha256(MANIFEST_RAW).hexdigest()
MANIFEST = json.loads(MANIFEST_RAW)
REFERENCE = json.loads((ROOT / 'web/data/reference-manifest.json').read_text())
CATALOG = json.loads((ROOT / 'web/data/catalog.json').read_text())


def synthetic_report():
    network = {'sdk': 35, 'pageSize': 16384, 'packageName': 'com.shikuang.app.preview',
               'versionName': '2.5.0-preview.1', 'versionCode': 25001,
               'activeNetwork': None, 'connected': False, 'internetCapability': False}
    proof = {'schema': 'android-first-result-detail-before-library-v1',
             'initialLoaderStatus': 'idle', 'initialReferenceRequests': [],
             'initialIdentifyVisible': True, 'initialLibraryHidden': True,
             'libraryClicks': 0, 'libraryStillHidden': True, 'dialogOpen': True,
             'loadingMessageAbsent': True, 'hasOfficialFields': True,
             'galleryPresent': True, 'galleryClosed': True, 'activityRecreateRestoredIdle': True,
             'beforeClick': {'loaderStatus': 'idle', 'referenceRequests': 0,
                             'libraryHidden': True, 'resultVisible': True},
             'loaderStatus': 'ready', 'title': '石英', 'online': False, 'photoRequests': [],
             'analysis': {'key': 'quartz', 'engine': 'onnx-native-android',
                          'modelCount': len(MANIFEST['modes']['ensemble']), 'modelVersion': MANIFEST['version'],
                          'manifestSha256': MANIFEST_SHA, 'diagnostics': {'elapsedMs': 1, 'residentSessionCount': 4}},
             'nativeNetworkBefore': dict(network), 'nativeNetworkAfter': dict(network),
             'totalBookStatements': 190, 'books': 11, 'bookSourcePages': 23, 'bookSpecies': 63,
             'primarySpecies': 6239, 'sourceImageRecords': 871, 'bookSections': 3,
             'quartzBookFields': [{'field': row['field'], 'sourceId': row['source_id'],
                                  'pdfPage': row['pdf_page_1based'], 'renderedValueMatches': True}
                                 for row in CATALOG['reviewed_book_evidence']['records']
                                 if row['catalog_id'] == 'ima-quartz'],
             'requests': [{'path': name, 'url': 'https://localhost' + name, 'local': True,
                           'status': 200, 'startedPhase': 'first-detail-loading'}
                          for name in ['/data/reference-manifest.json'] + ['/' + row['path'] for row in REFERENCE['files']]],
             'screenshot': {'filename': 'quartz-first-result-detail.png', 'selector': '#detailTitle',
                            'text': '石英', 'visualStateSynchronized': True}}
    for stage in ('Before', 'After'):
        proof['screenshot']['nativeWindow' + stage] = {
            'passed': True, 'filename': 'quartz-first-result-detail.png',
            'stage': stage.lower(), 'expectedPackage': 'com.shikuang.app.preview'}
    return {'origin': 'https://localhost', 'firstResultDetail': proof}


class FirstDetailEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shikuang-parser-fixture-')
        self.folder = Path(self.temp.name)
        # Deliberately only signature/length bytes; parser fixture, never a
        # genuine native screenshot or pipeline runtime artifact.
        (self.folder / 'quartz-first-result-detail.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'x' * 1100)
        self.report = synthetic_report()

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        return verify_first_result_detail(self.report, MANIFEST, MANIFEST_SHA, REFERENCE,
                                          CATALOG, 35, 16384, self.folder)

    def test_synthetic_parser_contract_accepts_all_required_fields(self):
        self.assertEqual(self.verify(), {'firstResultDetailBeforeLibraryVerified': True,
            'actualEngine': 'onnx-native-android', 'bookStatements': 190,
            'quartzRenderedFields': 3, 'referenceRequestsAfterDetailClick': 4, 'sdk': 35, 'pageSize': 16384})

    def test_absent_or_incomplete_proof_never_counts_as_executed(self):
        for key in list(self.report['firstResultDetail']):
            with self.subTest(key=key):
                self.report = synthetic_report()
                del self.report['firstResultDetail'][key]
                with self.assertRaises((ValueError, KeyError, TypeError)):
                    self.verify()

    def test_wrong_stage_native_identity_counts_and_rendered_provenance_rejected(self):
        cases = [
            ('initialLoaderStatus', 'ready'), ('initialReferenceRequests', ['prior-reference']),
            ('libraryClicks', 1), ('libraryClicks', False), ('libraryStillHidden', False),
            ('dialogOpen', False), ('loadingMessageAbsent', False), ('hasOfficialFields', False),
            ('galleryPresent', False), ('galleryClosed', False), ('activityRecreateRestoredIdle', False),
            ('online', True), ('photoRequests', ['eager-photo']), ('totalBookStatements', 189),
            ('books', 10), ('bookSourcePages', 22), ('bookSpecies', 62), ('primarySpecies', 6238),
            ('sourceImageRecords', 870), ('bookSections', 2), ('loaderStatus', 'loading'),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.report = synthetic_report(); self.report['firstResultDetail'][key] = value
                with self.assertRaises(ValueError): self.verify()
        for path, value in [
            (('analysis', 'engine'), 'onnx-wasm'), (('analysis', 'key'), 'pyrite'),
            (('analysis', 'modelCount'), 1), (('analysis', 'manifestSha256'), 'a' * 64),
            (('beforeClick', 'referenceRequests'), 4), (('beforeClick', 'resultVisible'), False),
            (('nativeNetworkBefore', 'activeNetwork'), 'network'),
            (('nativeNetworkAfter', 'internetCapability'), True), (('nativeNetworkAfter', 'pageSize'), 4096),
        ]:
            with self.subTest(path=path):
                self.report = synthetic_report(); self.report['firstResultDetail'][path[0]][path[1]] = value
                with self.assertRaises(ValueError): self.verify()
        for key, value in [('field', 'wrong'), ('sourceId', 'wrong'), ('pdfPage', 1), ('renderedValueMatches', False)]:
            self.report = synthetic_report(); self.report['firstResultDetail']['quartzBookFields'][0][key] = value
            with self.assertRaises(ValueError): self.verify()

    def test_external_failed_eager_duplicate_or_missing_reference_requests_rejected(self):
        for key, value in [('url', 'https://outside.invalid/data/catalog.json'), ('local', False),
                           ('status', 503), ('startedPhase', 'first-detail-inference'), ('path', '/wrong')]:
            self.report = synthetic_report(); self.report['firstResultDetail']['requests'][1][key] = value
            with self.assertRaises(ValueError): self.verify()
        self.report = synthetic_report(); self.report['firstResultDetail']['requests'].pop()
        with self.assertRaises(ValueError): self.verify()
        self.report = synthetic_report(); self.report['firstResultDetail']['requests'][1] = copy.deepcopy(self.report['firstResultDetail']['requests'][0])
        with self.assertRaises(ValueError): self.verify()

    def test_missing_bad_or_unverified_native_screenshot_rejected(self):
        image = self.folder / 'quartz-first-result-detail.png'
        image.unlink()
        with self.assertRaises(FileNotFoundError): self.verify()
        image.write_bytes(b'not-a-PNG' + b'x' * 1100)
        with self.assertRaises(ValueError): self.verify()
        image.write_bytes(b'\x89PNG\r\n\x1a\n' + b'x' * 1100)
        self.report['firstResultDetail']['screenshot']['nativeWindowBefore']['passed'] = False
        with self.assertRaises(ValueError): self.verify()

    def test_source_requires_ui_result_before_detail_then_restores_old_idle_path(self):
        source = JAVA.read_text()
        main = source.split('public void offlinePackagedNativeRecognitionAndRecovery()', 1)[1]
        self.assertLess(main.index('checkFirstResultDetailBeforeLibrary()'), main.index("phase:'started'"))
        self.assertLess(main.index('scenario.recreate();'), main.index("phase:'started'"))
        helper = source.split('private JSONObject checkFirstResultDetailBeforeLibrary()', 1)[1].split('/** Checks versioned', 1)[0]
        self.assertIn('submitFixture(fixture("quartz.jpg"),"first-result-quartz.jpg")', helper)
        self.assertIn("document.getElementById('predictBtn').click()", helper)
        self.assertIn("document.getElementById('detailBtn').click()", helper)
        self.assertNotIn("[data-view=library]", helper)
        self.assertIn('assertEquals("onnx-native-android",analyzed.getString("engine"))', helper)
        self.assertIn('complete first-result references without visiting library', helper)
        self.assertIn('window.__shikuangRuntimeSmoke.firstResultDetail=', main)
        files = [JAVA, JAVA.with_name('MineralModelContractTest.java'), JAVA.with_name('ReviewedPhotoAssetsInstrumentedTest.java')]
        self.assertEqual(sum(len(re.findall(r'^\s*@Test\b', f.read_text(), re.M)) for f in files), 9)
        workflow = (ROOT / '.github/workflows/android-runtime.yml').read_text()
        self.assertIn('from android_first_detail import verify_first_result_detail', workflow)
        self.assertIn("assert first_detail['firstResultDetailBeforeLibraryVerified'] is True", workflow)
        self.assertIn('connectedDebugAndroidTest', workflow)

    def test_existing_native_assertions_and_workflow_gates_preserved_byte_for_byte(self):
        source = JAVA.read_text()
        begin = source.index('    /** Observe the real public UI call;')
        end = source.index('    /** Checks versioned public book metadata/UI only;', begin)
        source = source[:begin] + source[end:]
        prelude = '''            JSONObject firstResultDetail=checkFirstResultDetailBeforeLibrary();
            // Retain the original cold-library path and all its idle/fetch assertions.
            scenario.recreate();
            requireSupportedWebView();
            awaitPage();
            assertEquals("New Activity restores the original lazy-loader baseline","idle",evaluate("MineralReference.status"));
            firstResultDetail.put("activityRecreateRestoredIdle",true);
'''
        self.assertEqual(source.count(prelude), 1)
        source = source.replace(prelude, '')
        attachment = '            evaluate("window.__shikuangRuntimeSmoke.firstResultDetail="+firstResultDetail+";");\n'
        self.assertEqual(source.count(attachment), 1)
        source = source.replace(attachment, '')
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(),
                         'dcf82bf6e4f1bbd5bd550afd206792b599622e5492b31337c6b8435075cfa399')
        workflow = (ROOT / '.github/workflows/android-runtime.yml').read_text()
        begin = workflow.index("          import sys\n          sys.path.insert(0, 'tools')\n          from android_first_detail")
        end = workflow.index('          native = json.loads', begin)
        workflow = workflow[:begin] + workflow[end:]
        added = "          print('Verified first native result opens complete book/catalog/gallery detail before any library visit; its additional genuine screenshot is required.')\n"
        self.assertEqual(workflow.count(added), 1)
        workflow = workflow.replace(added, '')
        for added in ('          python3 -B -m unittest discover -s tools -p test_android_first_detail.py\n',
                      '          node --test tests/first-detail-instrumentation-source.test.cjs\n'):
            self.assertEqual(workflow.count(added), 1)
            workflow = workflow.replace(added, '')
        # Reviewed removal of two unused main-table diagnostic queries; strict
        # all-table offline gates and all nine instrumentation assertions remain.
        self.assertEqual(hashlib.sha256(workflow.encode()).hexdigest(),
                         '90bcdd829443f86357097ff1062486d553a3c2be326ceaa87e00be6e59a703ba')


if __name__ == '__main__':
    unittest.main()

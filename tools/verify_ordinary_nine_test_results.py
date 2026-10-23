"""CI-only finite execution-count check; never emit JUnit text or testcase details."""
from pathlib import Path
import json
import re
import stat
import xml.etree.ElementTree as ET

EXPECTED = frozenset({
    ('com.shikuang.app.MineralModelContractTest', 'realBundledManifestSelectsExactFastAndEnsembleModels'),
    ('com.shikuang.app.MineralModelContractTest', 'unsafeModelsAndChangedInputContractsAreRejected'),
    ('com.shikuang.app.MineralModelContractTest', 'littleEndianFloat32TensorRoundTripsWithoutRenormalization'),
    ('com.shikuang.app.MineralModelContractTest', 'tensorShapeCannotChangeSpatialSizeClassCountOrChannelOrder'),
    ('com.shikuang.app.MineralModelContractTest', 'everyPackagedGraphExecutesInActualNativeRuntime'),
    ('com.shikuang.app.ReviewedPhotoAssetsInstrumentedTest', 'everyReviewedPackagedPhotoHasExactBytesAndDecodesOffline'),
    ('com.shikuang.app.MineralEngineInstrumentedTest', 'explicitlyMissingCapabilityRecoveryDoesNotReplaceProductAcceptance'),
    ('com.shikuang.app.MineralEngineInstrumentedTest', 'legacyNativeAssetMigrationPreservesSpecimens'),
    ('com.shikuang.app.MineralEngineInstrumentedTest', 'offlinePackagedNativeRecognitionAndRecovery'),
})
MAX_BYTES = 4 * 1024 * 1024
MAX_FILES = 16
MAX_NODES_PER_FILE = 2048
ROOT = Path('android/app/build/outputs/androidTest-results/connected/debug')


def require(ok):
    if not ok:
        raise ValueError('ordinary_execution_not_verified')


def verify(payloads):
    """Pure bounded projection; fixture tests pass only fabricated XML bytes."""
    require(type(payloads) is list and 1 <= len(payloads) <= MAX_FILES)
    require(all(type(b) is bytes for b in payloads))
    require(0 < sum(map(len, payloads)) <= MAX_BYTES)
    seen = set()
    for raw in payloads:
        require(raw and b'\x00' not in raw and b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw)
        tree = ET.fromstring(raw)
        nodes = list(tree.iter())
        require(len(nodes) <= MAX_NODES_PER_FILE)
        require(tree.tag in ('testsuite', 'testsuites'))
        parents = {child: parent for parent in nodes for child in parent}
        for node in nodes:
            if node.tag in ('testsuite', 'testsuites'):
                require(node is tree or parents[node].tag in ('testsuite', 'testsuites'))
                if 'tests' in node.attrib:
                    require(re.fullmatch(r'[0-9]+', node.attrib['tests']) is not None)
                    require(int(node.attrib['tests']) == sum(1 for _ in node.iter('testcase')))
                for key in ('failures', 'errors', 'skipped', 'disabled'):
                    if key in node.attrib:
                        require(re.fullmatch(r'[0-9]+', node.attrib[key]) is not None)
                        require(int(node.attrib[key]) == 0)
            if node.tag != 'testcase':
                continue
            require(parents[node].tag == 'testsuite')
            key = (node.get('classname'), node.get('name'))
            require(key in EXPECTED and key not in seen)
            require(node.get('status', 'run') in ('run', 'passed'))
            require(not any(n.tag in ('failure', 'error', 'skipped') for n in node.iter()))
            seen.add(key)
    require(seen == EXPECTED)
    return {'schema': 'ordinary-nine-test-execution-v1', 'verified': True,
            'executed_tests': 9, 'expected_classes': 3, 'failed': 0, 'skipped': 0,
            'result_files': len(payloads), 'release_acceptance': False}


def main():
    try:
        require(ROOT.is_dir() and not ROOT.is_symlink())
        files = []
        for p in ROOT.rglob('*.xml'):
            require(p.is_relative_to(ROOT) and not p.is_symlink())
            s = p.lstat()
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and 0 < s.st_size <= MAX_BYTES)
            files.append(p)
            require(len(files) <= MAX_FILES)
        require(files and sum(p.stat().st_size for p in files) <= MAX_BYTES)
        payloads = []
        for p in sorted(files):
            with p.open('rb') as f:
                payloads.append(f.read(MAX_BYTES + 1))
            require(sum(map(len, payloads)) <= MAX_BYTES)
        print(json.dumps(verify(payloads), sort_keys=True))
        return 0
    except Exception:
        print('{"schema":"ordinary-nine-test-execution-v1","verified":false,"release_acceptance":false}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

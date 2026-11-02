"""Offline, bounded collection of one future diagnostic arm; no adb/CI execution.

Input archive must be the original `run-as ... tar` stdout captured by an approved
runner. No extraction API, executable payload, arbitrary member path, or product
acceptance. This tool preserves incomplete evidence instead of manufacturing pass.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

BASE = '5a004ef9e121c3039df0645b0e08e2b27decb99f'
ARMS = {'catalog-detail-only', 'native-inference-only', 'combined-first-detail'}
CLASS = 'com.shikuang.app.MemoryInfraDiagnosticTest'
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_LOG = 2 * 1024 * 1024
MAX_STAGE = 24576
EVENTS = {'before-launch', 'original-ready', 'before-journal-reload', 'reloaded-ready',
          'observer-installed', 'reference-start', 'reference-return', 'reference-error',
          'photo-start', 'analysis-start', 'analysis-return', 'analysis-error',
          'library-click', 'detail-click', 'before-library-ui', 'before-file-ui',
          'before-predict-ui', 'before-detail-ui', 'action-ready',
          'observation-sample', 'observation-complete', 'java-incomplete'}


def need(condition, message):
    if not condition:
        raise ValueError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def bounded_file(path, cap):
    need(path.is_file() and not path.is_symlink(), 'regular bounded input required')
    with path.open('rb') as stream:
        value = stream.read(cap + 1)
    need(len(value) <= cap, 'input size cap')
    return value


def contract(source, nonce, arm, pid, build_id):
    need(re.fullmatch('[a-f0-9]{40}', source) and source != BASE, 'new diagnostic source commit required')
    need(re.fullmatch('[a-f0-9]{32}', nonce) and arm in ARMS, 'exact nonce/arm')
    need(type(pid) is int and pid > 0 and re.fullmatch('[A-Za-z0-9._-]{1,80}', build_id), 'actual PID/build ID required')
    return {'source': source, 'nonce': nonce, 'arm': arm, 'pid': pid, 'build_id': build_id}


def parse_archive(raw, expected):
    need(len(raw) <= MAX_ARCHIVE, 'archive cap')
    prefix = 'memoryinfra-diagnostic-' + expected['nonce'] + '/' + expected['arm']
    files, rows, errors = {}, [], []
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        members = 0
        for member in archive:
            members += 1
            need(members <= 258, 'bounded archive member count')
            if member.isdir():
                need(member.name.rstrip('/') in (prefix, prefix.rsplit('/', 1)[0]), 'unexpected archive directory')
                continue
            need(member.isfile() and not member.issym() and not member.islnk(), 'regular stage members only')
            match = re.fullmatch(re.escape(prefix) + r'/([0-9]{3})\.json', member.name)
            need(match is not None, 'fixed private journal path only')
            sequence = int(match.group(1))
            need(sequence < 256 and sequence not in files and 0 <= member.size <= MAX_STAGE,
                 'bounded unique stage members')
            stream = archive.extractfile(member)
            need(stream is not None, 'stage bytes missing')
            value = stream.read(MAX_STAGE + 1)
            need(len(value) == member.size and len(value) <= MAX_STAGE, 'stage bytes boundary')
            files[sequence] = value
    for sequence, value in sorted(files.items()):
        try:
            row = json.loads(value, object_pairs_hook=no_duplicates)
            need(type(row) is dict and row.get('schema') == 'memoryinfra-stage-v1', 'stage schema')
            for key, wanted in [('sequence', sequence), ('nonce', expected['nonce']), ('arm', expected['arm']),
                                ('sourceCommit', expected['source']), ('baseAppSource', BASE),
                                ('pid', expected['pid']), ('buildId', expected['build_id'])]:
                need(row.get(key) == wanted, 'stage binding differs: ' + key)
            need(row.get('event') in EVENTS and type(row.get('payload')) is dict, 'bounded stage event')
            need(type(row.get('elapsedRealtimeNanos')) is int and row['elapsedRealtimeNanos'] > 0, 'monotonic timestamp')
            for key in ('nativeHeapAllocated', 'nativeHeapSize', 'nativeHeapFree', 'javaHeapUsed', 'rssKiB'):
                need(type(row.get(key)) is int and row[key] >= 0, 'actual memory field: ' + key)
            rows.append(row)
        except (ValueError, TypeError, RecursionError) as error:
            errors.append({'sequence': sequence, 'reason': str(error)[:512], 'sha256': hashlib.sha256(value).hexdigest()})
    need(sorted(files) == list(range(len(files))), 'non-contiguous write-once stage names')
    return files, rows, errors


def instrumentation_pass(raw):
    text = raw.decode('utf-8', 'replace')
    lines = set(text.splitlines())
    return (len(raw) <= MAX_LOG and 'INSTRUMENTATION_CODE: -1' in lines
            and bool(re.search(r'OK \(1 test\)', text))
            and bool(re.search(r'INSTRUMENTATION_STATUS: numtests=1(?:\r?\n|$)', text))
            and 'INSTRUMENTATION_STATUS: class=' + CLASS in lines
            and 'INSTRUMENTATION_STATUS: test=observeArm' in lines
            and not re.search(r'FAILURES!!!|Process crashed|INSTRUMENTATION_FAILED|shortMsg=|AssertionFailed|AssertionError', text))


def valid_snapshot(arm, value):
    if type(value) is not dict or value.get('online') is not False or value.get('photoRequests') != 0:
        return False
    refs = value.get('requests')
    if type(refs) is not list:
        return False
    if arm == 'catalog-detail-only':
        if not (value.get('analysisCalls') == 0 and value.get('analysis') is None
                and value.get('libraryClicks') == 1 and value.get('libraryHidden') is False):
            return False
    else:
        a = value.get('analysis')
        if not (value.get('analysisCalls') == 1 and value.get('analysisError') is None
                and type(a) is dict and a.get('key') == 'quartz' and a.get('engine') == 'onnx-native-android'
                and a.get('modelCount') == 3 and a.get('modelVersion') == 'inherited-2.0-audited'
                and a.get('manifestSha256') == 'ddbe27e79489df0ff63647b37c17f701e458a59e076df14d47d93873085ae7fa'
                and type(a.get('elapsedMs')) is int and a['elapsedMs'] > 0
                and value.get('resultVisible') is True and value.get('predictEnabled') is True
                and value.get('libraryClicks') == 0 and value.get('libraryHidden') is True):
            return False
    if arm == 'native-inference-only':
        return (value.get('loader') == 'idle' and not refs and value.get('dialogOpen') is False
                and value.get('referenceResources') == 0)
    paths = {'/data/reference-manifest.json', '/data/catalog.json', '/data/crystals.json', '/data/image-sources.json'}
    return (len(refs) == 4 and all(type(r) is dict and r.get('local') is True and r.get('status') == 200 for r in refs)
            and {r.get('path') for r in refs} == paths and value.get('loader') == 'ready'
            and value.get('dialogOpen') is True and value.get('title') == '石英'
            and value.get('hasOfficialFields') is True and value.get('loadingMessage') is False
            and value.get('bookSections') == 3 and value.get('totalBookStatements') == 190
            and value.get('books') == 11 and value.get('primarySpecies') == 6239
            and value.get('galleryPresent') is True and value.get('galleryClosed') is True)


def assess(rows, errors, instrument_raw):
    reasons = []
    events = [r['event'] for r in rows]
    for event in ('original-ready', 'before-journal-reload', 'reloaded-ready', 'observer-installed', 'action-ready', 'observation-complete'):
        if events.count(event) != 1:
            reasons.append('missing/duplicate ' + event)
    if rows:
        arm = rows[0]['arm']
        if any(not valid_snapshot(arm, r['payload']) for r in rows
               if r['event'] in ('action-ready', 'observation-sample', 'observation-complete')):
            reasons.append('actual arm UI/native/reference snapshot differs')
        wanted_analyses = 0 if arm == 'catalog-detail-only' else 1
        wanted_refs = 0 if arm == 'native-inference-only' else 4
        if events.count('analysis-start') != wanted_analyses or events.count('analysis-return') != wanted_analyses:
            reasons.append('actual analysis start/return event count differs')
        if wanted_analyses == 1 and events.count('analysis-return') == 1:
            actual = rows[events.index('analysis-return')]['payload']
            if any(r['payload'].get('analysis') != actual for r in rows
                   if r['event'] in ('action-ready', 'observation-sample', 'observation-complete')):
                reasons.append('native return identity differs from observed UI snapshots')
        starts = [r['payload'] for r in rows if r['event'] == 'reference-start']
        returns = [r['payload'] for r in rows if r['event'] == 'reference-return']
        if not (len(starts) == len(returns) == wanted_refs
                and all(r.get('local') is True for r in starts + returns)
                and all(r.get('status') == 200 for r in returns)
                and sorted(r.get('path', '') for r in starts) == sorted(r.get('path', '') for r in returns)
                and len({r.get('path') for r in starts}) == wanted_refs
                and (wanted_refs == 0 or {r.get('path') for r in starts} ==
                     {'/data/reference-manifest.json', '/data/catalog.json', '/data/crystals.json', '/data/image-sources.json'})):
            reasons.append('actual local reference start/200-return event count differs')
    if errors:
        reasons.append('malformed or incorrectly bound persisted stage')
    if not instrumentation_pass(instrument_raw):
        reasons.append('exact one-method instrumentation success not established')
    if 'java-incomplete' in events or 'analysis-error' in events or 'reference-error' in events:
        reasons.append('incomplete/error event present')
    if any(a['elapsedRealtimeNanos'] > b['elapsedRealtimeNanos'] for a, b in zip(rows, rows[1:])):
        reasons.append('monotonic stage order drift')
    if all(event in events for event in ('original-ready', 'before-journal-reload', 'reloaded-ready', 'observer-installed', 'action-ready', 'observation-complete')):
        order = [events.index(e) for e in ('original-ready', 'before-journal-reload', 'reloaded-ready', 'observer-installed', 'action-ready', 'observation-complete')]
        if order != sorted(order):
            reasons.append('readiness ordering differs')
        original = rows[events.index('original-ready')]['payload']
        if not (original.get('sdk') == 35 and original.get('pageSize') == 16384
                and original.get('providerPackage') == 'com.google.android.webview'
                and original.get('providerVersion') == '124.0.6367.219'
                and original.get('providerVersionCode') == 636771938
                and original.get('reloadCount') == 0 and original.get('loader') == 'idle'
                and original.get('activeNetwork') is None and original.get('connected') is False):
            reasons.append('stock 35/16K/provider/original idle/offline identity not proven')
        reloaded = rows[events.index('reloaded-ready')]['payload']
        complete = rows[events.index('observation-complete')]['payload']
        if not (reloaded.get('reloadCount') == complete.get('reloadCount') == 1
                and complete.get('requestedObservationMs') == 30000
                and type(complete.get('observationElapsedMs')) is int and complete['observationElapsedMs'] >= 30000
                and complete.get('productAcceptance') is False):
            reasons.append('exact one reload / ready-based 30s observation not proven')
        samples = [r for r in rows if r['event'] == 'observation-sample']
        if len(samples) < 14 or complete.get('samples') != len(samples):
            reasons.append('2s sampling coverage incomplete')
        if rows[events.index('observation-complete')]['elapsedRealtimeNanos'] - rows[events.index('action-ready')]['elapsedRealtimeNanos'] < 30_000_000_000:
            reasons.append('persisted elapsed duration below 30s')
    return {'diagnostic_observation_complete': not reasons, 'status': 'observed' if not reasons else 'partial_or_failed',
            'reasons': reasons, 'product_acceptance': False, 'root_cause_proven': False}


def collect(archive_path, instrument_path, out, expected):
    raw = bounded_file(archive_path, MAX_ARCHIVE)
    instrument_raw = bounded_file(instrument_path, MAX_LOG)
    files, rows, errors = parse_archive(raw, expected)
    out.mkdir(parents=True, exist_ok=False)
    for name, value in [('original-journal.tar', raw), ('original-instrumentation.txt', instrument_raw)]:
        with (out / name).open('xb') as stream:
            stream.write(value)
    stages = out / 'stages'; stages.mkdir()
    for sequence, value in sorted(files.items()):
        with (stages / ('%03d.json' % sequence)).open('xb') as stream:
            stream.write(value)
    report = {'schema': 'memoryinfra-diagnostic-collection-v1', **expected,
              **assess(rows, errors, instrument_raw), 'stage_count': len(rows), 'invalid_stages': errors,
              'inputs': [{'name': 'original-journal.tar', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()},
                         {'name': 'original-instrumentation.txt', 'bytes': len(instrument_raw), 'sha256': hashlib.sha256(instrument_raw).hexdigest()}],
              'stage_bytes_not_product_quality': True,
              'limitations': ['test-only bridge, uniform reload, synchronous writes and polling alter timing',
                              'one observation per arm cannot establish causality',
                              'does not run or substitute ordinary nine-test four-profile matrix']}
    with (out / 'collection.json').open('x') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2); stream.write('\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--journal-tar', type=Path, required=True)
    parser.add_argument('--instrumentation-output', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--source', required=True); parser.add_argument('--nonce', required=True)
    parser.add_argument('--arm', choices=sorted(ARMS), required=True)
    parser.add_argument('--pid', type=int, required=True); parser.add_argument('--build-id', required=True)
    args = parser.parse_args()
    report = collect(args.journal_tar, args.instrumentation_output, args.out,
                     contract(args.source, args.nonce, args.arm, args.pid, args.build_id))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['diagnostic_observation_complete'] else 2


if __name__ == '__main__':
    raise SystemExit(main())

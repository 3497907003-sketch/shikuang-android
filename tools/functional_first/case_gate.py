"""Offline byte/structure gate for the original native lifecycle case evidence.

Does not run devices. Coherent synthetic files are not genuine device evidence;
trusted CI provenance and root review remain independent, mandatory gates.
"""
import hashlib
import json
from pathlib import Path
import stat
import struct
import zlib
from protocol import CASES, PHASES


class GateError(ValueError):
    pass


def need(condition, code):
    if not condition:
        raise GateError(code)


def read_regular(folder, name, cap):
    need(isinstance(name, str) and '/' not in name and '\\' not in name and name not in ('.', '..'), 'unsafe_filename')
    path = Path(folder) / name
    try:
        st = path.lstat()
        need(stat.S_ISREG(st.st_mode) and not path.is_symlink(), 'not_regular')
        need(st.st_size <= cap, 'file_cap')
        raw = path.read_bytes()
        need(len(raw) == st.st_size, 'file_changed')
        return raw
    except OSError:
        raise GateError('file_unavailable') from None


def load_object(folder, name):
    try:
        obj = json.loads(read_regular(folder, name, 2 * 1024 * 1024))
    except (ValueError, UnicodeError):
        raise GateError('invalid_json') from None
    need(isinstance(obj, dict), 'object_required')
    return obj


def check_png(raw):
    need(raw.startswith(b'\x89PNG\r\n\x1a\n'), 'png_signature')
    offset, types, compressed, dims = 8, [], bytearray(), None
    while offset < len(raw):
        need(offset + 12 <= len(raw), 'png_truncated')
        size, = struct.unpack('>I', raw[offset:offset + 4])
        kind = raw[offset + 4:offset + 8]
        need(offset + 12 + size <= len(raw), 'png_truncated')
        data = raw[offset + 8:offset + 8 + size]
        crc, = struct.unpack('>I', raw[offset + 8 + size:offset + 12 + size])
        need(zlib.crc32(kind + data) & 0xffffffff == crc, 'png_crc')
        types.append(kind)
        if kind == b'IHDR':
            need(types == [b'IHDR'] and size == 13, 'png_ihdr')
            w, h, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data)
            need(160 <= w <= 4096 and 160 <= h <= 4096 and depth == 8 and color in (2, 6), 'png_dimensions_or_format')
            need((compression, filtering, interlace) == (0, 0, 0), 'png_encoding')
            dims = (w, h, 3 if color == 2 else 4)
        elif kind == b'IDAT':
            compressed.extend(data)
        elif kind == b'IEND':
            need(size == 0 and offset + 12 == len(raw), 'png_iend')
        offset += size + 12
    need(dims is not None and types[-1:] == [b'IEND'] and b'IDAT' in types, 'png_chunks')
    w, h, channels = dims
    expected = h * (1 + w * channels)
    try:
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(compressed, expected + 1)
        need(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, 'png_stream')
        need(len(decoded) == expected, 'png_decoded_length')
        stride = 1 + w * channels
        need(all(decoded[row * stride] <= 4 for row in range(h)), 'png_scanline_filter')
    except zlib.error:
        raise GateError('png_zlib') from None
    return {'width': w, 'height': h, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
            'scope': 'complete PNG byte structure, not visual correctness or provenance'}


def validate_case(folder, case, sdk, instrumentation_dir):
    need(case in CASES and type(sdk) is int and sdk in (35, 36), 'expected_case_sdk')
    contract = CASES[case]
    prefix = contract['prefix']
    receipt = load_object(instrumentation_dir, 'receipt.json')
    need(receipt.get('success') is True and type(receipt.get('return_code')) is int and receipt['return_code'] == 0 and receipt.get('status') == 'success' and receipt.get('timed_out') is False, 'instrumentation_command_not_success')
    stream_metadata = receipt.get('streams')
    need(isinstance(stream_metadata, dict), 'instrumentation_streams_object')
    from terminal import verify_command_terminal
    verify_command_terminal(instrumentation_dir, receipt, GateError)
    report = load_object(folder, prefix + '-report.json')
    need(report.get('phase') == 'passed' and type(report.get('sdk')) is int and report['sdk'] == sdk, 'report_phase_sdk')
    need(type(report.get('pageSize')) is int and report['pageSize'] == 16384 and report.get('deviceAbi') == 'x86_64', 'report_page_abi')
    need(report.get('packageName') == contract['package'] and report.get('activeNetworkBefore') is None and report.get('activeNetworkAfter') is None and 'activeNetworkBefore' in report and 'activeNetworkAfter' in report, 'report_package_network')
    need(report.get('sentinelRemoved') is True and all(report.get(key) is False for key in ('productionAccuracyClaim', 'unsavedDraftPersistenceClaim', 'coldProcessRestartClaim', 'physicalImeSuggestionSelectionClaim')), 'report_sentinel_scope')
    cycles = report.get('cycles')
    events = report.get('events')
    need(isinstance(cycles, list) and len(cycles) == 12 and all(isinstance(row, dict) for row in cycles), 'cycles_shape')
    need(all(type(row.get('cycle')) is int for row in cycles) and sorted(row['cycle'] for row in cycles) == list(range(12)), 'cycle_ids')
    for row in cycles:
        need(all(row.get(key) is True for key in ('backgroundForegroundVerified', 'recreateVerified', 'storedRecordPreserved', 'closedWithoutObservedCrash')), 'cycle_lifecycle')
        need(row.get('nativeComposingAndVisibleImeVerified') is (row['cycle'] % 4 != 0), 'cycle_native_pattern')
    need(report.get('nativeInputCycles') == 9 and report.get('fallbackNoEditCycles') == 3, 'native_cycle_counts')
    need(isinstance(events, list) and all(isinstance(row, dict) and type(row.get('cycle')) is int and isinstance(row.get('action'), str) for row in events), 'events_shape')
    # The old gate counts 27 suffixes; additionally bind every cycle/phase pair.
    for suffix in ('/native-touch-after', '/ime-visible', '/chinese-dom-verified'):
        found = [(row['cycle'], row['action'][:-len(suffix)]) for row in events if row['action'].endswith(suffix)]
        expected = [(cycle, phase) for cycle in range(12) if cycle % 4 != 0 for phase in PHASES]
        need(len(found) == 27 and sorted(found) == sorted(expected), 'events_distinct_cycle_phase')
    files = []
    for cycle in range(12):
        if cycle % 4 == 0:
            continue
        for phase in PHASES:
            name = f'{prefix}-connection-result-{cycle}-{phase}.json'
            connection = load_object(folder, name)
            need(type(connection.get('cycle')) is int and connection['cycle'] == cycle and connection.get('composePhase') == phase, 'connection_cycle_phase')
            need(connection.get('nativeCompositionReturned') is True and 'failure' not in connection, 'connection_failed')
            need(type(connection.get('actualCallThreadId')) is int and type(connection.get('handlerThreadId')) is int and connection['actualCallThreadId'] == connection['handlerThreadId'], 'connection_handler_id')
            need(isinstance(connection.get('actualCallThreadName'), str) and connection['actualCallThreadName'] and connection['actualCallThreadName'] == connection.get('handlerThreadName'), 'connection_handler_name')
            files.append(name)
    pngs = []
    visibility = {}
    for view, selector, cycle in [('identify', '#notes', 1), ('library', '#librarySearch', 2), ('records', '#recordSearch', 3)]:
        for state in ('composing', 'ime-visible'):
            stem = f'{prefix}-{view}-{state}'
            evidence = load_object(folder, stem + '.json')
            dom = evidence.get('dom')
            need(isinstance(dom, dict), 'evidence_dom')
            need(all(evidence.get(key) is True for key in ('visualFrameObserved', 'imeVisible', 'windowFocus', 'nativeViewFocus')) and dom.get('active') is True and evidence.get('selector') == selector, 'evidence_focus_ime_draw')
            if state == 'composing':
                need(dom.get('value') == f'quartz-实验室-{cycle}', 'evidence_chinese_dom')
            pngs.append({'file': stem + '.png', **check_png(read_regular(folder, stem + '.png', 16 * 1024 * 1024))})
            files.append(stem + '.json')
            visibility[stem] = dom.get('inputFullyUnobscured') is True
    return {'schema': 'case-structure-result-v1', 'case': case, 'sdk': sdk,
        'status': 'structure_pass', 'completed_cycles': 12, 'native_cycles': 9,
        'native_composition_calls': 27, 'pngs': pngs, 'jsons_checked': files,
        'all_observed_inputs_unobscured': all(visibility.values()), 'visibility': visibility,
        'provenance_checked_here': False, 'genuine_device_claim': False,
        'requires_bound_trusted_ci_originals': True, 'requires_root_actual_visual_review': True,
        'physical_keyboard_suggestion_selection_claim': False,
        'production_stability_accepted': False, 'root_cause_fixed': False}

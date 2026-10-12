"""A bounded, immutable command receipt. No ADB, emulator or CI CLI is provided.

The caller must explicitly choose a command and a fresh output directory. This
module's real executions in this proposal are synthetic local Python processes.
No shell interpretation, env dump, command retry, or global fail-fast behavior.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time


def _write_json(path, data):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def _kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def capture(argv, output_dir, *, timeout_seconds, max_stream_bytes=16 * 1024 * 1024):
    if not isinstance(argv, list) or not argv or any(not isinstance(v, str) or '\0' in v for v in argv):
        raise ValueError('argv must be a nonempty string array')
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 960:
        raise ValueError('bounded timeout required')
    if isinstance(max_stream_bytes, bool) or not isinstance(max_stream_bytes, int) or not 0 < max_stream_bytes <= 64 * 1024 * 1024:
        raise ValueError('bounded stream limit required')
    output_dir = Path(output_dir)
    # A caller-owned fresh leaf; no overwrite of any existing evidence directory.
    output_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    started_utc = datetime.now(timezone.utc).isoformat()
    started_ns = time.monotonic_ns()
    started = {'schema': 'bounded-command-receipt-v1', 'argv': argv,
        'started_at_utc': started_utc, 'started_monotonic_ns': started_ns,
        'timeout_seconds': timeout_seconds, 'max_stream_bytes': max_stream_bytes,
        'status': 'started', 'shell': False, 'retry_count': 0}
    _write_json(output_dir / 'started.json', started)
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    truncated = {'stdout': False, 'stderr': False}
    reason = None
    error_type = None
    return_code = None
    process = None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
            start_new_session=True, close_fds=True)
        deadline = time.monotonic() + timeout_seconds
        selector = selectors.DefaultSelector()
        for name, stream in [('stdout', process.stdout), ('stderr', process.stderr)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        drain_deadline = None
        try:
            while selector.get_map():
                now = time.monotonic()
                if reason is None and now >= deadline:
                    reason = 'timeout'
                    _kill_group(process)  # also handles descendants holding open pipes
                    drain_deadline = now + 0.2
                if drain_deadline is not None and now >= drain_deadline:
                    break
                for key, _ in selector.select(0.01):
                    try:
                        chunk = os.read(key.fileobj.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    name = key.data
                    totals[name] += len(chunk)
                    remaining = max_stream_bytes - len(buffers[name])
                    buffers[name].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        truncated[name] = True
                        if reason is None:
                            reason = 'output_limit'
                            _kill_group(process)
                            drain_deadline = now + 0.2
            remaining_time = max(0.001, deadline - time.monotonic())
            try:
                return_code = process.wait(timeout=min(remaining_time, 0.2) if reason else remaining_time)
            except subprocess.TimeoutExpired:
                reason = reason or 'timeout'
                _kill_group(process)
                return_code = process.wait(timeout=1)
        finally:
            for key in list(selector.get_map().values()):
                key.fileobj.close()
            selector.close()
    except OSError as error:
        reason = 'spawn_error'
        error_type = type(error).__name__  # no uncontrolled exception text or env
    finally:
        if process is not None and process.poll() is None:
            _kill_group(process)
            process.wait(timeout=1)
        if process is not None:
            for stream in (process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
    streams = {}
    for name, raw in buffers.items():
        file = output_dir / (name + '.bin')
        with file.open('xb') as stream:
            stream.write(raw)
        streams[name] = {'file': file.name, 'bytes_retained': len(raw),
            'bytes_read': totals[name], 'sha256': hashlib.sha256(raw).hexdigest(),
            'truncated': truncated[name]}
    final = {**started, 'finished_at_utc': datetime.now(timezone.utc).isoformat(),
        'elapsed_seconds': (time.monotonic_ns() - started_ns) / 1e9,
        'host_pid': process.pid if process is not None else None,
        'host_process_reaped': process is not None and process.poll() is not None,
        'guest_termination_confirmed': False,
        'status': reason or ('success' if return_code == 0 else 'command_failed'),
        'return_code': return_code, 'timed_out': reason == 'timeout',
        'error_type': error_type, 'streams': streams,
        'success': reason is None and return_code == 0 and not any(truncated.values())}
    _write_json(output_dir / 'receipt.json', final)
    return final


def not_attempted(output_dir, reason):
    if reason not in ('transport_unavailable', 'guest_unhealthy', 'identity_unverified',
                      'prior_authorization_missing', 'budget_exhausted'):
        raise ValueError('fixed not-attempted reason required')
    output_dir = Path(output_dir)
    output_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    receipt = {'schema': 'bounded-command-receipt-v1', 'status': 'not_attempted',
        'reason': reason, 'success': False, 'return_code': None,
        'started_at_utc': None, 'elapsed_seconds': None, 'streams': {},
        'retry_count': 0}
    _write_json(output_dir / 'receipt.json', receipt)
    return receipt

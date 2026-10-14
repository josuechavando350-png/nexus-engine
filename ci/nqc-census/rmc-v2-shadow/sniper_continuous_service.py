#!/usr/bin/env python3
"""Single-writer, daily-journal supervisor. Read-only; deployment is a separate fact."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import tempfile
import time

import sniper_readonly_journal as j
import sniper_readonly_observer as obs

SAMPLE_TIMEOUT = 180
MIN_FREE_BYTES = 1024**3
MAX_DAILY_SAMPLES = 2000
GOOD = 'DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2'


class SampleDeadline(BaseException):
    """Must escape the observer's per-provider Exception handlers."""


@contextmanager
def writer_lock(root):
    j.need(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'real absolute state directory required')
    fd = os.open(root/'writer.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise j.JournalError('another observer owns the state directory') from exc
        yield
    finally:
        os.close(fd)


def bounded_observe(providers):
    def expired(_signum, _frame):
        raise SampleDeadline()
    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, SAMPLE_TIMEOUT)
    try:
        return obs.observe(providers)
    except SampleDeadline as exc:
        raise TimeoutError('whole observation deadline exceeded') from exc
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def atomic_pointer(root, document):
    fd, filename = tempfile.mkstemp(prefix='.health-', dir=root)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(j.canonical(document)); stream.flush(); os.fsync(stream.fileno())
        os.replace(filename, root/'health.json')
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def cycle(root, source_commit, providers, *, now=None, observer=bounded_observe, free_bytes=None):
    epoch = int(time.time()) if now is None else now
    available = shutil.disk_usage(root).free if free_bytes is None else free_bytes
    j.need(available >= MIN_FREE_BYTES, 'less than 1 GiB free; preserve evidence and stop')
    day = datetime.fromtimestamp(epoch, timezone.utc).strftime('%Y-%m-%d')
    folder = root/day
    folder.mkdir(mode=0o700, exist_ok=True)
    j.need(not folder.is_symlink(), 'daily journal symlink prohibited')
    journal = folder/'journal.jsonl'
    j.need(not journal.is_symlink(), 'journal symlink prohibited')
    entries, _ = j.audit(journal.read_bytes() if journal.exists() else b'', folder)
    j.need(len(entries) < MAX_DAILY_SAMPLES, 'daily sample budget exhausted')
    try:
        report = observer(tuple(providers))
    except Exception as exc:
        report = obs.unavailable_report(epoch, [{'error_type': type(exc).__name__,
                                                'error': str(exc)[:200]}], 'SUPERVISOR_SAMPLE_FAILED')
    entry = j.append_snapshot(folder, report)
    health = {'schema_version': 1, 'source_commit': source_commit,
              'journal_day_utc': day, 'sequence': entry['sequence'],
              'snapshot_file': entry['snapshot_file'], 'snapshot_sha256': entry['snapshot_sha256'],
              'entry_sha256': j.digest(j.canonical(entry)),
              'last_completed_epoch': int(time.time()) if now is None else now,
              'sample_status': entry['snapshot_status'],
              'server_24_7_uptime_certified': False, 'nqc_realized_pnl_usd': '0'}
    atomic_pointer(root, health)
    print(json.dumps(health, sort_keys=True), flush=True)
    return health


def health_check(root, *, now=None, max_age=240):
    epoch = int(time.time()) if now is None else now
    j.need(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'real absolute state directory required')
    path = root/'health.json'
    j.need(path.is_file() and not path.is_symlink(), 'health pointer missing or symlink')
    current = j.parse_line(path.read_bytes())
    day = current.get('journal_day_utc', '')
    j.need(type(day) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}', day), 'unsafe journal day')
    folder = root/day
    j.need(folder.is_dir() and not folder.is_symlink(), 'daily directory missing or symlink')
    journal = folder/'journal.jsonl'
    j.need(journal.is_file() and not journal.is_symlink(), 'daily journal missing or symlink')
    entries, digest = j.audit(journal.read_bytes(), folder)
    j.need(bool(entries) and digest == current['entry_sha256'], 'health pointer not at verified journal tip')
    last = entries[-1]
    for key in ('sequence', 'snapshot_file', 'snapshot_sha256'):
        j.need(last[key] == current[key], 'health pointer identity mismatch')
    sample = j.parse_line((folder/last['snapshot_file']).read_bytes())
    finished = current.get('last_completed_epoch')
    observed = sample.get('observed_epoch_seconds')
    j.need(type(finished) is int and 0 <= epoch-finished <= max_age, 'service heartbeat stale/future')
    j.need(type(observed) is int and 0 <= epoch-observed <= max_age, 'observation stale/future')
    j.need(sample['status'] == GOOD and sample.get('provider_count', 0) >= 2,
           'process ran but observation lacks two-endpoint agreement')
    j.need(sample.get('accounts_consistent_across_successful_endpoints') is True,
           'account parity not established')
    block_epoch = sample.get('pinned_block', {}).get('timestamp')
    j.need(type(block_epoch) is int and 0 <= epoch-block_epoch <= max_age, 'observed block stale/future')
    return {'status': 'FRESH_VERIFIED_SAMPLE_NOT_UPTIME_CERTIFICATION',
            'journal_day_utc': day, 'sequence': last['sequence'],
            'observed_epoch_seconds': observed, 'pinned_block': sample['pinned_block'],
            'providers': sample['successful_provider_ids'],
            'hf_below_one_count': sample['hf_below_one_state_count_not_execution_admission'],
            'nqc_realized_pnl_usd': '0', 'server_24_7_uptime_certified': False}


def run(root, source_commit, providers, interval=60, max_cycles=0):
    j.need(type(interval) is int and interval >= 60, 'minimum interval 60 seconds')
    j.need(type(max_cycles) is int and max_cycles >= 0, 'invalid max cycles')
    j.need(re.fullmatch(r'[0-9a-f]{40}', source_commit) is not None, 'exact source commit required')
    j.need(len(providers) == 3 and set(providers) == {'drpc', 'publicnode', 'blast'}, 'three source selection required')
    with writer_lock(root):
        cycles = 0
        while max_cycles == 0 or cycles < max_cycles:
            started = time.monotonic()
            cycle(root, source_commit, providers)
            cycles += 1
            if max_cycles and cycles >= max_cycles:
                break
            time.sleep(max(0, interval-(time.monotonic()-started)))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out-dir', required=True, type=Path)
    p.add_argument('--source-commit', default=os.environ.get('NQC_SOURCE_COMMIT', ''))
    p.add_argument('--interval-seconds', type=int, default=60)
    p.add_argument('--max-cycles', type=int, default=0)
    p.add_argument('--health', action='store_true')
    a = p.parse_args()
    try:
        if a.health:
            print(json.dumps(health_check(a.out_dir), sort_keys=True))
        else:
            run(a.out_dir, a.source_commit, ('drpc', 'publicnode', 'blast'),
                a.interval_seconds, a.max_cycles)
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({'status': 'BLOCKED_OR_UNHEALTHY', 'reason': str(exc)[:200]}), flush=True)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

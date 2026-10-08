#!/usr/bin/env python3
"""Execute authenticated D06 replay inside a fresh disconnected Linux namespace.

This produces verification evidence, never a canonical CI claim. The successful
exact-head workflow, final run metadata and immutable artifact establish that.
"""
import argparse
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import struct
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(command, log=None, cwd=None, expected=0):
    result = subprocess.run([str(x) for x in command], cwd=cwd, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if log:
        Path(log).write_text(result.stdout)
    require((result.returncode == 0) if expected == 0 else (result.returncode != 0),
            f"unexpected exit {result.returncode}: {command[0]}\n{result.stdout[-3000:]}")
    return result.stdout


def bytes_snapshot(root):
    values = {}
    for path in sorted(root.rglob('*')):
        mode = path.lstat().st_mode
        require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), f"non-regular source entry: {path}")
        if stat.S_ISREG(mode):
            values[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return values


def network_proof(parent_namespace):
    current = os.readlink('/proc/self/ns/net')
    require(current != parent_namespace, 'network namespace was not disconnected')
    # A fresh network namespace has only the down loopback interface, no route.
    interfaces = [line.split(':', 1)[0].strip() for line in Path('/proc/net/dev').read_text().splitlines() if ':' in line]
    require(interfaces == ['lo'], 'unexpected network interface')
    require(not Path('/proc/net/if_inet6').read_text().strip(), 'unexpected IPv6 address')
    routes = Path('/proc/net/route').read_text().splitlines()
    require(len(routes) <= 1, 'IPv4 routes remain reachable')
    ipv6_routes = Path('/proc/net/ipv6_route').read_text().splitlines()
    for row in ipv6_routes:
        fields = row.split()
        require(len(fields) == 10 and fields[9] == 'lo' and int(fields[8], 16) & 0x200,
                'IPv6 has a non-reject route')
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as interface:
        flags = fcntl.ioctl(interface, 0x8913, struct.pack('16sH14x', b'lo', 0))
        require(not struct.unpack('16sH14x', flags)[1] & 1, 'loopback is unexpectedly up')
        try:
            fcntl.ioctl(interface, 0x8915, struct.pack('16s16x', b'lo'))
        except OSError as error:
            require(error.errno == errno.EADDRNOTAVAIL, 'IPv4 address absence not established')
        else:
            raise ValueError('unexpected IPv4 address')
    try:
        ipv6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    except OSError as error:
        require(error.errno == errno.EAFNOSUPPORT, 'IPv6 availability not established')
    else:
        with ipv6:
            ipv6.settimeout(1)
            try:
                ipv6.connect(('2606:4700:4700::1111', 443))
            except OSError as error:
                require(error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL),
                        'IPv6 connection failed without proving unreachable network')
            else:
                raise ValueError('IPv6 network unexpectedly reachable')
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(('1.1.1.1', 443))
        except OSError as error:
            require(error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH),
                    'connection failed without proving unreachable network')
        else:
            raise ValueError('network unexpectedly reachable')
    return {'parent_network_namespace': parent_namespace, 'network_namespace': current,
            'interfaces': ['lo'], 'routable_network': False}


def verification_times(started_at, completed_at, observation_timestamp):
    """New verification time is independent of immutable observation time."""
    require(started_at.tzinfo is timezone.utc and completed_at.tzinfo is timezone.utc,
            'verification clock must be explicit UTC')
    require(completed_at >= started_at, 'verification clock moved backwards')
    require(isinstance(observation_timestamp, int) and not isinstance(observation_timestamp, bool),
            'source observation timestamp must be integer seconds')
    observation = datetime.fromtimestamp(observation_timestamp, timezone.utc)
    require(observation <= started_at, 'source observation cannot postdate verification')
    return {
        'verification_started_at': started_at.isoformat(timespec='microseconds').replace('+00:00', 'Z'),
        'verification_completed_at': completed_at.isoformat(timespec='microseconds').replace('+00:00', 'Z'),
        'verification_time_basis': 'NEW_VERIFICATION_SYSTEM_UTC_CLOCK',
        'original_observation_at': observation.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'original_observation_time_basis': 'ORIGINAL_SOURCE_ANCHOR_BLOCK_TIMESTAMP',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--parent-network-namespace', required=True)
    args = parser.parse_args()
    started_at = datetime.now(timezone.utc)
    source, out, repo = args.source.resolve(), args.out.resolve(), args.repo.resolve()
    require(source.is_dir() and not out.exists(), 'source must exist and output must be new')
    require(not out.is_relative_to(source), 'output cannot mutate authenticated source')
    proof = network_proof(args.parent_network_namespace)
    # Read-only bind mount enforces source preservation even during error paths.
    run(['mount', '--bind', source, source])
    run(['mount', '-o', 'remount,bind,ro', source])
    require(os.statvfs(source).f_flag & os.ST_RDONLY, 'source mount is not read-only')
    before = bytes_snapshot(source)
    out.mkdir(parents=True)
    (out/'network-isolation.json').write_text(json.dumps(proof, sort_keys=True, indent=2)+'\n')
    pin = json.loads((repo/'ci/nqc-census/rmc006-recertification-source.json').read_text())
    # Require the entire extracted package's exact identity before invoking Rust.
    index_bytes = (source/'evidence-index.json').read_bytes()
    require(hashlib.sha256(index_bytes).hexdigest() == pin['index']['sha256'], 'source index changed')
    index = json.loads(index_bytes)
    require(set(before) == {'evidence-index.json'} | {x['path'] for x in index['files']}, 'source membership changed')
    for entry in index['files']:
        path = source/entry['path']
        require(before[entry['path']] == entry['sha256'] and path.stat().st_size == entry['size'], 'source member changed')
    head = run(['git', '-c', 'safe.directory='+str(repo), 'rev-parse', 'HEAD'], cwd=repo).strip()
    tree = run(['git', '-c', 'safe.directory='+str(repo), 'show', '-s', '--format=%T', 'HEAD'], cwd=repo).strip()
    require(re.fullmatch('[0-9a-f]{40}', head) and re.fullmatch('[0-9a-f]{40}', tree), 'invalid checkout identity')
    require(not run(['git', '-c', 'safe.directory='+str(repo), 'status', '--porcelain', '--untracked-files=no'], cwd=repo).strip(), 'dirty tracked source checkout')
    require(head != pin['run']['head_sha'], 'recertification must have a new producer identity')
    binary = repo/'nqc-census/target/release'
    store = source/'store'
    root = pin['store_evidence_root']
    verifier = repo/'ci/nqc-census/verify_store_independent.py'
    for label, target in [('source', store)]:
        checked = run([binary/'nqc-census-store-verify', '--store', target], out/f'{label}-store-rust.log')
        require(f'evidence_root={root}' in checked and 'RMC_004_OFFLINE_VERIFY=PASS' in checked, 'source store root mismatch')
        run([sys.executable, verifier, '--store', target, '--expect-root', root], out/f'{label}-store-python.log')
    anchor = ['--anchor-number', str(pin['anchor']['number']), '--anchor-hash', pin['anchor']['hash']]
    current = ['--providers', repo/'ci/nqc-census/rpc-providers.json', '--current', source/'aave-current-surface.json', '--store', store, *anchor]
    for label in ['current', 'current-rerun']:
        run([binary/'nqc-rmc006-aave-current-replay', *current, '--out', out/f'{label}.json'], out/f'{label}.log')
        require((out/f'{label}.json').read_bytes() == (source/'aave-current-surface.json').read_bytes(), 'current replay differs')
    run([binary/'nqc-rmc006-aave-resume-check', '--providers', repo/'ci/nqc-census/aave-history-providers.json',
         '--current', source/'aave-current-surface.json', '--history', source/'aave-history.json',
         '--store', store, '--work', out/'resume-work', '--out', out/'aave-resume-equivalence.json', *anchor], out/'resume.log')
    resume = json.loads((out/'aave-resume-equivalence.json').read_text())
    require(resume == pin['resume'], 'history crash/resume proof differs from authenticated source')
    require((out/'aave-resume-equivalence.json').read_bytes() == (source/'aave-resume-equivalence.json').read_bytes(), 'resume report not byte-identical')
    shutil.rmtree(out/'resume-work')
    # All generated admission/closeout artifacts go into a separate store.
    shutil.copytree(store, out/'store')
    shutil.copyfile(source/'aave-current-surface.json', out/'aave-current-surface.json')
    shutil.copyfile(source/'aave-history.json', out/'aave-history.json')
    run([binary/'nqc-rmc006-aave-admission', '--current', out/'aave-current-surface.json',
         '--history', out/'aave-history.json', '--store', out/'store', '--out', out/'aave-admission.json'], out/'admission.log')
    require((out/'aave-admission.json').read_bytes() == (source/'aave-admission.json').read_bytes(), 'admission changed')
    for label in ['closeout', 'closeout-rerun']:
        run([binary/'nqc-rmc006-aave-closeout', '--current', out/'aave-current-surface.json',
             '--history', out/'aave-history.json', '--store', out/'store', '--out-dir', out/label,
             '--code-commit', head, '--code-tree', tree], out/f'{label}.log')
    require(bytes_snapshot(out/'closeout') == bytes_snapshot(out/'closeout-rerun'), 'closeout is nondeterministic')
    summary = json.loads((out/'closeout/aave-discovery-summary.json').read_text())
    require(summary['code_commit'] == head and summary['code_tree'] == tree, 'wrong new producer identity')
    for field in ['reserve_union_count', 'getter_count', 'event_history_count', 'intersection_count']:
        require(summary[field] == 67, f'wrong reconciled count: {field}')
    for field in ['unexplained_delta_count', 'provider_mismatch_count', 'blocking_findings', 'unexplained_findings']:
        require(summary[field] == 0, f'blocking closeout finding: {field}')
    final = run([binary/'nqc-census-store-verify', '--store', out/'store'], out/'final-store-verify.log')
    match = re.search(r'^evidence_root=([a-f0-9]{64})$', final, re.M)
    require(match and 'RMC_004_OFFLINE_VERIFY=PASS' in final, 'result store did not verify')
    run([sys.executable, verifier, '--store', out/'store', '--expect-root', match[1]], out/'final-store-python.log')
    require(bytes_snapshot(source) == before, 'authenticated source mutated')
    run([sys.executable, verifier, '--store', store, '--expect-root', root], out/'source-store-after.log')
    times = verification_times(started_at, datetime.now(timezone.utc), pin['anchor']['timestamp'])
    proof = {'schema': 'nqc-rmc006-offline-verification-v1', 'code_commit': head, 'code_tree': tree,
             'source_commit': pin['run']['head_sha'], 'source_run_id': pin['run']['id'],
             'source_artifact_id': pin['artifact']['id'], 'source_artifact_digest': pin['artifact']['digest'],
             'source_store_root': root, 'result_store_root': match[1],
             'source_unchanged': True, 'current_replay_byte_identical': True,
             'history_replay_byte_identical': True, 'closeout_byte_identical': True,
             'canonical_recertification': False,
             'authority': 'Canonical authority requires the successful exact-head workflow, final artifact, and GitHub run timing read-back.',
             **times}
    (out/'offline-verification.json').write_text(json.dumps(proof, sort_keys=True, indent=2)+'\n')
    print('RMC006_OFFLINE_VERIFICATION_COMPLETE new_head='+head, flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f'RMC006_OFFLINE_VERIFICATION_FAILED: {error}', file=sys.stderr)
        sys.exit(1)

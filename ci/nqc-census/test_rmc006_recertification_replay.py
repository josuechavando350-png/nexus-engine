#!/usr/bin/env python3
"""Actual seed replay mutation matrix; run only in a disconnected namespace."""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import sys

import verify_store_independent as independent
from run_rmc006_recertification import bytes_snapshot, network_proof, require, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--parent-network-namespace', required=True)
    args = parser.parse_args()
    network_proof(args.parent_network_namespace)
    source, work, repo = args.source.resolve(), args.work.resolve(), args.repo.resolve()
    require(not work.exists() and not work.is_relative_to(source), 'negative work must be new and separate')
    run(['mount', '--bind', source, source])
    run(['mount', '-o', 'remount,bind,ro', source])
    require(os.statvfs(source).f_flag & os.ST_RDONLY, 'negative source is not read-only')
    before = bytes_snapshot(source)
    work.mkdir(parents=True)
    original = json.loads((source/'aave-current-surface.json').read_text())
    pin = json.loads((repo/'ci/nqc-census/rmc006-recertification-source.json').read_text())
    binary = repo/'nqc-census/target/release/nqc-rmc006-aave-current-replay'
    anchor = ['--anchor-number', str(pin['anchor']['number']), '--anchor-hash', pin['anchor']['hash']]
    results = []

    def reject(name, report=None, store=None, providers=None, extra=None):
        directory = work/name
        directory.mkdir()
        current = directory/'current.json'
        data = report if report is not None else original
        current.write_text(json.dumps(data, sort_keys=True, separators=(',', ':')))
        target = store or source/'store'
        before_target = bytes_snapshot(target)
        output = directory/'unexpected-output.json'
        run([binary, '--providers', providers or repo/'ci/nqc-census/rpc-providers.json',
             '--current', current, '--store', target, '--out', output, *(anchor if extra is None else extra)],
            directory/'rejection.log', expected=1)
        require(not output.exists(), 'failed replay published output')
        require(bytes_snapshot(target) == before_target, 'failed replay mutated source store')
        results.append({'case': name, 'rejected': True, 'store_unchanged': True})

    value = copy.deepcopy(original); value['schema'] = 'unknown'; reject('unknown-schema', value)
    value = copy.deepcopy(original); value['new_pass'] = True; reject('unknown-field', value)
    value = copy.deepcopy(original); value['status'] = 'PASS'; reject('fabricated-pass', value)
    value = copy.deepcopy(original); value['facts']['reserve_count'] = 68; reject('fabricated-reserve-count', value)
    value = copy.deepcopy(original); value['admission_fingerprint']['configuration_sha256'] = '00'*32; reject('configuration-fingerprint', value)
    value = copy.deepcopy(original); value['provider_manifests'].pop(); reject('missing-provider', value)
    value = copy.deepcopy(original); value['provider_manifests'][1] = value['provider_manifests'][0]; reject('duplicate-provider', value)
    value = copy.deepcopy(original); value['provider_manifests'].append(value['provider_manifests'][0]); reject('extra-provider', value)
    value = copy.deepcopy(original); value['provider_manifests'].reverse(); reject('provider-order', value)
    value = copy.deepcopy(original); value['provider_manifests'][0]['manifest'] = '00'*32; reject('wrong-manifest', value)
    reject('wrong-anchor', extra=['--anchor-number', '26095350', '--anchor-hash', pin['anchor']['hash']])
    reject('missing-anchor', extra=[])
    providers = json.loads((repo/'ci/nqc-census/rpc-providers.json').read_text())
    providers['providers'][0]['namespace'] += 100
    changed = work/'changed-providers.json'; changed.write_text(json.dumps(providers))
    reject('changed-provider-namespace', providers=changed)
    for name in ['missing-checkpoint', 'corrupted-checkpoint', 'missing-head', 'missing-stream',
                 'missing-manifest', 'missing-request', 'missing-response', 'missing-chunk', 'corrupted-chunk']:
        target = work/(name+'-store')
        shutil.copytree(source/'store', target)
        if name in ('missing-checkpoint', 'corrupted-checkpoint', 'missing-head', 'missing-stream'):
            scopes = []
            for candidate in (target/'streams').iterdir():
                fields = independent.parse((candidate/'SCOPE').read_bytes(), 'scope',
                    [[1, 2, 3, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8, 9]], str(candidate))
                if int.from_bytes(fields[5], 'big') == 0x0601:
                    scopes.append(candidate)
            require(len(scopes) == 3, 'expected exactly three current checkpoint scopes')
            scope = scopes[0]
            checkpoint = next((scope/'checkpoints').iterdir())
            if name == 'missing-checkpoint': checkpoint.unlink()
            elif name == 'corrupted-checkpoint': checkpoint.write_bytes(b'bad checkpoint')
            elif name == 'missing-head': (scope/'HEAD').unlink()
            else: shutil.rmtree(scope)
        elif name in ('missing-manifest', 'missing-request', 'missing-response'):
            identity = original['provider_manifests'][0]['manifest']
            if name != 'missing-manifest':
                cfg = independent.Config((target/'STORE').read_bytes(), str(target/'STORE'))
                artifact = target/'objects/artifacts'/identity[:2]/identity
                fields = independent.parse(artifact.read_bytes(), 'manifest', [[1, 2, 3, 4]], str(artifact))
                raw = b''
                for index in range(0, len(fields[4]), 72):
                    chunk_id = fields[4][index:index+32].hex()
                    chunk = target/'objects/chunks'/chunk_id[:2]/chunk_id
                    raw += independent.decode_frame(chunk.read_bytes(), cfg, str(chunk))
                job = json.loads(raw)
                identity = job['exchanges'][0]['request' if name == 'missing-request' else 'response']
            (target/'objects/artifacts'/identity[:2]/identity).unlink()
        else:
            chunk = next(p for p in (target/'objects/chunks').rglob('*') if p.is_file())
            if name == 'missing-chunk': chunk.unlink()
            else:
                data = chunk.read_bytes(); chunk.write_bytes(data[:-1]+bytes([data[-1]^1]))
        reject(name, store=target)
        shutil.rmtree(target)
    require(bytes_snapshot(source) == before, 'negative cases changed authenticated source')
    (work/'results.json').write_text(json.dumps({'schema': 'nqc-rmc006-replay-negatives-v1', 'cases': results}, indent=2, sort_keys=True)+'\n')
    print(f'RMC006_REPLAY_NEGATIVES_PASS cases={len(results)}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, StopIteration) as error:
        print(f'RMC006_REPLAY_NEGATIVES_FAILED: {error}', file=sys.stderr)
        sys.exit(1)

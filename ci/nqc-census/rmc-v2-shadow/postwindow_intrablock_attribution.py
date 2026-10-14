#!/usr/bin/env python3
"""Authenticate PR695 and reconstruct time / prefix / competitor execution locally."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

import postwindow_winner_prestate as pre

SOURCE_SHA = '1c5837ad97607fda9cb60c4888a77648645c48326a93a67adcb9f121e52d7fb8'
SOURCE_HEAD = '42f2056039840fd9621021e88ca69aedb2242ad6'
CONTRACT = 'NqcV2IntraBlockAttributionTest'
WAD = 10**18
NO_CROSSING = 2**256-1
need = pre.need


def authenticate(body):
    need(type(body) is bytes and len(body) < 10_000_000, 'invalid source size/type')
    need(sha256(body).hexdigest() == SOURCE_SHA, 'predecessor artifact digest mismatch')
    with zipfile.ZipFile(BytesIO(body)) as z:
        need(len(z.namelist()) == len(set(z.namelist())), 'duplicate source members')
        def read(name):
            need(z.getinfo(name).file_size < 8_000_000, 'oversize source member')
            return z.read(name)
        need(read('code-commit.txt').decode().strip() == SOURCE_HEAD, 'source head drift')
        report = pre.receipts.source.strict_json(read('attempt/predecessor-witnesses.json'))
        transcript = pre.receipts.source.strict_json(read('attempt/rpc-transcript.json'))
        events = pre.receipts.expected_events(pre.receipts.indexed.authenticate_archive(read('11860545203.zip')))
        pre.authenticate_receipts(read('11860624437.zip'))
    need(report['status'] == 'TWO_RPC_HISTORICAL_PREDECESSOR_ACCOUNT_PARITY_ONLY'
         and len(report['witnesses']) == 2, 'invalid predecessor authority')
    for key in ('P2_shadow_certified', 'RMC_closed', 'commercial_score_upgrade',
                'canary_live_authorized', 'atomic_execution_proven'):
        need(report[key] is False, 'source promoted beyond evidence')
    need(report['nqc_realized_pnl_usd'] == '0', 'source PnL drift')
    prepared = []
    for w, (pin, event) in zip(report['witnesses'], events):
        need(w['competitor_tx_hash'] == pin['tx'] and w['label'] == pin['label'], 'source order drift')
        blocks = [r['result'] for r in transcript if r['method'] == 'eth_getBlockByNumber'
                  and r['params'] == [hex(pin['block']), False]]
        need(len(blocks) == 4, 'two before/after endpoint headers required')
        for block in blocks:
            need(pre.receipts.header(block, pin['block']) == w['winner_block'], 'source header drift')
            need(block['transactions'] == blocks[0]['transactions'], 'source transaction ordering drift')
        index = w['winner_transaction_index']
        need(type(index) is int and 1 <= index <= 10, 'unbounded transaction prefix')
        need(blocks[0]['transactions'][index] == pin['tx'], 'winner index drift')
        need(index == event['transaction_index'], 'event index drift')
        prepared.append({'witness': w, 'event': event,
                         'prefix_transactions': blocks[0]['transactions'][:index]})
    return prepared


def parse_metrics(output, count):
    need('1 passed; 0 failed; 0 skipped' in output, 'fork did not pass exactly one test')
    need('[PASS] testTimePrefixAndHistoricalWinner()' in output, 'wrong fork test')
    found = re.findall(r'^\s+(NQC_[A-Z_]+): (\d+)(?: \[[^\n]*\])?\s*$', output, re.M)
    fields = {}
    for key, value in found:
        fields.setdefault(key, []).append(int(value))
    singles = ('NQC_PARENT_HF', 'NQC_TIME_ONLY_HF', 'NQC_REFERENCE_PRESTATE_HF',
               'NQC_FIRST_PREFIX_CROSSING_INDEX', 'NQC_PREFIX_ACCOUNT_PARITY',
               'NQC_WINNER_EVENT_PARITY', 'NQC_POST_WINNER_HF')
    need(set(fields) == set(singles) | {'NQC_PREFIX_INDEX', 'NQC_PREFIX_HF'}, 'missing/unknown metrics')
    need(all(len(fields[k]) == 1 for k in singles), 'duplicate metric')
    need(fields['NQC_PREFIX_INDEX'] == list(range(count)) and
         len(fields['NQC_PREFIX_HF']) == count, 'incomplete/out-of-order prefix evidence')
    metrics = {k: fields[k][0] for k in singles}
    metrics['prefix_hf_wad'] = fields['NQC_PREFIX_HF']
    need(metrics['NQC_PREFIX_ACCOUNT_PARITY'] == metrics['NQC_WINNER_EVENT_PARITY'] == 1,
         'replay did not reproduce account and original event')
    expected = next((i for i, hf in enumerate(metrics['prefix_hf_wad']) if hf < WAD), NO_CROSSING)
    need(metrics['NQC_FIRST_PREFIX_CROSSING_INDEX'] == expected, 'crossing metric inconsistent')
    need(metrics['prefix_hf_wad'][-1] == metrics['NQC_REFERENCE_PRESTATE_HF'], 'final HF mismatch')
    abi = re.findall(r'^\s+NQC_REFERENCE_PRESTATE_ABI: (0x[0-9a-f]{384})\s*$', output, re.M)
    need(len(abi) == 1, 'reference prestate ABI missing/duplicated')
    need(int(pre.decode_account(abi[0])['health_factor_wad']) == metrics['NQC_REFERENCE_PRESTATE_HF'],
         'reference ABI/HF mismatch')
    metrics['reference_prestate_abi'] = abi[0]
    return metrics


def canonical_check(case, provider, transcript):
    rpc = pre.RPC(provider, transcript=transcript)
    rpc.chain()
    w = case['witness']
    for label in ('predecessor_block', 'winner_block'):
        expected = w[label]
        block = rpc.call('eth_getBlockByNumber', [hex(expected['number']), False])
        need(pre.receipts.header(block, expected['number']) == expected, 'canonical source changed')
        if label == 'winner_block':
            need(block['transactions'][:w['winner_transaction_index']] == case['prefix_transactions']
                 and block['transactions'][w['winner_transaction_index']] == w['competitor_tx_hash'],
                 'canonical transaction sequence changed')


def run_fork(case, provider, root, forge):
    w = case['witness']; event = case['event']
    folder = root / (w['label'].lower() + '-' + provider)
    folder.mkdir()
    (folder/'src').mkdir(); (folder/'test').mkdir()
    source = Path(__file__).resolve().parents[1]/'weth-physical'
    shutil.copy(source/'test/NqcV2IntraBlockAttribution.t.sol', folder/'test/')
    shutil.copy(source/'foundry-time-only.toml', folder/'foundry.toml')
    values = {
        'NQC_RPC_URL': pre.receipts.PROVIDERS[provider][1], 'NQC_BORROWER': w['borrower'],
        'NQC_WINNER_BLOCK': str(w['winner_block']['number']),
        'NQC_WINNER_TIMESTAMP': str(w['winner_block']['timestamp']),
        'NQC_PARENT_HASH': w['predecessor_block']['hash'],
        'NQC_PARENT_TIMESTAMP': str(w['predecessor_block']['timestamp']),
        'NQC_WINNER_TX': w['competitor_tx_hash'], 'NQC_WINNER_INDEX': str(w['winner_transaction_index']),
        'NQC_PREFIX_TXS': ','.join(case['prefix_transactions']), 'NQC_PARENT_ACCOUNT_ABI': w['account_abi_hex'],
        'NQC_EVENT_TOPICS': ','.join(event['raw_topics']), 'NQC_EVENT_DATA': event['raw_data'],
    }
    write(folder/'public-inputs.json', values)
    transcript = []
    try:
        canonical_check(case, provider, transcript)
        with (folder/'forge.log').open('xb') as log:
            result = subprocess.run([forge, 'test', '--match-contract', CONTRACT, '-vvv'],
                                    cwd=folder, env=dict(os.environ, **values), stdout=log,
                                    stderr=subprocess.STDOUT, timeout=600, check=False)
        write(folder/'exit.json', {'returncode': result.returncode})
        need(result.returncode == 0, 'forge failed; inspect preserved log')
        metrics = parse_metrics((folder/'forge.log').read_text(), w['winner_transaction_index'])
        need(metrics['NQC_PARENT_HF'] == int(w['account_data']['health_factor_wad']), 'parent HF drift')
        canonical_check(case, provider, transcript)
        write(folder/'metrics.json', metrics)
        return metrics
    finally:
        write(folder/'canonical-rpc-transcript.json', transcript)


def write(path, value):
    path.write_bytes(pre.canon(value))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source-artifact', required=True, type=Path)
    p.add_argument('--out-dir', required=True, type=Path)
    p.add_argument('--forge', required=True)
    a = p.parse_args()
    need(a.out_dir.is_absolute() and not a.out_dir.exists(), 'fresh absolute output required')
    a.out_dir.mkdir(parents=True)
    summary = {'status': 'INCOMPLETE_NO_ATTRIBUTION', 'source_zip_sha256': SOURCE_SHA,
               'started_at_utc': datetime.now(timezone.utc).isoformat(), 'cases': [], 'errors': [],
               'historical_selection_uses_future_winner': True, 'prospective_detection_proven': False,
               'nqc_atomic_route_proven': False, 'nqc_net_margin_proven': False,
               'external_nonrecourse_gas_funding_proven': False, 'P2_shadow_certified': False,
               'RMC_closed': False, 'commercial_score_upgrade': False,
               'canary_live_authorized': False, 'nqc_realized_pnl_usd': '0'}
    try:
        cases = authenticate(a.source_artifact.read_bytes())
        for case in cases:
            observations = {}
            for provider in pre.receipts.PROVIDERS:
                try:
                    observations[provider] = run_fork(case, provider, a.out_dir, a.forge)
                except Exception as exc:
                    summary['errors'].append({'label': case['witness']['label'], 'provider': provider,
                                              'error': type(exc).__name__ + ':' + str(exc)[:400]})
            row = {'label': case['witness']['label'], 'prefix_transactions': case['prefix_transactions'],
                   'provider_metrics': observations, 'two_endpoint_parity': False}
            if len(observations) == 2:
                need(observations['drpc'] == observations['blast'], 'two endpoint fork metrics differ')
                row['two_endpoint_parity'] = True
            summary['cases'].append(row)
        if not summary['errors'] and all(row['two_endpoint_parity'] for row in summary['cases']):
            summary['status'] = 'HISTORICAL_TIME_PREFIX_WINNER_EVENT_PARITY_ONLY'
    except Exception as exc:
        summary['errors'].append({'error': type(exc).__name__ + ':' + str(exc)[:400]})
    finally:
        summary['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
        write(a.out_dir/'attribution.json', summary)
    print(summary['status'])
    return 0 if summary['status'] == 'HISTORICAL_TIME_PREFIX_WINNER_EVENT_PARITY_ONLY' else 2


if __name__ == '__main__':
    raise SystemExit(main())

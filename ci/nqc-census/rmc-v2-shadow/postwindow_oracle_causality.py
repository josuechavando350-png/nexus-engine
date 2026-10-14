#!/usr/bin/env python3
"""Fail-closed historical oracle/HF isolation; never signs or broadcasts."""
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
import time
from urllib.request import Request, urlopen
import zipfile

WAD = 10**18
AGGREGATOR = '0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8'
FORWARD_SELECTOR = '6fadcf72'
INNER_SELECTOR = 'ba0cb29e'  # observed candidate; never assume public mempool access
CONTRACT = 'NqcV2OracleCausalityTest'
NUMBERS = ('NQC_ORACLE_PRICE_BEFORE', 'NQC_ORACLE_PRICE_AFTER',
           'NQC_FEED_ANSWER_BEFORE', 'NQC_FEED_ANSWER_AFTER',
           'NQC_HF_BEFORE_TX0', 'NQC_HF_AFTER_TX0',
           'NQC_HF_PRICE_FROZEN', 'NQC_HF_AFTER_CLEAR',
           'NQC_PRICE_FREEZE_REVERTS_TRIGGER')


def need(condition, why):
    if not condition:
        raise ValueError(why)


def canon(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)+'\n').encode()


def write_new(path: Path, value):
    with path.open('xb') as f:
        f.write(canon(value))


def decode_forward_transaction(tx, case):
    """Verify canonical index-zero outer forwarding and exact aggregator target."""
    witness = case['witness']
    first_tx = case['prefix_transactions'][0]
    need(type(tx) is dict and type(tx.get('input')) is str, 'missing canonical transaction')
    need(tx.get('hash', '').lower() == first_tx.lower(), 'transaction hash drift')
    need(tx.get('blockHash', '').lower() == witness['winner_block']['hash'].lower(), 'block hash drift')
    need(tx.get('blockNumber') == hex(witness['winner_block']['number']), 'block height drift')
    need(tx.get('transactionIndex') == '0x0', 'first transaction not index zero')
    need(type(tx.get('to')) is str and re.fullmatch('0x[0-9a-fA-F]{40}', tx['to']), 'missing forwarder')
    need(type(tx.get('chainId')) is str and int(tx['chainId'], 16) == 1, 'not Ethereum mainnet')
    inp = tx['input']
    need(re.fullmatch(r'0x[0-9a-fA-F]+', inp) is not None and len(inp) % 2 == 0, 'invalid forward calldata')
    blob = bytes.fromhex(inp[2:]); need(len(blob) >= 4 + 96, 'forward calldata too short')
    need(blob[:4].hex() == FORWARD_SELECTOR, 'unexpected forwarding method')
    args = blob[4:]
    need(int.from_bytes(args[:12], 'big') == 0, 'noncanonical forwarding address padding')
    target = '0x' + args[12:32].hex()
    need(target == AGGREGATOR, 'not authenticated ETH/USD aggregator')
    offset = int.from_bytes(args[32:64], 'big')
    need(offset == 64, 'unexpected forwarding ABI offset')
    n = int.from_bytes(args[64:96], 'big')
    need(4 <= n <= 100_000 and len(args) == 96 + ((n + 31)//32)*32,
         'forwarding ABI length mismatch or trailing bytes')
    inner = args[96:96+n]
    need(inner[:4].hex() == INNER_SELECTOR, 'unexpected oracle report method')
    need(all(x == 0 for x in args[96+n:]), 'nonzero forwarding padding')
    return {'tx_hash': first_tx.lower(), 'block_hash': witness['winner_block']['hash'].lower(),
            'block_number': witness['winner_block']['number'], 'index': 0,
            'forwarder': tx['to'].lower(), 'target': target,
            'outer_method_id': '0x'+FORWARD_SELECTOR, 'inner_method_id': '0x'+INNER_SELECTOR,
            'tx_input_sha256': sha256(blob).hexdigest(), 'input_bytes': len(blob),
            'inner_bytes': len(inner)}


def validate_attribution_metrics(m):
    need(type(m) is dict, 'missing producer metrics')
    need(type(m.get('prefix_hf_wad')) is list and len(m['prefix_hf_wad']) >= 1,
         'missing first prefix HF')
    need(all(type(v) is int for v in m['prefix_hf_wad']), 'invalid prefix integer HF')
    need(type(m.get('NQC_TIME_ONLY_HF')) is int and m['NQC_TIME_ONLY_HF'] >= WAD,
         'time-only state already liquidatable')
    need(m.get('NQC_FIRST_PREFIX_CROSSING_INDEX') == 0 and m['prefix_hf_wad'][0] < WAD,
         'first transaction not proven sufficient for crossing')
    need(m.get('NQC_PREFIX_ACCOUNT_PARITY') == m.get('NQC_WINNER_EVENT_PARITY') == 1,
         'producer replay not authentic')
    need(m['prefix_hf_wad'][-1] == m['NQC_REFERENCE_PRESTATE_HF'],
         'producer last prefix HF mismatch')
    return m['NQC_TIME_ONLY_HF'], m['prefix_hf_wad'][0]


def authenticate_cases(predecessor_zip: bytes, attribution_zip: bytes):
    # Fully authenticate both producer artifacts using PR698's existing validators.
    import postwindow_funded_route as funded
    cases = funded.authenticate(predecessor_zip, attribution_zip)
    with zipfile.ZipFile(BytesIO(attribution_zip)) as z:
        need(z.getinfo('attempt/attribution.json').file_size < 1_000_000,
             'producer attribution oversized')
        report = funded.attribution.pre.receipts.source.strict_json(
            z.read('attempt/attribution.json'))
    need(report['status'] == 'INCOMPLETE_NO_ATTRIBUTION' and len(report['cases']) == 2,
         'producer failure/status drift')
    for case, row in zip(cases, report['cases']):
        need(row['label'] == case['witness']['label'] and
             set(row['provider_metrics']) == {'drpc'} and row['two_endpoint_parity'] is False,
             'producer authority drift')
        start, after = validate_attribution_metrics(row['provider_metrics']['drpc'])
        need(case['prefix_transactions'] and len(case['prefix_transactions']) ==
             case['witness']['winner_transaction_index'], 'missing canonical prefix')
        case['hf_before_tx0'] = start
        case['hf_after_tx0'] = after
    return cases


def request_tx(provider, txhash, upstream, transcript):
    need(provider in ('blast', 'drpc'), 'unapproved provider')
    url = upstream.pre.receipts.PROVIDERS[provider][1]
    need(url in {v[1] for v in upstream.pre.receipts.PROVIDERS.values()}, 'unapproved RPC')
    time.sleep(1)
    payload = {'jsonrpc': '2.0', 'id': 73, 'method': 'eth_getTransactionByHash',
               'params': [txhash]}
    t0 = time.monotonic_ns()
    record = {'provider': provider, 'method': payload['method'], 'hash': txhash,
              'started_at': datetime.now(timezone.utc).isoformat()}
    try:
        req = Request(url, data=json.dumps(payload).encode(), method='POST',
                      headers={'Content-Type': 'application/json', 'User-Agent': 'NQC-Oracle-Historical-ReadOnly/1'})
        with urlopen(req, timeout=30) as resp:
            body = resp.read(1_000_001)
        need(len(body) <= 1_000_000, 'oversize RPC transaction response')
        parsed = upstream.pre.receipts.source.strict_json(body)
        need(type(parsed) is dict and parsed.get('id') == 73 and parsed.get('jsonrpc') == '2.0'
             and 'error' not in parsed and type(parsed.get('result')) is dict,
             'invalid tx RPC response')
        # Retain the response for replay; never record URL query secrets.
        record['result'] = parsed['result']
        return parsed['result']
    except Exception as e:
        record['error'] = type(e).__name__ + ':' + str(e)[:240]
        raise
    finally:
        record['finished_at'] = datetime.now(timezone.utc).isoformat()
        record['elapsed_ns'] = time.monotonic_ns() - t0
        transcript.append(record)


def parse_fork_log(output, case):
    need('[PASS] testFirstOracleUpdatePriceFreeze()' in output and
         '1 passed; 0 failed; 0 skipped' in output, 'historical fork did not pass')
    found = re.findall(r'^\s+(NQC_[A-Z0-9_]+): (\d+)(?: \[[^\n]*\])?\s*$', output, re.M)
    need(len(found) == len(NUMBERS) and {k for k, _ in found} == set(NUMBERS),
         'missing/extra/duplicate metrics')
    m = {k: int(v) for k, v in found}
    need(m['NQC_HF_BEFORE_TX0'] == case['hf_before_tx0'] and
         m['NQC_HF_AFTER_TX0'] == case['hf_after_tx0'], 'producer HF disagreement')
    need(m['NQC_ORACLE_PRICE_BEFORE'] > m['NQC_ORACLE_PRICE_AFTER'] > 0,
         'expected downward ETH/USD price change absent')
    need(m['NQC_FEED_ANSWER_BEFORE'] > m['NQC_FEED_ANSWER_AFTER'] > 0,
         'feed answer did not fall')
    need(m['NQC_HF_BEFORE_TX0'] >= WAD > m['NQC_HF_AFTER_TX0'], 'trigger crossing absent')
    need(m['NQC_HF_PRICE_FROZEN'] >= WAD and
         m['NQC_PRICE_FREEZE_REVERTS_TRIGGER'] == 1 and
         m['NQC_HF_AFTER_CLEAR'] == m['NQC_HF_AFTER_TX0'], 'oracle price freeze did not isolate crossing')
    return m


def run_provider(case, provider, folder, forge, upstream):
    folder.mkdir(); (folder/'src').mkdir(); (folder/'test').mkdir()
    repo_ci = Path(__file__).resolve().parents[1]
    source = repo_ci / 'weth-physical'
    shutil.copy(source/'test/NqcV2OracleCausality.t.sol', folder/'test/')
    shutil.copy(source/'foundry-time-only.toml', folder/'foundry.toml')
    transcript = []
    try:
        upstream.canonical_check(case, provider, transcript)
        raw = request_tx(provider, case['prefix_transactions'][0], upstream, transcript)
        fingerprint = decode_forward_transaction(raw, case)
        write_new(folder/'tx0-fingerprint.json', fingerprint)
        w = case['witness']
        values = {'NQC_RPC_URL': upstream.pre.receipts.PROVIDERS[provider][1],
                  'NQC_BORROWER': w['borrower'], 'NQC_FIRST_TX': case['prefix_transactions'][0],
                  'NQC_WINNER_BLOCK': str(w['winner_block']['number']),
                  'NQC_WINNER_TIMESTAMP': str(w['winner_block']['timestamp']),
                  'NQC_PARENT_HASH': w['predecessor_block']['hash'],
                  'NQC_HF_BEFORE_TX0': str(case['hf_before_tx0']),
                  'NQC_HF_AFTER_TX0': str(case['hf_after_tx0'])}
        write_new(folder/'public-inputs.json', {k:v for k,v in values.items() if k != 'NQC_RPC_URL'})
        write_new(folder/'source-sha256.json', {str(x.relative_to(folder)):sha256(x.read_bytes()).hexdigest()
             for x in (folder/'foundry.toml', folder/'test/NqcV2OracleCausality.t.sol')})
        with (folder/'forge.log').open('xb') as log:
            try:
                run = subprocess.run([forge, 'test', '--match-contract', CONTRACT,
                    '--fork-url', values['NQC_RPC_URL'], '--fork-block-number',
                    str(w['predecessor_block']['number']), '--no-storage-caching',
                    '--compute-units-per-second', '5', '--fork-retries', '2',
                    '--fork-retry-backoff', '10000', '--threads', '1', '-vvv'],
                    cwd=folder, env=dict(os.environ, **values), stdout=log,
                    stderr=subprocess.STDOUT, timeout=1000, check=False)
            except subprocess.TimeoutExpired:
                write_new(folder/'exit.json', {'returncode':None, 'timeout_seconds':1000})
                raise
        write_new(folder/'exit.json', {'returncode':run.returncode})
        need(run.returncode == 0, 'fork failed; preserve log')
        m=parse_fork_log((folder/'forge.log').read_text(), case)
        upstream.canonical_check(case, provider, transcript)
        write_new(folder/'metrics.json', m)
        return {'tx': fingerprint, 'metrics': m}
    finally:
        write_new(folder/'rpc-transcript.json', transcript)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--predecessor-artifact', type=Path, required=True)
    p.add_argument('--attribution-artifact', type=Path, required=True)
    p.add_argument('--out-dir', type=Path, required=True)
    p.add_argument('--forge', required=True)
    args = p.parse_args()
    need(args.out_dir.is_absolute() and not args.out_dir.exists(), 'fresh absolute evidence directory required')
    args.out_dir.mkdir(parents=True)
    report={'status':'INCOMPLETE_ORACLE_CAUSALITY', 'schema_version':1,
            'started_at_utc':datetime.now(timezone.utc).isoformat(), 'cases':[], 'errors':[],
            'historical_selection_uses_future_winner':True,
            'counterfactual_oracle_price_override_only_in_test':True,
            'oracle_causality_is_not_mempool_visibility':True,
            'prospective_detection_proven':False,'available_private_orderflow_proven':False,
            'nqc_net_margin_proven':False,'external_nonrecourse_gas_funding_proven':False,
            'RMC_closed':False,'P2_shadow_certified':False,'canary_live_authorized':False,
            'commercial_score_upgrade':False,'nqc_realized_pnl_usd':'0'}
    try:
        import postwindow_intrablock_attribution as upstream
        cases = authenticate_cases(args.predecessor_artifact.read_bytes(),
                                   args.attribution_artifact.read_bytes())
        for case in cases:
            row={'label':case['witness']['label'],'first_tx':case['prefix_transactions'][0],
                 'providers':{},'two_endpoint_parity':False}
            report['cases'].append(row)
            for provider in ('drpc','blast'):
                try:
                    row['providers'][provider] = run_provider(case, provider,
                         args.out_dir/(row['label'].lower()+'-'+provider), args.forge, upstream)
                except Exception as exc:
                    report['errors'].append({'label':row['label'],'provider':provider,
                        'type':type(exc).__name__,'detail':str(exc)[:400]})
            if set(row['providers']) == {'drpc','blast'}:
                need(row['providers']['drpc']['metrics'] == row['providers']['blast']['metrics'],
                     'two endpoint oracle/borrower metrics mismatch')
                need(row['providers']['drpc']['tx'] == row['providers']['blast']['tx'],
                     'two endpoint forwarded tx identities mismatch')
                row['two_endpoint_parity']=True
        if not report['errors'] and len(report['cases']) == 2 and all(c['two_endpoint_parity'] for c in report['cases']):
            report['status']='HISTORICAL_ORACLE_PRICE_CAUSALITY_ONLY'
    except Exception as exc:
        report['errors'].append({'type':type(exc).__name__,'detail':str(exc)[:400]})
    finally:
        report['finished_at_utc']=datetime.now(timezone.utc).isoformat()
        write_new(args.out_dir/'oracle-causality.json', report)
    print(report['status'])
    return 0 if report['status']=='HISTORICAL_ORACLE_PRICE_CAUSALITY_ONLY' else 2

if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Source-bound predecessor HF for two historical winners; read-only, no trade.

End-of-parent state is NOT the state immediately before the winning transaction.
Selections use hindsight; HF<1 only admits further fork research, never execution.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen
import zipfile

import verify_postwindow_competitor_receipts as receipts

need = receipts.need
Rejected = receipts.Rejected
canon = receipts.indexed.canon
RECEIPT_ZIP_SHA = '3dc59eca6051d7aa11e45d1042953ae61eca29ae032b0f70c4f441f4be621931'
SELECTOR = '0xbf92857c'
WAD = 10**18
ALLOWED = receipts.ALLOWED | {'eth_call'}
WORD6 = re.compile(r'0x[0-9a-fA-F]{384}\Z')
MAX_CALLS = 15  # chain + 2 * (winner,parent,receipt,call,parent,winner,chain)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def authenticate_receipts(body):
    need(type(body) is bytes and len(body) <= 2_000_000,
         'receipt archive size/type rejected')
    need(sha256(body).hexdigest() == RECEIPT_ZIP_SHA,
         'immutable receipt artifact SHA256 mismatch')
    with zipfile.ZipFile(BytesIO(body)) as archive:
        need(len(archive.namelist()) == len(set(archive.namelist())),
             'duplicate receipt artifact names')
        name = 'real-competitor-receipts.json'
        need(archive.getinfo(name).file_size <= 50_000, 'receipt report oversized')
        report = receipts.source.strict_json(archive.read(name))
    need(report['source_indexer_artifact_sha256'] == receipts.indexed.ZIP_SHA and
         report['status'] == 'TWO_PUBLIC_RPC_HISTORICAL_RECEIPT_PARITY_NO_NEXUS_CAPTURE' and
         report['rpc_provider_ids'] == ['blast', 'drpc'] and
         len(report['historical_receipt_witnesses']) == 2,
         'receipt source authority/identity drift')
    for field in ('RMC_closed', 'P2_shadow_certified', 'canary_live_authorized',
                  'commercial_score_upgrade'):
        need(report[field] is False, 'receipt source falsely promoted')
    need(report['nqc_realized_pnl_usd'] == '0', 'receipt source falsely reports revenue')
    return report['historical_receipt_witnesses']


def decode_account(raw):
    need(type(raw) is str and WORD6.fullmatch(raw), 'invalid six-word Aave account ABI')
    values = [int(raw[2+i*64:2+(i+1)*64], 16) for i in range(6)]
    collateral, debt, available, threshold, ltv, hf = values
    need(threshold <= 10000 and ltv <= 10000, 'invalid Aave threshold/ltv bps')
    # No-debt is valid negative evidence, never a trigger even if hf looks low.
    classification = ('NO_DEBT_AT_PREDECESSOR' if debt == 0 else
                      'HF_NOT_BELOW_ONE_AT_PREDECESSOR' if hf >= WAD else
                      'HF_BELOW_ONE_REQUIRES_EXECUTION_RECONSTRUCTION')
    return {
        'total_collateral_base_raw': str(collateral), 'total_debt_base_raw': str(debt),
        'available_borrows_base_raw': str(available),
        'liquidation_threshold_bps': threshold, 'ltv_bps': ltv,
        'health_factor_wad': str(hf), 'classification': classification,
        'debt_positive_and_hf_below_one': debt > 0 and hf < WAD,
    }


class RPC:
    def __init__(self, provider, transport=None, transcript=None):
        need(provider in receipts.PROVIDERS, 'unapproved provider')
        self.provider = provider
        self.url = receipts.PROVIDERS[provider][1]
        self.transport = transport or self.fetch
        self.transcript = transcript if transcript is not None else []
        self.calls = 0

    @staticmethod
    def fetch(url, method, params):
        need(url in {x[1] for x in receipts.PROVIDERS.values()}, 'unapproved URL')
        need(method in ALLOWED, 'non-read-only method prohibited')
        request = Request(url, data=json.dumps({
            'jsonrpc': '2.0', 'id': 7, 'method': method, 'params': params,
        }).encode(), headers={'Content-Type': 'application/json',
                              'User-Agent': 'NQC-Historical-Predecessor-ReadOnly/1'},
                          method='POST')
        with urlopen(request, timeout=24) as response:
            body = response.read(receipts.MAX_RPC_BYTES+1)
        need(len(body) <= receipts.MAX_RPC_BYTES, 'RPC response too large')
        result = receipts.source.strict_json(body)
        need(type(result) is dict and result.get('jsonrpc') == '2.0' and
             type(result.get('id')) is int and result['id'] == 7 and
             'result' in result and 'error' not in result, 'RPC error/malformed response')
        return result['result']

    def call(self, method, params):
        need(method in ALLOWED, 'non-read-only method prohibited')
        if method == 'eth_call':
            need(type(params) is list and len(params) == 2 and
                 type(params[0]) is dict and set(params[0]) == {'to', 'data'} and
                 params[0]['to'] == receipts.source.POOL and
                 re.fullmatch(SELECTOR+r'0{24}[0-9a-f]{40}', params[0]['data']) and
                 type(params[1]) is dict and
                 set(params[1]) == {'blockHash', 'requireCanonical'} and
                 params[1]['requireCanonical'] is True and
                 receipts.HEX32.fullmatch(params[1]['blockHash']),
                 'only exact hash-pinned Aave account read allowed; no overrides')
        self.calls += 1
        need(self.calls <= MAX_CALLS, 'RPC request budget exhausted')
        record = {'provider_id': self.provider, 'method': method, 'params': params,
                  'request_started_at_utc': utcnow()}
        started = time.monotonic_ns()
        try:
            result = self.transport(self.url, method, params)
            record['result'] = result
            return result
        except Exception as exc:
            record['error'] = {'type': type(exc).__name__, 'message': str(exc)[:300]}
            raise
        finally:
            record['response_finished_at_utc'] = utcnow()
            record['elapsed_ns'] = time.monotonic_ns() - started
            self.transcript.append(record)

    def chain(self):
        need(receipts.qty(self.call('eth_chainId', []), 'chain') == 1,
             'source is not Ethereum mainnet')

    def observe(self, pin, row, baseline):
        block = pin['block']
        def get_header(n):
            return receipts.header(self.call('eth_getBlockByNumber', [hex(n), False]), n)
        winner = get_header(block)
        need(winner == baseline['header'], 'winner header differs from immutable source')
        parent = get_header(block-1)
        need(parent['hash'] == winner['parent_hash'] and
             parent['timestamp'] < winner['timestamp'], 'broken predecessor ancestry/time')
        raw_receipt = self.call('eth_getTransactionReceipt', [pin['tx']])
        witness = receipts.verify_receipt(raw_receipt, winner, pin, row)
        need(witness == baseline['receipt_witness'], 'canonical receipt differs from source')
        borrower = receipts.source.address(row['raw_topics'][3], 'borrower')
        need(borrower != '0x'+'0'*40 and
             sha256(borrower.encode()).hexdigest() == row['borrower_sha256'],
             'borrower identity commitment mismatch')
        raw = self.call('eth_call', [
            {'to': receipts.source.POOL, 'data': SELECTOR+borrower[2:].rjust(64, '0')},
            {'blockHash': parent['hash'], 'requireCanonical': True},
        ])
        account = decode_account(raw)
        need(get_header(block-1) == parent and get_header(block) == winner,
             'canonical header changed during observation')
        self.chain()
        return {'label': pin['label'], 'competitor_tx_hash': pin['tx'],
                'winner_transaction_index': row['transaction_index'],
                'winner_block': winner, 'predecessor_block': parent,
                'borrower': borrower, 'borrower_sha256': row['borrower_sha256'],
                'collateral_asset': pin['collateral'], 'debt_asset': pin['debt'],
                'account_abi_hex': raw.lower(), 'account_data': account,
                'exact_winner_transaction_prestate_reconstructed': False,
                'winner_block_elapsed_seconds': winner['timestamp']-parent['timestamp']}


def run(indexer_zip, receipt_zip, *, transport=None, transcript=None,
        provider_ids=('drpc', 'blast')):
    need(type(provider_ids) in (tuple, list) and len(provider_ids) == 2 and
         set(provider_ids) == set(receipts.PROVIDERS), 'two distinct providers required')
    events = receipts.expected_events(receipts.indexed.authenticate_archive(indexer_zip))
    baselines = authenticate_receipts(receipt_zip)
    observations = {}
    for provider in provider_ids:
        rpc = RPC(provider, transport, transcript)
        rpc.chain()
        observations[provider] = [rpc.observe(pin, row, baseline)
                                  for (pin, row), baseline in zip(events, baselines)]
    need(observations['drpc'] == observations['blast'],
         'RPC predecessor account/header/receipt parity mismatch')
    return {'schema_version': 1,
            'status': 'TWO_RPC_HISTORICAL_PREDECESSOR_ACCOUNT_PARITY_ONLY',
            'source_indexer_zip_sha256': receipts.indexed.ZIP_SHA,
            'source_receipt_zip_sha256': RECEIPT_ZIP_SHA,
            'rpc_provider_ids': sorted(observations),
            'rpc_operator_independence_proven': False,
            'historical_selection_uses_future_winner': True,
            'predecessor_is_end_of_parent_not_winner_transaction_prestate': True,
            'witnesses': observations['drpc'],
            'prospective_detection_proven': False, 'atomic_execution_proven': False,
            'external_nonrecourse_gas_funding_proven': False,
            'RMC_closed': False, 'P2_shadow_certified': False,
            'canary_live_authorized': False, 'commercial_score_upgrade': False,
            'nqc_realized_pnl_usd': '0'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--indexer-artifact', type=Path, required=True)
    parser.add_argument('--receipt-artifact', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    args = parser.parse_args()
    # Never overwrite or merge with a previous run, including failed attempts.
    args.out_dir.mkdir(parents=True, exist_ok=False)
    transcript = []
    started = utcnow()
    try:
        report = run(args.indexer_artifact.read_bytes(), args.receipt_artifact.read_bytes(),
                     transcript=transcript)
        report['observation_started_at_utc'] = started
        report['observation_finished_at_utc'] = utcnow()
        (args.out_dir/'predecessor-witnesses.json').write_bytes(canon(report))
        for witness in report['witnesses']:
            print(witness['label'], witness['account_data']['classification'],
                  'HF_WAD', witness['account_data']['health_factor_wad'])
    except Exception as exc:
        (args.out_dir/'failure.json').write_bytes(canon({
            'status': 'SOURCE_OR_PARITY_FAILURE_NO_ACCOUNT_ADMISSION',
            'exception_type': type(exc).__name__, 'reason': str(exc)[:500],
            'observed_at_utc': utcnow(), 'nqc_realized_pnl_usd': '0'}))
        raise
    finally:
        (args.out_dir/'rpc-transcript.json').write_bytes(canon(transcript))
        (args.out_dir/'evidence.sha256').write_text(''.join(
            f'{sha256(p.read_bytes()).hexdigest()}  {p.name}\n'
            for p in sorted(args.out_dir.iterdir()) if p.is_file()))


if __name__ == '__main__':
    main()

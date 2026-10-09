#!/usr/bin/env python3
"""Read-only Tenderly receipts against the exact original dRPC checkpoint.

The dRPC source run failed at a later Blast step. Only its SHA-authenticated
complete dRPC checkpoint is reused; its overall workflow is never called PASS.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import time

from rmc016_probe_historical_rpc import (
    START_BLOCK, START_HASH, END_BLOCK, END_HASH, checked_header, rpc,
)
from rmc016_resume_verified_receipts import (
    authenticated_drpc_checkpoint, DRPC_CHECKPOINT_SHA256, SOURCE_ARTIFACT_SHA256,
)
from rmc016_two_operator_receipts import receipt_normalized
from rmc016_winner_net_audit import canonical, digest, parse_json, require

ENDPOINT = 'https://gateway.tenderly.co/public/mainnet'


def legacy_or_type2_receipt(raw: dict) -> dict:
    """Normalize Tenderly's explicit zero on non-blob receipts, preserving raw.

    EIP-4844 assigns blobs to transaction type 0x03. The bounded corpus contains
    only legacy/type-2 receipts; a missing type or a nonzero blob witness fails.
    https://eips.ethereum.org/EIPS/eip-4844#parameters
    """
    require(type(raw) is dict and raw.get('type') in ('0x0', '0x2'),
            'only explicit legacy/type-2 receipts supported in this corpus')
    require(raw.get('blobGasUsed') in (None, '0x0') and raw.get('blobGasPrice') is None,
            'non-blob receipt has inconsistent blob fee fields')
    result = dict(raw)
    result.pop('blobGasUsed', None)
    result.pop('blobGasPrice', None)
    return result


def reconcile(source_zip: Path, drpc_zip: Path, exchanges: list[dict]) -> dict:
    receipts, events, ids = authenticated_drpc_checkpoint(drpc_zip, source_zip)
    require(len(exchanges) == 132, 'exact chain, two before/after headers and 127 receipts required')
    expected = [('eth_chainId', [])]
    anchors = [('eth_getBlockByNumber', [hex(START_BLOCK), False]),
               ('eth_getBlockByNumber', [hex(END_BLOCK), False])]
    expected += anchors + [('eth_getTransactionReceipt', [tx]) for tx in ids] + anchors
    normalized = []
    headers = []
    for exchange, (method, params) in zip(exchanges, expected):
        require(set(exchange) == {'method', 'params', 'result'}, 'unexpected exchange envelope')
        require(exchange['method'] == method and exchange['params'] == params,
                'missing, reordered or substituted RPC request')
        result = exchange['result']
        if method == 'eth_chainId':
            require(result == '0x1', 'wrong chain')
        elif method == 'eth_getBlockByNumber':
            block = int(params[0], 16)
            headers.append(checked_header(result, block, START_HASH if block == START_BLOCK else END_HASH))
        else:
            tx = params[0]
            row = receipt_normalized(tx, events[tx], legacy_or_type2_receipt(result))
            require(row == receipts[tx], 'Tenderly/dRPC receipt mismatch: ' + tx)
            normalized.append(row)
    require(headers[:2] == headers[2:], 'anchor changed during acquisition')
    return {
        'schema_version': 1,
        'status': 'TENDERLY_VS_ORIGINAL_DRPC_127_RECEIPTS_MATCH',
        'source_event_zip_sha256': SOURCE_ARTIFACT_SHA256,
        'source_drpc_zip_sha256': DRPC_CHECKPOINT_SHA256,
        'drpc_original_workflow_overall_status': 'FAILURE_PARTIAL_CHECKPOINT_ONLY',
        'current_provider': {'operator': 'Tenderly', 'url': ENDPOINT},
        'reference_provider': 'dRPC',
        'anchors': headers[:2],
        'receipt_count': len(normalized),
        'liquidation_event_count': sum(row['liquidation_event_count'] for row in normalized),
        'provider_mismatch_count': 0,
        'gas_paid_wei': str(sum(int(row['total_gas_paid_wei']) for row in normalized)),
        'normalized_receipts_sha256': digest(b''.join(canonical(row) for row in normalized)),
        'raw_exchanges_sha256': digest(b''.join(canonical(row) for row in exchanges)),
        'non_blob_optional_field_rule': 'EXPLICIT_TYPE_0_OR_2_ZERO_BLOB_GAS_ONLY',
        'claim_scope': 'HISTORICAL_RECEIPT_PARITY_ONLY',
        'oracle_usd_prices_independently_verified': False,
        'complete_costs_verified': False,
        'decision_time_detection_proven': False,
        'nqc_capture_or_pnl_proven': False,
        'real_market_census_closed': False,
    }


def collect(source_zip: Path, drpc_zip: Path, out: Path, call=rpc, pause=time.sleep):
    _, _, ids = authenticated_drpc_checkpoint(drpc_zip, source_zip)
    require(not out.exists(), 'append-only acquisition output required')
    out.mkdir(parents=True)
    started = datetime.now(timezone.utc).isoformat()
    anchors = [('eth_getBlockByNumber', [hex(START_BLOCK), False]),
               ('eth_getBlockByNumber', [hex(END_BLOCK), False])]
    requests = [('eth_chainId', [])] + anchors
    requests += [('eth_getTransactionReceipt', [tx]) for tx in ids]
    requests += anchors
    exchanges = []
    try:
        with (out / 'exchanges.jsonl').open('xb') as stream:
            for method, params in requests:
                pause(0.35)
                result = call(ENDPOINT, method, params)
                row = {'method': method, 'params': params, 'result': result}
                stream.write(canonical(row)); stream.flush()
                exchanges.append(row)
        report = reconcile(source_zip, drpc_zip, exchanges)
    except Exception as error:
        report = {'schema_version': 1, 'status': 'ACQUISITION_OR_PARITY_BLOCKED',
                  'completed_exchanges': len(exchanges), 'error': str(error)[:400],
                  'provider': 'Tenderly', 'real_market_census_closed': False}
    report['acquisition_started_at'] = started
    report['acquisition_completed_at'] = datetime.now(timezone.utc).isoformat()
    (out / 'report.json').write_bytes(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event-zip', required=True, type=Path)
    parser.add_argument('--drpc-zip', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--replay-exchanges', type=Path)
    args = parser.parse_args()
    if args.replay_exchanges:
        require(not args.out.exists(), 'append-only verification output required')
        raw = args.replay_exchanges.read_bytes()
        if args.replay_exchanges.suffix == '.gz':
            raw = gzip.decompress(raw)
        require(len(raw) <= 8_000_000, 'exchange archive exceeds bounded corpus size')
        exchanges = [parse_json(line) for line in raw.splitlines()]
        report = reconcile(args.event_zip, args.drpc_zip, exchanges)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(canonical(report))
    else:
        report = collect(args.event_zip, args.drpc_zip, args.out)
    print(json.dumps(report, sort_keys=True))
    if report['status'] == 'ACQUISITION_OR_PARITY_BLOCKED':
        raise SystemExit(2)


if __name__ == '__main__':
    main()

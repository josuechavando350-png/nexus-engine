#!/usr/bin/env python3
"""Two-operator whole-pool executed-event incidence over the predeclared 7200 blocks.

This is a separate full-range producer, not promotion of the old 14 unfinished
shards and not proof that there were no unexecuted liquidatable positions.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import time

from rmc016_collect_winner_events import event
from rmc016_probe_historical_rpc import AAVE_POOL, LIQUIDATION_TOPIC, checked_header, rpc
from rmc016_winner_net_audit import canonical, digest, parse_json, require

ANCHOR = 26095351
ANCHOR_HASH = '0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781'
END = ANCHOR + 7200
WATCHLIST_SHA256 = 'e3c827033bec5fabd62701579a2b0e7d3f5cc5f5151659ee7e18a7d50fa7fdfb'
CONTROL_BLOCK = 25883783
CONTROL_TX = '0x26999547ac702620082e73079a77b062336c191773331e85dcd1ab33afc0b1ac'
PROVIDERS = (
    ('Nodies', 'https://ethereum-public.nodies.app', 50),
    ('Tenderly', 'https://gateway.tenderly.co/public/mainnet', 480),
)


def log_params(lo, hi):
    return [{'address': AAVE_POOL, 'topics': [LIQUIDATION_TOPIC],
             'fromBlock': hex(lo), 'toBlock': hex(hi)}]


def requests(width):
    anchors = [('eth_getBlockByNumber', [hex(ANCHOR), False]),
               ('eth_getBlockByNumber', [hex(END), False])]
    result = [('eth_chainId', [])] + anchors
    result += [('eth_getLogs', log_params(CONTROL_BLOCK, CONTROL_BLOCK))]
    result += [('eth_getLogs', log_params(lo, min(END, lo + width - 1)))
               for lo in range(ANCHOR + 1, END + 1, width)]
    return result + anchors


def check_provider(document):
    allowed = {name: (url, width) for name, url, width in PROVIDERS}
    require(document.get('operator') in allowed, 'unapproved provider operator')
    url, width = allowed[document['operator']]
    require(document.get('url') == url, 'operator endpoint mismatch')
    exchanges = document.get('exchanges')
    expected = requests(width)
    require(type(exchanges) is list and len(exchanges) == len(expected), 'incomplete coverage requests')
    headers = []; logs = []; controls = []
    for row, (method, params) in zip(exchanges, expected):
        require(set(row) == {'method', 'params', 'result'} and
                row['method'] == method and row['params'] == params,
                'coverage request gap, duplicate or alteration')
        result = row['result']
        if method == 'eth_chainId':
            require(result == '0x1', 'wrong chain')
        elif method == 'eth_getBlockByNumber':
            number = int(params[0], 16)
            require(type(result) is dict, 'header unavailable')
            expected_hash = ANCHOR_HASH if number == ANCHOR else result.get('hash')
            require(type(expected_hash) is str and re.fullmatch(r'0x[0-9a-f]{64}', expected_hash),
                    'end anchor hash absent')
            headers.append(checked_header(result, number, expected_hash))
        else:
            require(type(result) is list, 'RPC failure cannot become zero events')
            lo, hi = int(params[0]['fromBlock'], 16), int(params[0]['toBlock'], 16)
            normalized = [event(log, lo, hi) for log in result]
            if lo == CONTROL_BLOCK:
                require(len(normalized) == 1 and normalized[0]['transaction_hash'] == CONTROL_TX,
                        'known positive control was omitted or replaced')
                controls.extend(normalized)
            else:
                logs.extend(normalized)
    require(headers[:2] == headers[2:], 'canonical anchor changed during scan')
    logs.sort(key=lambda row: (row['block_number'], row['transaction_index'], row['log_index']))
    identities = [(row['block_hash'], row['log_index']) for row in logs]
    require(len(identities) == len(set(identities)), 'duplicate event')
    return {'operator': document['operator'], 'headers': headers[:2],
            'positive_control': controls, 'events': logs,
            'log_request_count': len(expected) - 6,
            'source_exchanges_sha256': digest(canonical(document))}


def cohort_membership(documents, watchlist):
    """Compare executed logs with the exact original privately rebuilt cohort."""
    require(digest(watchlist) == WATCHLIST_SHA256, 'original watchlist commitment mismatch')
    rows = [parse_json(line) for line in watchlist.splitlines()]
    accounts = {row['account'] for row in rows}
    require(len(rows) == len(accounts) == 857, 'original cohort size differs')
    matches = []
    # Caller has already reconciled both complete transcripts, including all
    # topics/data; read borrower topic only after this independent parity check.
    for exchange in documents[0]['exchanges'][4:-2]:
        for log in exchange['result']:
            borrower = '0x' + log['topics'][3][-40:].lower()
            matches.append({'transaction_hash': log['transactionHash'].lower(),
                            'block_number': int(log['blockNumber'], 16),
                            'log_index': int(log['logIndex'], 16),
                            'in_original_cohort': borrower in accounts})
    matches.sort(key=lambda row: (row['block_number'], row['log_index']))
    return {'original_cohort_size': 857, 'selection_block': ANCHOR,
            'watchlist_sha256': WATCHLIST_SHA256,
            'executed_events_in_original_cohort': sum(r['in_original_cohort'] for r in matches),
            'event_membership': matches,
            'future_winners_used_to_reselect_cohort': False,
            'unexecuted_eligible_positions_fully_enumerated': False}


def reconcile(documents, watchlist=None):
    require(type(documents) is list and len(documents) == 2, 'two independent operators required')
    results = [check_provider(d) for d in documents]
    require({r['operator'] for r in results} == {p[0] for p in PROVIDERS},
            'two independent operators required')
    a, b = results
    require(a['headers'] == b['headers'], 'independent anchor mismatch')
    require(a['positive_control'] == b['positive_control'], 'independent positive-control mismatch')
    require(a['events'] == b['events'], 'independent executed-event mismatch')
    report = {
        'schema_version': 1,
        'status': 'TWO_OPERATOR_FULL_7200_BLOCK_EXECUTED_INCIDENCE_RECONCILED',
        'scope': 'AAVE_V3_ETHEREUM_DECLARED_POOL_EXECUTED_LIQUIDATION_CALLS_ONLY',
        'predecessor_anchor': a['headers'][0], 'end_anchor': a['headers'][1],
        'first_block': ANCHOR + 1, 'last_block': END, 'covered_block_count': 7200,
        'executed_event_count': len(a['events']),
        'event_ledger_sha256': digest(b''.join(canonical(row) for row in a['events'])),
        'independent_operator_count': 2,
        'provider_evidence': [{k: r[k] for k in ('operator', 'log_request_count',
                                                'source_exchanges_sha256')} for r in results],
        'known_positive_control_consensus': True,
        'provider_mismatch_count': 0,
        'unexecuted_opportunity_absence_proven': False,
        'fixed_857_cohort_state_reconstructed_by_this_report': False,
        'prior_14_shard_artifacts_promoted': False,
        'terminal_rmc015_certified': False,
        'nqc_detection_capture_or_pnl_proven': False,
        'real_market_census_closed': False,
    }
    if watchlist is not None:
        report['fixed_857_cohort_executed_event_membership'] = cohort_membership(documents, watchlist)
    return report


def collect(out, call=rpc, pause=time.sleep):
    require(not out.exists(), 'append-only scan output required')
    out.mkdir(parents=True)
    started = datetime.now(timezone.utc).isoformat()
    documents = []
    try:
        for name, url, width in PROVIDERS:
            document = {'operator': name, 'url': url, 'exchanges': []}
            with (out / (name.lower() + '-exchanges.jsonl')).open('xb') as journal:
                for method, params in requests(width):
                    pause(0.65)
                    row = {'method': method, 'params': params, 'result': call(url, method, params)}
                    document['exchanges'].append(row)
                    journal.write(canonical(row)); journal.flush()
            # Validate each complete source before contacting the next one.
            check_provider(document)
            documents.append(document)
        report = reconcile(documents)
    except Exception as error:
        report = {'status': 'SOURCE_ACQUISITION_OR_RECONCILIATION_BLOCKED',
                  'error': str(error)[:400], 'complete_provider_count': len(documents),
                  'real_market_census_closed': False}
    (out / 'documents.json').write_bytes(canonical(documents))
    report['acquisition_started_at'] = started
    report['acquisition_completed_at'] = datetime.now(timezone.utc).isoformat()
    (out / 'report.json').write_bytes(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--replay', type=Path)
    parser.add_argument('--watchlist', type=Path, help='Exact private D08/D09 original cohort JSONL')
    args = parser.parse_args()
    require(args.watchlist is None or args.replay is not None, 'watchlist requires complete offline replay')
    if args.replay:
        require(not args.out.exists(), 'append-only report required')
        raw = args.replay.read_bytes()
        if args.replay.suffix == '.gz': raw = gzip.decompress(raw)
        require(len(raw) <= 8_000_000, 'bounded full-window evidence size exceeded')
        # Use the strict duplicate-key parser for nested provider JSON as well.
        documents = parse_json(b'{"documents":' + raw.strip() + b'}')['documents']
        report = reconcile(documents, args.watchlist.read_bytes() if args.watchlist else None)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(canonical(report))
    else:
        report = collect(args.out)
    print(json.dumps(report, sort_keys=True))
    if report['status'] == 'SOURCE_ACQUISITION_OR_RECONCILIATION_BLOCKED': raise SystemExit(2)


if __name__ == '__main__': main()

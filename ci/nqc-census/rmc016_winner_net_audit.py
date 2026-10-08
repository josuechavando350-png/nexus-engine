#!/usr/bin/env python3
"""Fail-closed RMC-016 winner-economics audit; does not certify Nexus capture.

Inputs are *exact GitHub artifact ZIP bytes* and one *pinned git blob* containing
historical aggregate observations. The optional per-transaction ledger is only
accepted when its raw SHA-256 matches the source's declared immutable ledger.

Zero external capital is a requirement, not a guess about gas or credit. This
program neither submits transactions nor derives capture probabilities.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile

WAD = 10**18
D15B_SHA256 = 'aff472236ff5177f123e4a6ccc95d4dae5fb37833f8645984116c407c179d790'
D16_SHA256 = '27bd8909f865429e6bbc4580adf52af985beab8ed45cc11850616ab53a02b199'
D16_PRODUCTION_BLOB_SHA = '5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa'
D15B_RUN = 37669899465
D16_RUN = 37673653265
D15B_ARTIFACT = 11504276505
D16_ARTIFACT = 11505504820
D16_ECONOMIC_SOURCE_HEAD = '96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a'
COSTS = (
    'protocol_fee', 'flash_premium', 'swap_fee', 'price_impact',
    'gas_base_fee', 'gas_priority_fee', 'gas_l1_data_fee',
    'builder_mev_payment', 'financing_cost', 'hedging_cost',
    'inventory_cost', 'failure_cost', 'revert_cost', 'opportunity_cost',
    'other_chain_cost',
)
GAS_COMPONENTS = ('gas_base_fee', 'gas_priority_fee', 'gas_l1_data_fee')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
TX_HASH = re.compile(r'^0x[0-9a-f]{64}$')


def require(ok: bool, msg: str) -> None:
    if not ok:
        raise ValueError(msg)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(obj: object) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def parse_json(data: bytes) -> dict:
    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    result = json.loads(data, object_pairs_hook=reject_duplicates)
    require(type(result) is dict, 'JSON root must be object')
    return result


def uint(value, label: str) -> int:
    require(type(value) is str and re.fullmatch(r'(?:0|[1-9][0-9]*)', value) is not None,
            f'{label}: required canonical integer string')
    return int(value)


def usd_wad(value: int) -> str:
    sign = '-' if value < 0 else ''
    value = abs(value)
    whole, frac = divmod(value, WAD)
    return f'{sign}{whole}.{frac:018d}'


def git_blob_hash(raw: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def verify_archive(path: Path, expected: str, expected_files: set[str]) -> dict[str, bytes]:
    require(path.is_file(), f'artifact missing: {path}')
    raw = path.read_bytes()
    require(digest(raw) == expected, f'artifact SHA-256 does not match immutable authority: {path.name}')
    with ZipFile(path) as z:
        names = z.namelist()
        require(len(names) == len(set(names)), 'duplicate ZIP member path')
        require(set(names) == expected_files | {'archive.sha256'}, 'artifact members differ from canonical set')
        for member in z.infolist():
            require(member.filename == Path(member.filename).name, 'ZIP paths are forbidden')
            require((member.external_attr >> 16) & 0o170000 != 0o120000, 'ZIP symlink forbidden')
        declared = z.read('archive.sha256').decode('ascii').splitlines()
        checked = set()
        for line in declared:
            require(re.fullmatch(r'[0-9a-f]{64}  [a-zA-Z0-9._-]+', line) is not None,
                    'noncanonical archive SHA256 line')
            sha, name = line.split('  ')
            require(name in expected_files and name not in checked, 'extra or duplicate archive entry')
            require(digest(z.read(name)) == sha, 'inner SHA256 mismatch: ' + name)
            checked.add(name)
        require(checked == expected_files, 'incomplete internal artifact SHA256 set')
        return {name: z.read(name) for name in expected_files}


def authenticated_baseline(d15_zip: Path, d16_zip: Path, economic_source: Path) -> tuple[dict, dict]:
    d15 = verify_archive(d15_zip, D15B_SHA256,
            {'rmc015b-production-evidence.json', 'rmc015b-temporal-opportunity-certificate.json'})
    d16 = verify_archive(d16_zip, D16_SHA256,
            {'rmc016-conservative-capacity-certificate.json'})
    raw_source = economic_source.read_bytes()
    require(git_blob_hash(raw_source) == D16_PRODUCTION_BLOB_SHA,
            'economic source content is not the exact pinned Git blob')
    a15 = parse_json(d15['rmc015b-production-evidence.json'])
    c15 = parse_json(d15['rmc015b-temporal-opportunity-certificate.json'])
    c16 = parse_json(d16['rmc016-conservative-capacity-certificate.json'])
    e16 = parse_json(raw_source)
    require(a15['status'] == 'RMC015_TEMPORAL_CONSERVATIVE_AUTHORITY_PASS', 'D15 production status')
    require(c15['status'] == 'RMC015_TEMPORAL_OPPORTUNITY_AUTHORITY_PASS', 'D15 certificate status')
    require(c16['status'] == 'RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS', 'D16 certificate status')
    require(e16['authority']['status'] == 'RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS', 'D16 aggregate status')
    require(a15['authority_commitment'] == c15['authority_commitment'] == c16['rmc015_authority_commitment'],
            'D15B -> D16 authority commitment chain mismatch')
    require(a15['window'] == c15['window'] == c16['window'] == e16['authority']['window'],
            'temporal window anchor mismatch')
    require(a15['source_authority_file_sha256'] == e16['authority']['inputs']['rmc015_temporal_authority_sha256'],
            'D16 aggregates do not bind the D15 temporal source authority')
    require(a15['source_snapshot'] == e16['source_snapshot'], 'different historical snapshot')
    n = a15['definite_liquidation_transaction_count']
    require(type(n) is int and n > 0 and n == c15['definite_liquidation_transaction_count']
            and n == e16['authority']['definite_transaction_count'], '127-winner conservation failed')
    require(type(a15['definite_liquidation_event_episode_count']) is int and
            a15['definite_liquidation_event_episode_count'] == e16['authority']['definite_episode_count'],
            '139-event conservation failed')
    require(c16['realized_nexus_pnl_proven'] is False and
            c16['capture_adjusted_capacity_claimed'] is False and
            c16['capture_probability'] == 'UNCALIBRATED' and
            c16['nqc_conservative_realizable_capacity_usd_wad'] == '0',
            'D16 made unsupported capture/capacity claim')
    require(e16['authority']['nqc_capture_probability_lower_bound_wad'] == '0' and
            e16['authority']['nqc_conservative_realizable_capacity_usd_wad'] == '0' and
            e16['authority']['month1_300k_target_proven'] is False,
            'economic aggregates claim Nexus profitability')
    require(a15['all_crossing_times_exactly_known'] is False and
            a15['censored_candidates_contribute_zero_capacity'] is True,
            'temporal source cannot claim uncensored completeness')
    gross = uint(e16['authority']['observed_market_gross_oracle_edge_usd_wad'], 'gross oracle edge')
    gas = uint(e16['authority']['observed_winner_gas_cost_usd_wad'], 'winner gas')
    require(gross > gas, 'observed gross/gas aggregate inconsistent with published baseline')
    require(uint(e16['authority']['observed_market_debt_principal_usd_wad'], 'principal') > 0,
            'observed principal must be positive')
    require(e16['authority']['transaction_economics_sha256'] != '0'*64 and
            HEX64.fullmatch(e16['authority']['transaction_economics_sha256']) is not None,
            'source transaction economics commitment missing')
    baseline = {
        'schema_version': 1,
        'status': 'AGGREGATE_AUTHENTICATED_TRANSACTION_LEDGER_MISSING',
        'truth_scope': 'AAVE_V3_ETHEREUM_HISTORICAL_WINNERS_ONLY',
        'source_scope': 'SNAPSHOT_DERIVED_AGGREGATE_NOT_INDEPENDENT_TX_REPLAY',
        'source_code_commit_d16': D16_ECONOMIC_SOURCE_HEAD,
        'd15_workflow_run_id': D15B_RUN,
        'd15_artifact_id': D15B_ARTIFACT,
        'd15_artifact_sha256': D15B_SHA256,
        'd16_workflow_run_id': D16_RUN,
        'd16_artifact_id': D16_ARTIFACT,
        'd16_artifact_sha256': D16_SHA256,
        'd16_economic_source_git_blob_sha1': D16_PRODUCTION_BLOB_SHA,
        'start_block': a15['window']['start_block'],
        'end_block': a15['window']['end_block'],
        'historical_winner_transaction_count': n,
        'historical_liquidation_event_count': a15['definite_liquidation_event_episode_count'],
        'historical_market_gross_oracle_edge_usd_wad': str(gross),
        'historical_winner_gas_usd_wad': str(gas),
        'gross_minus_observed_winner_gas_usd_wad': str(gross-gas),
        'historical_market_gross_oracle_edge_usd': usd_wad(gross),
        'historical_winner_gas_usd': usd_wad(gas),
        'gross_minus_observed_winner_gas_usd': usd_wad(gross-gas),
        'transaction_economics_source_sha256': e16['authority']['transaction_economics_sha256'],
        'per_transaction_economics_materialized': False,
        'all_execution_costs_reconciled': False,
        'independent_transaction_replay_complete': False,
        'nexus_capture_probability_calibrated': False,
        'nexus_realized_profitability_proven': False,
        'nexus_monthly_pnl_estimate_usd_wad': None,
        'nexus_conservative_realizable_capacity_usd_wad': '0',
        'monthly_target_300k_proven': False,
        'blocking_reasons': [
            'RAW_127_WINNER_TRANSACTION_ECONOMICS_NOT_PUBLISHED_IN_CERTIFIED_ARTIFACTS',
            'WINNER_TRANSACTION_COST_BASIS_NOT_INDEPENDENTLY_REPLAYED',
            'NEXUS_PRESTATE_EXECUTION_ROUTE_AND_EXTERNAL_GAS_NOT_CERTIFIED',
            'NEXUS_CAPTURE_PROBABILITY_UNCALIBRATED',
        ],
    }
    return baseline, e16


def validate_complete_winner_ledger(ledger: Path, summary: dict, source: dict) -> dict:
    expected_digest = source['authority']['transaction_economics_sha256']
    raw = ledger.read_bytes()
    require(digest(raw) == expected_digest, 'raw historical transaction ledger SHA256 differs from pinned authority')
    require(raw.endswith(b'\n') and raw, 'transaction JSONL must end in newline')
    rows = []
    seen = set()
    total_gross = total_gas = total_cost = 0
    for no, line in enumerate(raw.splitlines(), 1):
        row = parse_json(line)
        require(canonical(row).rstrip(b'\n') == line, f'noncanonical JSONL row {no}')
        txid = row.get('transaction_hash')
        require(type(txid) is str and TX_HASH.fullmatch(txid) is not None and txid not in seen,
                'missing, invalid or duplicated winner transaction hash')
        seen.add(txid)
        block = row.get('block_number')
        require(type(block) is int and summary['start_block'] <= block <= summary['end_block'],
                'winner transaction outside authenticated window')
        require(type(row.get('transaction_index')) is int and row['transaction_index'] >= 0,
                'missing transaction ordering')
        for k in ('pre_state_commitment','winner_receipt_sha256','transaction_economics_commitment'):
            require(type(row.get(k)) is str and HEX64.fullmatch(row[k]) is not None
                    and row[k] != '0'*64, 'missing independently bound source evidence: '+k)
        gross = uint(row.get('historical_oracle_gross_edge_usd_wad'), 'per-transaction gross')
        historical_gas = uint(row.get('historical_gas_paid_usd_wad'), 'per-transaction gas')
        require(type(row.get('costs')) is dict and set(row['costs']) == set(COSTS),
                'full 15-component cost taxonomy required')
        require(type(row.get('cost_evidence')) is dict and set(row['cost_evidence']) == set(COSTS),
                'every zero/nonzero cost must carry provenance')
        costs = {}
        for k in COSTS:
            costs[k] = uint(row['costs'][k], 'cost '+k)
            ev = row['cost_evidence'][k]
            require(type(ev) is str and HEX64.fullmatch(ev) is not None and ev != '0'*64,
                    'missing cost evidence including zero: '+k)
        require(sum(costs[k] for k in GAS_COMPONENTS) == historical_gas,
                'gas components fail receipt reconciliation')
        # Note: this is *observed market winner* accounting, not a Nexus route.
        total_gross += gross
        total_gas += historical_gas
        total_cost += sum(costs.values())
        rows.append({'transaction_hash':txid, 'gross_oracle_usd_wad':str(gross),
                     'all_explicit_costs_usd_wad':str(sum(costs.values())),
                     'winner_net_after_declared_costs_usd_wad':str(gross-sum(costs.values()))})
    require(len(rows) == summary['historical_winner_transaction_count'],
            'not exactly the authenticated winner-transaction universe')
    require(total_gross == int(summary['historical_market_gross_oracle_edge_usd_wad']),
            'raw winner gross does not reconcile to pinned historical sum')
    require(total_gas == int(summary['historical_winner_gas_usd_wad']),
            'raw winner gas does not reconcile to pinned historical sum')
    require(rows == sorted(rows,key=lambda x:x['transaction_hash']),
            'ledger transaction order must be canonical by hash')
    return {
        'winner_net_after_declared_costs_usd_wad': str(total_gross-total_cost),
        'winner_cost_sum_usd_wad':str(total_cost),
        'transaction_count':len(rows),
        'cost_fields_present_and_summed':True,
        'external_cost_witnesses_independently_replayed':False,
        'nexus_profitability_proven':False,
        'nexus_capture_probability_calibrated':False,
        'observed_winner_transactions':rows,
    }


def audit(d15_zip: Path, d16_zip: Path, source_file: Path,
          winner_ledger: Path | None = None) -> dict:
    report, source = authenticated_baseline(d15_zip, d16_zip, source_file)
    if winner_ledger is not None:
        detail = validate_complete_winner_ledger(winner_ledger, report, source)
        report['status'] = 'PER_TRANSACTION_LEDGER_ARITHMETIC_RECONCILED_EXTERNAL_EVIDENCE_PENDING'
        report['per_transaction_economics_materialized'] = True
        report['cost_fields_sum_reconciled'] = True
        report['all_execution_costs_reconciled'] = False
        report['winner_cost_accounting'] = detail
        report['blocking_reasons'] = [
            'INDEPENDENT_WINNER_REPLAY_AND_COST_BASIS_NOT_CHECKED_BY_THIS_MODEL',
            'NEXUS_PRESTATE_EXECUTION_ROUTE_AND_EXTERNAL_GAS_NOT_CERTIFIED',
            'NEXUS_CAPTURE_PROBABILITY_UNCALIBRATED',
        ]
    report['audit_commitment_sha256'] = digest(canonical(report))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--d15-archive', required=True, type=Path)
    parser.add_argument('--d16-archive', required=True, type=Path)
    parser.add_argument('--economic-source', required=True, type=Path)
    parser.add_argument('--winner-ledger', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = audit(args.d15_archive,args.d16_archive,args.economic_source,args.winner_ledger)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(canonical(result))
    print(result['status'],'audit_commitment_sha256='+result['audit_commitment_sha256'])


if __name__ == '__main__':
    main()

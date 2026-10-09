#!/usr/bin/env python3
"""Authenticate original partial-cost D16 rows without promoting them to net P&L.

This schema differs from a complete cost ledger. Its original bytes must remain
unchanged; unknown costs cannot be filled with zero to fit a later schema.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from rmc016_winner_net_audit import (
    TX_HASH, authenticated_baseline, canonical, digest, parse_json, require, uint,
)
from rmc_operator_gas_budget import gas_budget_stress, read_scenario

OMITTED_COSTS = [
    'LIQUIDATION_PROTOCOL_FEE_IF_NOT_ALREADY_NET_IN_EVENT', 'FLASH_OR_CAPITAL_FEE',
    'SWAP_FEE', 'PRICE_IMPACT',
    'PRIORITY_BUILDER_OR_MEV_PAYMENT_BEYOND_RECEIPT_EFFECTIVE_GAS',
    'HEDGING', 'FAILURE_REVERT', 'OPPORTUNITY_COST',
]
FIELDS = {
    'block_number', 'debt_principal_usd_wad', 'effective_gas_price_wei',
    'eth_price_base_units', 'event_count', 'gas_used',
    'gross_collateral_oracle_value_usd_wad',
    'gross_oracle_edge_minus_observed_winner_gas_usd_wad',
    'gross_oracle_edge_usd_wad', 'nqc_net_pnl_claimed',
    'observed_winner_gas_cost_usd_wad', 'omitted_costs', 'timestamp',
    'transaction_hash', 'transaction_index',
}


def signed(value, name):
    require(type(value) is str and re.fullmatch(r'(?:0|-?[1-9][0-9]*)', value) is not None,
            name + ': canonical signed integer required')
    return int(value)


def inspect_original_rows(raw: bytes, authority: dict) -> dict:
    require(digest(raw) == authority['transaction_economics_sha256'],
            'original transaction ledger SHA256 mismatch')
    require(raw and raw.endswith(b'\n'), 'original JSONL newline missing')
    rows = [parse_json(line) for line in raw.splitlines()]
    require(len(rows) == authority['definite_transaction_count'], 'transaction count mismatch')
    seen = set()
    order = []
    total_gas = total_gross = total_principal = total_events = positive = 0
    for line, row in zip(raw.splitlines(), rows):
        require(set(row) == FIELDS, 'unexpected original partial ledger fields')
        require(canonical(row).rstrip(b'\n') == line, 'noncanonical original row')
        tx = row['transaction_hash']
        require(type(tx) is str and TX_HASH.fullmatch(tx) is not None and tx not in seen,
                'invalid or duplicate transaction')
        seen.add(tx)
        for key in ('block_number', 'transaction_index', 'gas_used', 'event_count', 'timestamp'):
            require(type(row[key]) is int and row[key] >= 0, 'invalid integer ' + key)
        require(row['event_count'] > 0 and row['gas_used'] > 0, 'zero events or gas')
        require(authority['window']['start_block'] <= row['block_number'] <=
                authority['window']['end_block'], 'transaction outside pinned window')
        position = (row['block_number'], row['transaction_index'])
        require(not order or order[-1] < position, 'duplicate or unordered transaction position')
        order.append(position)
        require(row['omitted_costs'] == OMITTED_COSTS, 'omitted costs changed or erased')
        require(row['nqc_net_pnl_claimed'] is False, 'historical winner cannot become NQC profit')
        principal = uint(row['debt_principal_usd_wad'], 'principal')
        collateral = uint(row['gross_collateral_oracle_value_usd_wad'], 'collateral')
        gross = signed(row['gross_oracle_edge_usd_wad'], 'gross')
        require(collateral - principal == gross, 'collateral/principal arithmetic mismatch')
        price = uint(row['effective_gas_price_wei'], 'effective gas price')
        eth_price = uint(row['eth_price_base_units'], 'historical ETH oracle price')
        gas = uint(row['observed_winner_gas_cost_usd_wad'], 'observed gas')
        require(eth_price > 0 and price > 0, 'missing positive gas/ETH price')
        require(row['gas_used'] * price * eth_price // 10**8 == gas,
                'receipt/oracle gas arithmetic mismatch')
        residual = signed(row['gross_oracle_edge_minus_observed_winner_gas_usd_wad'], 'residual')
        require(residual == gross - gas, 'partial residual arithmetic mismatch')
        positive += residual > 0
        total_gas += gas
        total_gross += gross
        total_principal += principal
        total_events += row['event_count']
    require(total_events == authority['definite_episode_count'], 'event count mismatch')
    require(total_principal == int(authority['observed_market_debt_principal_usd_wad']),
            'principal sum mismatch')
    require(total_gross == int(authority['observed_market_gross_oracle_edge_usd_wad']),
            'gross sum mismatch')
    require(total_gas == int(authority['observed_winner_gas_cost_usd_wad']), 'gas sum mismatch')
    return {
        'transaction_ledger_sha256': digest(raw),
        'transaction_count': len(rows),
        'event_count': total_events,
        'gas_counted_once_per_transaction': True,
        'gross_oracle_edge_usd_wad': str(total_gross),
        'observed_winner_gas_usd_wad': str(total_gas),
        'partial_residual_after_winner_gas_usd_wad': str(total_gross - total_gas),
        'positive_partial_residual_transaction_count': positive,
        'nonpositive_partial_residual_transaction_count': len(rows) - positive,
        'omitted_costs': OMITTED_COSTS,
        'all_execution_costs_reconciled': False,
        'independent_receipt_oracle_replay_completed_by_this_verifier': False,
        'nqc_executable_or_capturable_transaction_count': None,
        'nqc_net_pnl_usd_wad': None,
    }


def audit(d15_zip: Path, d16_zip: Path, source_file: Path,
          original_ledger: Path, scenario_file: Path) -> dict:
    baseline, source = authenticated_baseline(d15_zip, d16_zip, source_file)
    detail = inspect_original_rows(original_ledger.read_bytes(), source['authority'])
    scenario_raw = scenario_file.read_bytes()
    scenario = read_scenario(scenario_raw)
    report = {
        'schema_version': 1,
        'status': 'ORIGINAL_PARTIAL_WINNER_LEDGER_RECOVERED_AND_RECONCILED',
        'historical_zero_capital_source_unmodified': True,
        'd16_source_blob': baseline['d16_economic_source_git_blob_sha1'],
        'd15_artifact_sha256': baseline['d15_artifact_sha256'],
        'd16_artifact_sha256': baseline['d16_artifact_sha256'],
        'window': source['authority']['window'],
        'original_ledger': detail,
        'current_evaluation_scenario': scenario,
        'current_evaluation_scenario_sha256': digest(scenario_raw),
        'gas_budget_sensitivity': gas_budget_stress(scenario, int(detail['observed_winner_gas_usd_wad'])),
        'recovery_proves_source_byte_identity_not_original_acquisition_quality': True,
        'nqc_capture_probability_calibrated': False,
        'nqc_realized_profitability_proven': False,
        'rmc011_terminal_closed': False,
        'real_market_census_closed': False,
        'remaining_blockers': [
            'INDEPENDENT_RECEIPT_ORACLE_AND_PRESTATE_REPLAY',
            'COMPLETE_ROUTE_FLASH_PROTOCOL_BUILDER_AND_FAILURE_COSTS',
            'NQC_CAUSAL_DETECTION_EXECUTION_AND_CAPTURE',
            'OPERATOR_NATIVE_GAS_BALANCE_AND_MAX_FEE_RESERVATION_NOT_VERIFIED',
            'D11_D12_D13_TERMINAL_AUTHORITIES_AND_D14_D17_CLOSEOUT',
        ],
    }
    report['report_sha256'] = digest(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('d15-archive', 'd16-archive', 'economic-source', 'original-ledger', 'scenario', 'out'):
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    require(not args.out.exists(), 'append-only report output required')
    result = audit(args.d15_archive, args.d16_archive, args.economic_source,
                   args.original_ledger, args.scenario)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(result))
    print(result['status'], result['report_sha256'])


if __name__ == '__main__':
    main()

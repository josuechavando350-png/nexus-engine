#!/usr/bin/env python3
"""NQC V2: read-only HF proximity triage. NOT liquidation or profit authority."""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

import sniper_readonly_observer as obs
import sniper_readonly_journal as journal

WAD = 10**18
NEAR_MAX = WAD + 2 * 10**14  # 2 basis points above Aave HF threshold
DECIMAL = re.compile(r'(?:0|[1-9][0-9]*)\Z')

class Rejected(ValueError):
    pass

def require(ok, why):
    if not ok: raise Rejected(why)

def uint(x, label):
    require(type(x) is str and DECIMAL.fullmatch(x) is not None,
            label + ': canonical integer expected')
    n = int(x)
    require(0 <= n < 2**256, label + ': amount overflows uint256')
    return n

def triage(folder):
    folder = Path(folder)
    require(folder.is_dir() and not folder.is_symlink(), 'journal directory invalid')
    file = folder / 'journal.jsonl'
    require(file.is_file() and not file.is_symlink(), 'source journal missing')
    try:
        rows, tip = journal.audit(file.read_bytes(), folder)
    except (journal.JournalError, OSError) as exc:
        raise Rejected('journal hash/lineage failure') from exc
    require(len(rows) >= 3, 'need at least three consecutive observations')
    rows = rows[-3:]
    snapshots = []
    for item in rows:
        snapshot_file = folder / item['snapshot_file']
        state = journal.parse_line(snapshot_file.read_bytes())
        require(
            type(state) is dict and state.get('schema_version') == 1
            and state.get('contract') == 'NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT'
            and state.get('status') == 'DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2'
            and type(state.get('provider_count')) is int
            and state['provider_count'] >= 2
            and type(state.get('successful_provider_ids')) is list
            and len(set(state['successful_provider_ids'])) == state['provider_count']
            and state.get('accounts_consistent_across_successful_endpoints') is True
            and state.get('independent_rpc_operator_authenticity_certified') is False
            and state.get('actual_liquidation_executed') is False
            and state.get('p2_shadow_certified') is False
            and state.get('rmc_closed') is False
            and state.get('commercial_score_upgrade') is False
            and state.get('nqc_realized_pnl_usd') == '0',
            'snapshot has missing quorum observations or forged commercial status'
        )
        header = state.get('pinned_block')
        require(type(header) is dict and type(header.get('number')) is int
                and type(header.get('timestamp')) is int
                and type(state.get('observed_epoch_seconds')) is int
                and 0 <= state['observed_epoch_seconds']-header['timestamp']
                       <= obs.STALENESS_SECONDS,
                'unverified historical timestamp')
        accounts = state.get('account_rows')
        require(type(accounts) is list and len(accounts) == len(obs.BORROWERS)
                and state.get('watched_borrower_count') == len(obs.BORROWERS),
                'borrower observations incomplete')
        seen = set()
        actual = 0
        for r in accounts:
            label = r.get('borrower_label')
            require(label in obs.BORROWERS and label not in seen
                    and r.get('borrower') == obs.BORROWERS[label]['address']
                    and r.get('identity_origin') == obs.BORROWERS[label]['origin'],
                    'borrower identity not authenticated')
            seen.add(label)
            acc = r.get('account')
            require(type(acc) is dict and set(acc) == set(obs.EXPECTED_FIELDS),
                    'ABI fields missing')
            hf = uint(acc['health_factor_wad'], 'HF')
            debt = uint(acc['total_debt_base'], 'debt')
            require(uint(acc['ltv_bps'], 'LTV') <= 10000
                    and uint(acc['liquidation_threshold_bps'], 'LT') <= 10000,
                    'Aave risk bounds invalid')
            is_below = debt > 0 and 0 < hf < WAD
            require(r.get('health_factor_below_one_with_debt') is is_below,
                    'borrower HF flag differs from exact integer data')
            actual += int(is_below)
        require(actual == state.get('hf_below_one_state_count_not_execution_admission'),
                'false source candidate count')
        snapshots.append(state)
    for prev, cur in zip(snapshots, snapshots[1:]):
        require(prev['pinned_block']['number'] < cur['pinned_block']['number']
                and prev['observed_epoch_seconds'] < cur['observed_epoch_seconds'],
                'source samples not strictly increasing')
    output = []
    for label, meta in obs.BORROWERS.items():
        rr = [next(row for row in s['account_rows']
                   if row['borrower_label'] == label) for s in snapshots]
        h = [uint(row['account']['health_factor_wad'], 'HF') for row in rr]
        debt = uint(rr[-1]['account']['total_debt_base'], 'debt')
        below = debt > 0 and 0 < h[-1] < WAD
        near = debt > 0 and WAD <= h[-1] <= NEAR_MAX
        declining = h[0] > h[1] > h[2]
        status = ('HF_LT_ONE_STATE_REQUIRES_SAME_BLOCK_REVALIDATION' if below
                  else 'PRETRIGGER_NEAR_ONE_DECLINING_WATCH_ONLY' if near and declining
                  else 'PRETRIGGER_NEAR_ONE_WATCH_ONLY' if near
                  else 'NOT_IN_HF_WATCH_BAND')
        output.append({
            'borrower_label': label, 'borrower': meta['address'],
            'hf_samples_wad': [str(v) for v in h],
            'latest_hf_headroom_bps_micro': str((h[-1]-WAD)*10**10//WAD),
            'three_sample_hf_declining': declining, 'status': status,
            'estimated_time_to_liquidation': None,
            'aave_liquidation_call_executed': False,
            'net_pnl_usd': None, 'competition_capture_proven': False
        })
    return {
        'schema_version': 1, 'contract': 'NQC_V2_READONLY_PRETRIGGER_HF_TRIAGE',
        'status': 'READ_ONLY_HF_TRIAGE_NOT_A_TRADE',
        'latest_blocks': [s['pinned_block']['number'] for s in snapshots],
        'immutable_journal_tip_sha256': tip,
        'borrowers_watched': len(obs.BORROWERS),
        'hf_near_threshold_watch_count': sum('PRETRIGGER_NEAR_ONE' in r['status']
                                             for r in output),
        'hf_below_one_state_candidates_only': sum(r['status'].startswith('HF_LT_ONE')
                                                   for r in output),
        'triage': output,
        'two_endpoint_agreement_not_independent_operator_certification': True,
        'all_intervening_block_ancestry_not_certified': True,
        'no_ex_ante_capture_or_expected_monthly_profit_claim': True,
        'no_live_transaction': True,
        'no_external_gas_sponsor_certified': True,
        'p2_shadow_certified': False,
        'rmc_closed': False,
        'commercial_score_upgrade': False,
        'nqc_realized_pnl_usd': '0'
    }

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--journal-dir', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    report = triage(args.journal_dir)
    args.out.write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
    print(report['status'], 'near', report['hf_near_threshold_watch_count'],
          'below_one', report['hf_below_one_state_candidates_only'])

if __name__ == '__main__':
    main()

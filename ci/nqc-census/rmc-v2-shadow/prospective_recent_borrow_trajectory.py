#!/usr/bin/env python3
"""Two-horizon read-only Aave risk observations for the *same* fresh Borrow cohort.

The cohort is selected ex-ante using Borrow event order, NOT by HF, future
liquidations or profitability. A prior block and current block are historical
canonical states; this measures variation, NOT arrival latency or MEV capture.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re

import prospective_recent_borrow_cohort as recent

HORIZON_BLOCKS = 12
MAX_TRAJECTORY_ACCOUNTS = 64
MAX_EXTRA_RPC_CALLS_PER_SOURCE = 70
MAX_COMBINED_READ_CALLS_PER_SOURCE = 270
DEC = re.compile(r'(?:0|[1-9][0-9]*)\Z')


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def strict_uint(v, name):
    need(type(v) is str and DEC.fullmatch(v) is not None,
         name + ' not canonical integer string')
    return int(v)


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def as_json(obj):
    return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True)+'\n').encode()


def incomplete(source_report, reason, attempts=None):
    return {
        'schema_version': 1,
        'status':'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE',
        'started_at_utc':iso_now(),
        'source_snapshot_status':source_report.get('status'),
        'reason':reason,
        'attempts':attempts or {},
        'source_snapshot':source_report,
        'not_a_complete_active_borrower_census':True,
        'prospective_capture_proven':False,
        'causal_oracle_driver_proven':False,
        'full_transaction_gas_verified':False,
        'native_gas_nonrecourse_sponsor_proven':False,
        'net_profit_verified':False,
        'RMC_closed':False,
        'P2_shadow_certified':False,
        'canary_live_authorized':False,
        'commercial_score_upgrade':False,
        'nqc_realized_pnl_usd':'0',
    }


def verify_parent(parent):
    need(type(parent) is dict and
         parent.get('status') == 'TWO_URL_RECENT_BORROW_COHORT_STATE_ONLY_NOT_P2' and
         parent.get('errors') == [] and
         parent.get('borrower_accounts_exact_two_url_parity') is True,
         'source cohort lacks verified two-URL risk state')
    cohort=parent.get('selected_source_cohort')
    need(type(cohort) is list and 1<=len(cohort)<=MAX_TRAJECTORY_ACCOUNTS,
         'empty/over-limit recent cohort')
    selection=parent.get('truncation')
    need(type(selection) is dict and
         selection.get('selected_receivers') == len(cohort) and
         selection.get('no_future_liquidation_outcome_used') is True and
         selection.get('selection_rule') in (
             'LATEST_48_DISTINCT_BORROW_ON_BEHALF_OF_BEFORE_HF',
             'LATEST_64_DISTINCT_BORROW_ON_BEHALF_OF_BEFORE_HF') and
         selection.get('excess_distinct_receivers_not_reconstructed') >= 0,
         'source cohort selection or truncation not audited')
    need(parent.get('recent_borrow_event_count_quorum',0) >= len(cohort) and
         parent.get('selected_recent_borrower_count_quorum') == len(cohort),
         'source event/borrower count mismatch')
    need(parent.get('source_verified_hf_lt_one_count') is not None and
         parent.get('real_full_transaction_gas_calibrated') is False and
         parent.get('route_feasibility_proven') is False and
         parent.get('competitive_capture_probability_calibrated') is False and
         parent.get('nonrecourse_sponsor_for_own_capital_zero_certified') is False and
         parent.get('shadow_P2_certified') is False and
         parent.get('RMC_closed') is False and
         parent.get('canary_live_authorized') is False and
         parent.get('commercial_score_upgrade') is False and
         parent.get('nqc_realized_pnl_usd') == '0',
         'source attempts to promote commercial authority')
    sr=parent.get('state_reports')
    need(type(sr) is dict and set(sr)=={'drpc','publicnode'} and
         sr['drpc']['status']==sr['publicnode']['status']=='COMPLETE_STATE' and
         sr['drpc']['accounts']==sr['publicnode']['accounts'] and
         len(sr['drpc']['accounts'])==len(cohort),
         'baseline state source parity differs')
    hashes=[c.get('borrower') for c in cohort]
    need(len(set(hashes))==len(hashes) and
         [x['borrower'] for x in sr['drpc']['accounts']]==hashes,
         'source risk account order mismatch')
    anchor=parent.get('anchor')
    need(type(anchor) is dict and
         anchor.get('inclusive_blocks')==recent.WINDOW_BLOCKS and
         type(anchor.get('last_block')) is int and
         type(anchor.get('first_block')) is int and
         anchor['last_block']-anchor['first_block']+1==recent.WINDOW_BLOCKS and
         anchor['last_block'] >= anchor['first_block']+HORIZON_BLOCKS and
         type(anchor.get('pinned_end_head')) is dict and
         anchor['pinned_end_head'].get('number')==anchor['last_block'],
         'invalid canonical base anchor')
    return cohort, sr['drpc']['accounts'], anchor


def trajectory(cohort, old_rows, new_rows, previous_height, current_height):
    need(type(cohort) is list and type(old_rows) is list and
         type(new_rows) is list and
         len(cohort)==len(old_rows)==len(new_rows) and
         1<=len(cohort)<=MAX_TRAJECTORY_ACCOUNTS,
         'trajectory missing complete source cohort')
    need(current_height-previous_height==HORIZON_BLOCKS,
         'non-pinned trajectory horizon')
    out=[]
    for select,prior,current in zip(cohort,old_rows,new_rows):
        who=select.get('borrower')
        need(who==prior.get('borrower')==current.get('borrower') and
             type(who) is str and
             re.fullmatch(r'0x[0-9a-f]{40}',who) is not None,
             'borrower identities/order mismatch')
        origin_height=select.get('latest_borrow_block')
        need(type(origin_height) is int and
             current_height >= origin_height and
             select.get('beneficiary_identity_from_indexed_topic_2') is True and
             select.get('hindsight_liquidator_selection_used') is False,
             'source borrower selected after outcome or without verified Borrow')
        a,b=prior.get('risk'),current.get('risk')
        need(type(a) is dict and type(b) is dict and
             type(prior.get('source_account_raw_sha256')) is str and
             type(current.get('source_account_raw_sha256')) is str and
             re.fullmatch(r'[0-9a-f]{64}',prior['source_account_raw_sha256']) and
             re.fullmatch(r'[0-9a-f]{64}',current['source_account_raw_sha256']),
             'missing/inadmissible borrower risk snapshots or raw commitments')
        ph, ch = strict_uint(a.get('health_factor_wad'),'prior HF'),\
                 strict_uint(b.get('health_factor_wad'),'current HF')
        pd, cd = strict_uint(a.get('total_debt_base_raw'),'prior debt'),\
                 strict_uint(b.get('total_debt_base_raw'),'current debt')
        d = ch-ph
        after_prior = origin_height>previous_height
        comparable=(not after_prior and pd>0 and cd>0 and ph>0 and ch>0)
        kind=('LATEST_BORROW_AFTER_PRIOR_HEAD_NO_COMPARABLE_TREND' if after_prior else
              'NO_CONSISTENT_POSITIVE_DEBT_HF_BASELINE' if not comparable else
              'DEBT_ACTIVE_HF_FELL_NO_CAUSE_ASSIGNED' if d<0 else
              'DEBT_ACTIVE_HF_ROSE_NO_CAUSE_ASSIGNED' if d>0 else
              'DEBT_ACTIVE_HF_UNCHANGED')
        out.append({
            'borrower':who,
            'latest_indexed_borrow_block':origin_height,
            'earlier_block':previous_height,
            'later_block':current_height,
            'earlier_total_debt_base_raw':str(pd),
            'later_total_debt_base_raw':str(cd),
            'earlier_hf_wad':str(ph),
            'later_hf_wad':str(ch),
            'hf_change_wad':str(d) if comparable else None,
            'comparable_borrower_hf_trajectory':comparable,
            'trajectory_class':kind,
            'earlier_risk_status':a.get('status'),
            'later_risk_status':b.get('status'),
            'later_state_hf_lt_one_only_not_route':(0<ch<recent.WAD and cd>0),
            'arbitrary_earlier_user_actions_not_reconstructed':True,
            'causal_oracle_price_change_proven':False,
            'first_seen_mempool_before_trigger_proven':False,
            'profitable_competitive_liquidation_proven':False,
            'source_previous_account_sha256':prior.get('source_account_raw_sha256'),
            'source_later_account_sha256':current.get('source_account_raw_sha256'),
        })
    return out


def derive(base_report, transport_factory=None):
    try:
        cohort, last_rows, anchor=verify_parent(base_report)
    except (Rejected,KeyError,TypeError) as exc:
        return incomplete(base_report,'BASELINE_SOURCE_INCOMPLETE_OR_INVALID:'+str(exc)[:190])
    last=anchor['last_block']
    previous=last-HORIZON_BLOCKS
    proof={}
    # One additional read-only historical snapshot per provider, pinned by
    # blockHash. Separate request budgets; cap combined source calls.
    for provider in ('drpc','publicnode'):
        rpc=recent.RPC(provider,transport_factory(provider) if transport_factory else None)
        row={'status':'INCOMPLETE_PREVIOUS_HEAD','provider':provider,'errors':[]}
        proof[provider]=row
        try:
            head=rpc.get_header(previous)
            previous_rows=recent.assess_accounts(rpc,head,cohort)
            reread=rpc.get_header(last)
            need(reread==anchor['pinned_end_head'],
                 'base current block reorged or wrong RPC source')
            row.update({'status':'PREVIOUS_STATE_CANONICAL',
                        'previous_head':head,'previous_rows':previous_rows,
                        'last_head_rechecked':reread})
        except Exception as exc:
            row['errors'].append({'kind':type(exc).__name__,
                                  'detail':str(exc).split('https://')[0][:200]})
        row['read_only_calls']=rpc.calls
        row['rpc_transcript']=rpc.transcript
        parent_calls=base_report['source_reports'][provider].get('rpc_call_count',0)
        row['total_calls_in_both_stages']=rpc.calls+parent_calls
        if rpc.calls>MAX_EXTRA_RPC_CALLS_PER_SOURCE or \
           row['total_calls_in_both_stages']>MAX_COMBINED_READ_CALLS_PER_SOURCE:
            row['status']='CAP_EXCEEDED'
            row['errors'].append({'kind':'REQUEST_CAP_EXCEEDED'})
    a,b=proof['drpc'],proof['publicnode']
    if not (a['status']==b['status']=='PREVIOUS_STATE_CANONICAL' and
            a['previous_head']==b['previous_head'] and
            a['previous_rows']==b['previous_rows']):
        return incomplete(base_report,'PREVIOUS_BLOCK_OR_ACCOUNT_SOURCE_INCOMPLETE_OR_MISMATCH',proof)
    try:
        calculated=trajectory(cohort,a['previous_rows'],last_rows,previous,last)
        need(len(calculated)==len(cohort),'trajectory row count changed')
    except (Rejected,KeyError,TypeError) as exc:
        return incomplete(base_report,'TRAJECTORY_IDENTITY_OR_STATE_FAILED:'+str(exc)[:190],proof)
    comparable=[x for x in calculated if x['comparable_borrower_hf_trajectory']]
    drops=[x for x in comparable if x['trajectory_class']=='DEBT_ACTIVE_HF_FELL_NO_CAUSE_ASSIGNED']
    rises=[x for x in comparable if x['trajectory_class']=='DEBT_ACTIVE_HF_ROSE_NO_CAUSE_ASSIGNED']
    result={
        'schema_version':1,
        'status':'TWO_URL_SAME_COHORT_TWO_BLOCK_HORIZONS_HF_TRENDS_NOT_EXECUTABLE',
        'source_snapshot':base_report,
        'previous_head':a['previous_head'],
        'current_head':anchor['pinned_end_head'],
        'block_gap':HORIZON_BLOCKS,
        'source_older_state':proof,
        'selected_borrowers_before_HF':len(cohort),
        'unreconstructed_distinct_borrowers_in_event_window':
            base_report['truncation']['excess_distinct_receivers_not_reconstructed'],
        'trajectories':calculated,
        'comparable_both_debt_active_hf_count':len(comparable),
        'hf_declining_without_causal_attribution_count':len(drops),
        'hf_rising_without_causal_attribution_count':len(rises),
        'hf_unchanged_count':sum(x['trajectory_class']=='DEBT_ACTIVE_HF_UNCHANGED'
                                 for x in comparable),
        'latest_borrow_after_previous_head_count':sum(x['trajectory_class']==
            'LATEST_BORROW_AFTER_PRIOR_HEAD_NO_COMPARABLE_TREND' for x in calculated),
        'verified_current_hf_lt_one_state_count':base_report['source_verified_hf_lt_one_count'],
        'prior_block_state_backfilled_after_recent_cohort_selection':True,
        'actual_two_distinct_wall_clock_time_observations_proven':False,
        'live_24h_continuous_sampling_proven':False,
        'same_transaction_prestate_witness_proven':False,
        'block_gap_is_not_local_mempool_lead_time':True,
        'same_account_source_not_complete_borrower_universe':True,
        'no_future_winner_selection':True,
        'oracle_driver_or_intervening_account_actions_reconciled':False,
        'actual_liquidation_executability_proven':False,
        'competitive_capture_proven':False,
        'full_cold_transaction_gas_measured':False,
        'native_gas_nonrecourse_sponsor_proven':False,
        'net_pnl_certified':False,
        'RMC_closed':False,
        'P2_shadow_certified':False,
        'canary_live_authorized':False,
        'commercial_score_upgrade':False,
        'nqc_realized_pnl_usd':'0',
    }
    return result


def collect(transport_factory=None,current_unix=None):
    parent=recent.collect(transport_factory=transport_factory,current_unix=current_unix)
    result=derive(parent,transport_factory=transport_factory)
    result['completed_at_utc']=iso_now()
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'fresh absolute report destination required')
    report=collect()
    with args.out.open('xb') as fd:fd.write(as_json(report))
    print(report['status'], 'selected',report.get('selected_borrowers_before_HF'),
          'hf_declining',report.get('hf_declining_without_causal_attribution_count'),
          'state_only_hf_lt1',report.get('verified_current_hf_lt_one_state_count'),
          'reason',report.get('reason'))
    return 0  # An incomplete source is valid evidence, not a trade or score promotion.


if __name__=='__main__':
    raise SystemExit(main())

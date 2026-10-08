#!/usr/bin/env python3
"""RMC015: certify exactly ONE independently sourced 480-block successor shard.

The full-window 14-shard runner repeatedly hit public Blockscout HTTP429.
This producer isolates a bounded shard so one provider failure does not
invalidate independent previously verified shards. Do not combine results
until a separate reauthenticator validates all fourteen immutable reports.

No Nexus capture, net profit, real-time intent or RMC terminal certification.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import rmc015_857_window_shard_continuation as upstream
import rmc015_857_full_cohort_multicall as cohort_source
import rmc015_post_anchor_causal_sampler as source


STATUS="RMC015_SINGLE_480_BLOCK_REAL_DUAL_ARCHIVE_SHARD_PASS_NOT_CENSUS"
ONE_SHARD_UNVERIFIED_BLOCKS=upstream.SHARD_SIZE*(upstream.TOTAL_SHARDS-2)


def need(p,msg):
    if not p:raise ValueError(msg)


def isolated_shard(summary,watchlist_blob,original_first,shard_index,*,
                   providers=None,call=upstream.rpc):
    lo,hi=upstream.bounded_shard(shard_index)
    rows=cohort_source.all_preselected(summary,watchlist_blob)
    members={x["account"] for x in rows}
    need(len(rows)==857 and len(members)==857,
         "original no-hindsight Aave cohort has missing or duplicated borrowers")
    original=upstream.verified_original_first(original_first,summary)
    providers=upstream.PROVIDER_PAIRS if providers is None else providers
    need(len(providers)==2 and
         [p[0] for p in providers]==list(upstream.PROVIDER_IDS) and
         providers[0][1]!=providers[1][1] and
         providers[0][2]!=providers[1][2],
         "independent source proven original historical operator quorum required")

    # Known unrelated, real historical win is used only to verify both
    # providers deliver non-empty events: NEVER for borrower selection.
    canary=upstream.positive_archive_log_canary(providers,call=call)
    predecessor=[]
    for pid,operator,url in providers:
        mediated=lambda u,m,a:upstream.authenticated_log_rpc(call,u,m,a,pid)
        predecessor.append(upstream.read_header(mediated,url,lo-1))
    need(predecessor[0]==predecessor[1],
         "independent RPCs disagree on canonical predecessor state and hash")
    previous_hash=predecessor[0]["hash"]
    proof,records=upstream.verify_one_shard(
        shard_index,members,previous_hash,providers=providers,call=call)
    need(proof["report_sha256"]==upstream.sha_json(
          {k:v for k,v in proof.items() if k!="report_sha256"}),
         "upstream dual-RPC shard result commitment mismatch")
    need(proof["start_block"]==lo and proof["end_block"]==hi
         and proof["start_parent_hash"]==previous_hash,
         "shard does not bind exact independently observed predecessor")
    need(proof["public_liquidation_event_count"]==len(records),
         "real public Aave event ledger/count disagreement")
    need(proof["matched_source_cohort_event_count"]<=len(records)
         and proof["original_cohort_member_count"]==857
         and proof["census_closed"] is False
         and proof["nqc_realized_profit_proven"] is False
         and proof["nqc_external_gas_nonrecourse_financing_proven"] is False,
         "upstream producer falsely promoted source cohort to realized revenue")
    # No full borrower/watchlist or raw competitor transaction addresses are
    # published; original input addresses stay local to the job.
    report={
        "schema_version":1,
        "status":STATUS,
        "ethereum_chain_id":1,
        "source_selection_block":source.ANCHOR,
        "source_selection_hash":source.ANCHOR_HASH,
        "fixed_original_857_source_borrower_count":857,
        "fixed_original_source_watchlist_sha256":summary["watchlist_commitment_sha256"],
        "original_first_480_source_certificate":original,
        "historical_positive_real_winner_log_source_check":canary,
        "real_two_operator_quorum_ids":[p[0] for p in providers],
        "independent_predecessor_state_root":predecessor[0]["state_root"],
        "independent_predecessor_hash":previous_hash,
        "shard_index":shard_index,
        "shard_source_start_block":lo,
        "shard_source_end_block":hi,
        "shard_source_end_hash":proof["end_block_hash"],
        "shard_verified_block_count":hi-lo+1,
        "single_shard_evidence_sha256":proof["report_sha256"],
        "true_executed_market_liquidation_event_count":proof["public_liquidation_event_count"],
        "source_857_cohort_executed_liquidation_event_count":proof["matched_source_cohort_event_count"],
        "source_cohort_unique_liquidated_borrowers_this_shard":
            proof["unique_source_cohort_borrowers_liquidated"],
        "public_liquidations_event_ledger_sha256":proof["public_events_sha256"],
        "cohort_matched_event_ledger_sha256":proof["matched_events_sha256"],
        "verified_first_plus_one_shard_block_count":upstream.SHARD_SIZE*2,
        "remaining_7200_blocks_not_independently_certified_by_this_report":
            ONE_SHARD_UNVERIFIED_BLOCKS,
        "original_fourteen_shards_all_reverified_and_joined":False,
        "no_future_winner_used_to_construct_cohort":True,
        "this_report_uses_retrospective_archive_reads":True,
        "source_historical_liquidation_event_is_not_profit_opportunity":True,
        "unexecuted_and_transient_eligible_positions_fully_enumerated":False,
        "zero_gas_capital_external_provider_authorized":False,
        "inclusion_and_execution_capture_probability_calibrated":False,
        "real_nexus_profit_usd":"0",
        "monthly_usd_15000_or_55000_target_certified":False,
        "rmc015_full_temporal_terminal_authority_closed":False,
        "real_market_census_closed":False,
    }
    report["report_sha256"]=upstream.sha_json(report)
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-summary",required=True,type=Path)
    p.add_argument("--watchlist-jsonl",required=True,type=Path)
    p.add_argument("--first-shard-report",required=True,type=Path)
    p.add_argument("--shard-index",required=True,type=int)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    need(not args.out.exists(),"append-only single-shard evidence file must not exist")
    output=isolated_shard(
        source.unique_json(args.source_summary.read_bytes()),
        args.watchlist_jsonl.read_bytes(),
        source.unique_json(args.first_shard_report.read_bytes()),
        args.shard_index)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(source.canonical(output))
    print(STATUS,"shard",args.shard_index,
          "block_range",output["shard_source_start_block"],
          output["shard_source_end_block"],
          "actual_market_events",output["true_executed_market_liquidation_event_count"],
          "matched_preselected_borrowers",
          output["source_857_cohort_executed_liquidation_event_count"],
          "NEXUS_PROFIT_USD=0","CENSUS_CLOSED=false")


if __name__=="__main__":
    main()

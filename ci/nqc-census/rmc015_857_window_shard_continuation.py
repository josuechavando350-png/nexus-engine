#!/usr/bin/env python3
"""RMC015 full observed successor LiquidationCall window, source-locked sharded continuation.

A real 857-member cohort is selected and frozen at Ethereum 26095351 from
independent original D08/D09 archives. PR650 independently verified first 480
blocks against two real RPC operators; this code authenticates that immutable
artifact, then scans 14 remaining consecutive 480-block shards. Each shard is
independently verified by dRPC and BlastAPI and is written as a content-hashed
checkpoint ONLY after both operators agree. Any mismatch/error prevents the
full-window report; earlier successful shards are never counted twice.

These are *observed LiquidationCall events*, NOT all HF<1 opportunities, live
capturability, externally financed gas or actual NQC P&L.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import rmc015_857_future_aave_liquidation_events as prior
import rmc015_857_full_cohort_multicall as parent
import rmc015_post_anchor_causal_sampler as source
from rmc016_probe_historical_rpc import rpc, PROVIDERS, LIQUIDATION_TOPIC

FIRST=source.FIRST
LAST=source.LATER
SHARD_SIZE=480
TOTAL_SHARDS=15
FIRST_DONE_END=FIRST+SHARD_SIZE-1
assert LAST-FIRST+1==SHARD_SIZE*TOTAL_SHARDS
SOURCE_PR=650
SOURCE_HEAD="c2d84ff6486202eb2a5810852e21e89b3ab5e2c5"
SOURCE_RUN=37807155179
SOURCE_ARTIFACT=11562554317
SOURCE_ZIP_SHA256="f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3"
SOURCE_GENESIS_REPORT="all-857-future-liquidation-events.json"
PROVIDER_IDS=("drpc","blast")
SOURCE_ISSUE="RMC015_857_DUAL_RPC_FULL_OBSERVED_EVENT_WINDOW_NOT_CAPTURE"
SHARD_STATUS="RMC015_SOURCE_LOCKED_INDEPENDENT_480_BLOCK_SHARD_NOT_CAPTURE"


def need(ok,message):
    if not ok:
        raise ValueError(message)


def sha_json(data):
    return source.sha(source.canonical(data))


def exact_bool(obj,k,expected):
    need(type(obj.get(k)) is bool and obj[k] is expected,
         "false promotion of authority: "+k)


def verified_original_first(report, summary):
    need(type(report) is dict and type(summary) is dict,
         "upstream shard or original summary not object")
    commitment=report.get("report_sha256")
    need(type(commitment) is str and commitment==sha_json({
          k:v for k,v in report.items() if k!="report_sha256"}),
         "PR650 original success report commitment invalid")
    required={
        "status": "RMC015_857_HISTORIC_REAL_POST_ANCHOR_EVENTS_VERIFIED_NOT_NQC_CAPTURE",
        "original_D09_selection_block":source.ANCHOR,
        "original_D09_selection_block_hash":source.ANCHOR_HASH,
        "event_window_start_block":FIRST,
        "event_window_end_block":FIRST_DONE_END,
        "event_scope":"FIRST_480_POST_ANCHOR_BLOCKS_ONLY",
        "full_source_cohort_size":857,
        "source_watchlist_commitment_sha256":
            summary.get("watchlist_commitment_sha256"),
        "source_frontier_authority_sha256":
            summary.get("authority_commitment_sha256"),
        "real_independent_operator_consensus":True,
        "real_aave_liquidation_logs_in_window_all_borrowers":0,
        "real_aave_liquidation_events_matching_source_cohort":0,
        "real_winner_tx_count_matching_source_cohort":0,
        "distinct_original_cohort_borrowers_liquidated_in_window":0,
        "uninspected_original_successor_blocks":6720,
    }
    for k,expected in required.items():
        need(report.get(k)==expected and
             (type(expected) is not bool or type(report.get(k)) is bool),
             "PR650 first source failed exact bound field "+k)
    operators=report.get("observed_successful_public_rpc_operator_ids")
    need(type(operators) is list and len(operators)==2
         and len(set(operators))==2
         and all(type(x) is str and x for x in operators)
         and all(any(p[0]==x for p in PROVIDERS) for x in operators),
         "PR650 first source did not establish two distinct known archive operator IDs")
    for k in ("full_7200_block_source_window_certified",
              "NQC_own_capital_zero_external_gas_authorized",
              "rmc015_terminal_authority_closed",
              "real_market_census_closed"):
        exact_bool(report,k,False)
    need(report.get("NQC_realized_profit_usd")=="0",
         "upstream first-shard misrepresented as Nexus P&L")
    # First PR650 source emitted the empty-event commitment of the exact
    # canonical empty byte stream and empty matched-event set.
    empty=source.sha(b"")
    need(report.get("all_liquidation_event_commitment_sha256")==empty
         and report.get("source_cohort_matched_event_commitment_sha256")==empty,
         "first-shard alleged zero events but its commitments are nonempty")
    return {
       "original_pr":SOURCE_PR, "original_commit":SOURCE_HEAD,
       "original_action_run":SOURCE_RUN,
       "original_artifact_id":SOURCE_ARTIFACT,
       "original_artifact_sha256":SOURCE_ZIP_SHA256,
       "source_report_sha256":commitment,
       "source_start":FIRST, "source_end":FIRST_DONE_END,
       "original_source_events":0,
       "original_matched_events":0,
       "independent_operator_consensus":True
    }


def bounded_shard(shard_index):
    need(type(shard_index) is int and 1<=shard_index<TOTAL_SHARDS,
         "shard must be one of the 14 remaining predefined segments")
    lo=FIRST+SHARD_SIZE*shard_index
    hi=lo+SHARD_SIZE-1
    need(FIRST_DONE_END<lo<=hi<=LAST,"shard escapes source window")
    return lo,hi


def read_header(call,url,n):
    hdr=parent.checked_header(
        call(url,"eth_getBlockByNumber",[hex(n),False]),n)
    need(type(hdr.get("state_root")) is str
         and type(hdr.get("timestamp")) is int
         and hdr["timestamp"]>0,"incomplete source Ethereum header")
    return hdr


def scan_one(provider, shard_index, members, expected_previous_hash,
             *,call=rpc,spacing=0):
    pid,operator,url=provider
    need(type(members) is set and len(members)==857,
         "entire original 857 source members needed")
    need(pid in PROVIDER_IDS,"unauthorized RPC operator in full-window scan")
    lo,hi=bounded_shard(shard_index)
    need(call(url,"eth_chainId",[])=="0x1","shard RPC not Ethereum")
    anchor=read_header(call,url,source.ANCHOR)
    need(anchor["hash"]==source.ANCHOR_HASH,
         "Aave original canonical borrower anchor changed")
    previous=read_header(call,url,lo-1)
    start=read_header(call,url,lo)
    end=read_header(call,url,hi)
    need(previous["hash"]==expected_previous_hash,
         "shard chain parent not equal to previously authenticated shard end")
    need(start["parent_hash"]==previous["hash"] and
         anchor["timestamp"]<previous["timestamp"]<start["timestamp"]<=end["timestamp"],
         "shard boundary not canonical consecutive Ethereum blocks")
    interval=prior.PROVIDER_SPANS.get(pid,SHARD_SIZE)
    need(1<=interval<=SHARD_SIZE and
         (pid!="blast" or interval<=10),
         "historical free RPC segment exceeds independently tested limit")
    records=[]
    seen=set()
    spans=[]
    for from_block in range(lo,hi+1,interval):
        to_block=min(from_block+interval-1,hi)
        raw=call(url,"eth_getLogs",[{
           "address":prior.AAVE_POOL,
           "topics":[LIQUIDATION_TOPIC],
           "fromBlock":hex(from_block),
           "toBlock":hex(to_block),
        }])
        need(type(raw) is list and len(raw)<10000,
             "archive returned incomplete/unbounded historical log partition")
        spans.append((from_block,to_block))
        for original_log in raw:
            e=prior.check_log(original_log,from_block,to_block)
            key=(e["block_hash"],e["tx"],e["log_index"])
            need(key not in seen,"duplicated event across a historical partition")
            seen.add(key)
            records.append(e)
        if spacing:
            time.sleep(spacing)
    need(spans[0][0]==lo and spans[-1][1]==hi
         and all(spans[i][1]+1==spans[i+1][0] for i in range(len(spans)-1)),
         "incomplete or overlapping intra-shard event range")
    for event_block in sorted({e["block"] for e in records}):
        hdr=read_header(call,url,event_block)
        need(all(e["block_hash"]==hdr["hash"] for e in records
                 if e["block"]==event_block),
             "event block hash is not actual canonical Ethereum header")
    records.sort(key=lambda x:(x["block"],x["tx_index"],x["log_index"],x["tx"]))
    event_bytes=b"".join(source.canonical(x) for x in records)
    relevant=[e for e in records if e["borrower"] in members]
    matched_bytes=b"".join(source.canonical(x) for x in relevant)
    return {
        "provider_id":pid,
        "operator":operator,
        "shard_index":shard_index,
        "start_block":lo,
        "end_block":hi,
        "end_block_hash":end["hash"],
        "start_parent_hash":previous["hash"],
        "log_range_count":len(spans),
        "public_events_count":len(records),
        "all_events_sha256":source.sha(event_bytes),
        "matched_cohort_events_count":len(relevant),
        "matched_event_sha256":source.sha(matched_bytes),
        "events":records,
    }


def verify_one_shard(shard_index,members,expected_previous_hash,
                     *,providers,call=rpc,spacing=0):
    need(len(providers)==2
         and [p[0] for p in providers]==list(PROVIDER_IDS)
         and providers[0][1]!=providers[1][1]
         and providers[0][2]!=providers[1][2],
         "two independently operated archive RPC endpoints required")
    a,b=[scan_one(p,shard_index,members,expected_previous_hash,
                  call=call,spacing=spacing)
         for p in providers]
    fields=("shard_index","start_block","end_block","end_block_hash",
            "start_parent_hash","public_events_count","all_events_sha256",
            "matched_cohort_events_count","matched_event_sha256","events")
    need(all(a[k]==b[k] for k in fields),
         "independent archive operators disagree on exact canonical event universe")
    matched=[r for r in a["events"] if r["borrower"] in members]
    report={
        "schema_version":1,
        "status":SHARD_STATUS,
        "original_cohort_selection_block":source.ANCHOR,
        "original_cohort_member_count":len(members),
        "shard_index":shard_index,
        "start_block":a["start_block"],
        "end_block":a["end_block"],
        "end_block_hash":a["end_block_hash"],
        "start_parent_hash":a["start_parent_hash"],
        "public_liquidation_event_count":a["public_events_count"],
        "matched_source_cohort_event_count":len(matched),
        "unique_source_cohort_borrowers_liquidated":len({x["borrower"] for x in matched}),
        "matched_source_cohort_unique_third_party_tx_count":len({x["tx"] for x in matched}),
        "public_events_sha256":a["all_events_sha256"],
        "matched_events_sha256":a["matched_event_sha256"],
        "verified_archive_operators":[p[0] for p in providers],
        "observed_public_events_not_all_liquidatable_positions":True,
        "entire_7200_block_window_certified_by_this_shard":False,
        "nqc_captured_third_party_liquidations":False,
        "nqc_external_gas_nonrecourse_financing_proven":False,
        "nqc_realized_profit_proven":False,
        "census_closed":False,
    }
    report["report_sha256"]=sha_json(report)
    return report,a["events"]


def whole_window(source_summary,watchlist_blob,original_first_report,
                 checkpoint_dir,*,providers=None,call=rpc,spacing=0):
    cohort=parent.all_preselected(source_summary,watchlist_blob)
    members={x["account"] for x in cohort}
    need(len(members)==857,"original 857 source borrowers were changed")
    first=verified_original_first(original_first_report,source_summary)
    if providers is None:
        providers=[next(p for p in PROVIDERS if p[0]==pid) for pid in PROVIDER_IDS]
    need(len(providers)==2 and [p[0] for p in providers]==list(PROVIDER_IDS)
         and providers[0][1]!=providers[1][1]
         and providers[0][2]!=providers[1][2],
         "full-window provider set not independent/exact original 2")
    need(not checkpoint_dir.exists() or
         (checkpoint_dir.is_dir() and not any(checkpoint_dir.iterdir())),
         "append-only run must start with an empty checkpoint directory")
    checkpoint_dir.mkdir(parents=True,exist_ok=True)

    previous=read_header(call,providers[0][2],FIRST_DONE_END)
    verification=read_header(call,providers[1][2],FIRST_DONE_END)
    need(previous==verification,
         "two real RPCs disagree on the original first 480-block canonical endpoint")
    prevhash=previous["hash"]
    checkpoints=[]
    all_events=[]
    seen=set()
    for i in range(1,TOTAL_SHARDS):
        report,records=verify_one_shard(
            i,members,prevhash,providers=providers,call=call,spacing=spacing)
        for x in records:
            key=(x["block_hash"],x["tx"],x["log_index"])
            need(key not in seen,"duplicate canonical liquidation event between shards")
            seen.add(key)
        all_events.extend(records)
        fp=checkpoint_dir/f"shard-{i:02d}.json"
        need(not fp.exists(),"prior verified shard checkpoint may not be overwritten")
        fp.write_bytes(source.canonical(report))
        print("IMMUTABLE_SHARD_PASS",i,report["start_block"],
              report["end_block"],report["public_liquidation_event_count"],
              report["matched_source_cohort_event_count"],flush=True)
        checkpoints.append(report)
        prevhash=report["end_block_hash"]
    need(len(checkpoints)==TOTAL_SHARDS-1
         and checkpoints[0]["start_block"]==FIRST_DONE_END+1
         and checkpoints[-1]["end_block"]==LAST
         and all(checkpoints[i]["end_block"]+1==checkpoints[i+1]["start_block"]
                 for i in range(len(checkpoints)-1)),
         "gaps in 14 independently witnessed successor shards")

    cohort_events=[e for e in all_events if e["borrower"] in members]
    distinct_public_txs={e["tx"] for e in all_events}
    distinct_matched_txs={e["tx"] for e in cohort_events}
    output={
        "schema_version":1,
        "status":SOURCE_ISSUE,
        "source_chosen_winners_as_selection_inputs":False,
        "original_857_members_selected_before_any_future_labels":True,
        "original_anchor_block":source.ANCHOR,
        "original_anchor_block_hash":source.ANCHOR_HASH,
        "source_857_watchlist_sha256":source_summary["watchlist_commitment_sha256"],
        "verified_original_first_480_source":first,
        "full_window_start_block":FIRST,
        "full_window_end_block":LAST,
        "verified_contiguous_480_block_shard_count":TOTAL_SHARDS,
        "verified_original_source_480_block_shards":1,
        "new_verified_independent_480_block_shards":len(checkpoints),
        "verified_total_block_count":SHARD_SIZE*TOTAL_SHARDS,
        "missing_original_window_block_count":0,
        "observed_ethereum_aave_liquidation_events_entire_window":
            len(all_events)+first["original_source_events"],
        "observed_unique_third_party_tx_hashes_in_new_14_shards":len(distinct_public_txs),
        "fixed_source_cohort_857_observed_liquidation_events_entire_window":
            len(cohort_events)+first["original_matched_events"],
        "fixed_source_cohort_857_unique_liquidated_accounts_entire_window":
            len({e["borrower"] for e in cohort_events}),
        "fixed_source_cohort_857_third_party_winner_tx_count":
            len(distinct_matched_txs),
        "original_and_successor_dual_rpc_persistent_operator_ids":
            [x[0] for x in providers],
        "all_events_new_shards_sha256":source.sha(b"".join(
            source.canonical(e) for e in all_events)),
        "all_cohort_matched_events_new_shards_sha256":source.sha(b"".join(
            source.canonical(e) for e in cohort_events)),
        "all_checkpoints":[
            {"index":r["shard_index"],"start_block":r["start_block"],
             "end_block":r["end_block"],"end_hash":r["end_block_hash"],
             "report_sha256":r["report_sha256"],
             "observed_events":r["public_liquidation_event_count"],
             "cohort_matched_events":r["matched_source_cohort_event_count"]}
            for r in checkpoints],
        "source_event_data_only_not_unexecuted_eligible_opportunities":True,
        "was_data_observed_live_during_historical_blocks":False,
        "probabilistic_capture_calibrated":False,
        "external_gas_nonrecourse_provider_authorized":False,
        "nqc_realized_profit_usd":"0",
        "nqc_revenue_15k_or_55k_monthly_certified":False,
        "rmc015_terminal_authority_closed":False,
        "real_market_census_closed":False,
        "original_stage_lock_was_modified":False,
    }
    output["report_sha256"]=sha_json(output)
    return output


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-summary",required=True,type=Path)
    p.add_argument("--watchlist-jsonl",required=True,type=Path)
    p.add_argument("--first-shard-report",required=True,type=Path)
    p.add_argument("--checkpoint-dir",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    need(not args.out.exists(),"all-event output must be append-only")
    output=whole_window(
        source.unique_json(args.source_summary.read_bytes()),
        args.watchlist_jsonl.read_bytes(),
        source.unique_json(args.first_shard_report.read_bytes()),
        args.checkpoint_dir,spacing=0.09)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(source.canonical(output))
    print(output["status"],"verified_blocks",
          output["verified_total_block_count"],"all_observed_events",
          output["observed_ethereum_aave_liquidation_events_entire_window"],
          "cohort_event_count",
          output["fixed_source_cohort_857_observed_liquidation_events_entire_window"],
          "NQC_REALIZED_PROFIT_USD=0","CENSUS_CLOSED=false")


if __name__=="__main__":
    main()

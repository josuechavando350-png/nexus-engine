#!/usr/bin/env python3
"""RMC015: 857 strictly prior-selected material borrowers vs real later Aave winners.

No retrospectively selected winner ever changes the source set. Read-only
public Ethereum LiquidationCall logs, dual independent operators, canonical
block headers and source fixed prehistory. Aggregates only; no account list.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
import rmc015_857_full_cohort_multicall as parent
import rmc015_post_anchor_causal_sampler as source
from rmc016_probe_historical_rpc import PROVIDERS, rpc, LIQUIDATION_TOPIC

START=source.FIRST
END=source.FIRST+479
CHUNK=480
FULL_ORIGINAL_END=source.LATER
ORIGINAL_TARGET_BLOCKS=7200
# BlastAPI free historical eth_getLogs limit is 10 blocks, observed at
# exact-head Actions 37804041633. Different real RPC operators may require
# different segment sizes, but must agree on the COMPLETE normalized log set.
PROVIDER_SPANS={"blast":10}
AAVE_POOL=source.POOL
HEX32=re.compile(r"0x[0-9a-f]{64}\Z")
DATA4=re.compile(r"0x[0-9a-f]{256}\Z")
TOPIC_ADDR=re.compile(r"0x0{24}[0-9a-f]{40}\Z")


def need(ok,msg):
    if not ok:raise ValueError(msg)


def check_log(log,lo,hi):
    need(type(log) is dict and str(log.get("address","")).lower()==AAVE_POOL,
         "source non-Aave liquidation")
    topics=log.get("topics")
    need(type(topics) is list and len(topics)==4 and
         all(type(x) is str and HEX32.fullmatch(x.lower()) for x in topics),
         "LiquidationCall indexed topics malformed")
    topics=[t.lower() for t in topics]
    need(topics[0]==LIQUIDATION_TOPIC and
         all(TOPIC_ADDR.fullmatch(t) for t in topics[1:]),
         "invalid indexed Aave liquidation/borrower")
    addr="0x"+topics[3][-40:]
    need(addr!="0x"+"0"*40,"Aave borrower cannot be zero")
    data=log.get("data")
    need(type(data) is str and DATA4.fullmatch(data.lower()),
         "real Aave LiquidationCall four data words required")
    nums=[int(data[2+i*64:2+(i+1)*64],16) for i in range(4)]
    # Aave V3 ABI data: debtToCover, liquidatedCollateralAmount,
    # liquidator address, receiveAToken encoded as uint256 bool 0/1.
    need(nums[0]>0 and nums[1]>0 and nums[3] in (0,1)
         and nums[2]>0 and nums[2] <2**160,
         "invalid integer Aave liquidation amounts/actor/receiveAToken")
    bn=source.inthex(log.get("blockNumber"),"block")
    need(lo<=bn<=hi,"eth_getLogs event outside requested range")
    tx=log.get("transactionHash")
    bh=log.get("blockHash")
    need(type(tx) is str and HEX32.fullmatch(tx.lower()) is not None and
         type(bh) is str and HEX32.fullmatch(bh.lower()) is not None,
         "Aave event tx/block missing")
    index=source.inthex(log.get("logIndex"),"logIndex")
    tx_index=source.inthex(log.get("transactionIndex"),"txIndex")
    need(log.get("removed") is False,
         "removed/reorg Aave event may not enter canonical economics")
    return {
       "block":bn,"block_hash":bh.lower(),"tx":tx.lower(),
       "log_index":index,"tx_index":tx_index,
       "borrower":addr,
       "collateral_asset":topics[1][-40:],"debt_asset":topics[2][-40:],
       "debt_to_cover_raw":str(nums[0]),
       "collateral_liquidated_raw":str(nums[1]),
       "liquidator":f"0x{nums[2]:040x}",
       "receive_a_token":bool(nums[3])
    }


def fetch_one(provider,source_members,*,call=rpc):
    pid,operator,url=provider
    need(call(url,"eth_chainId",[])=="0x1","liquidation RPC wrong Ethereum chain")
    anchor=parent.checked_header(call(url,"eth_getBlockByNumber",[hex(source.ANCHOR),False]),source.ANCHOR)
    need(anchor["hash"]==source.ANCHOR_HASH,"source D09 anchor reorg")
    a=parent.checked_header(call(url,"eth_getBlockByNumber",[hex(START),False]),START)
    b=parent.checked_header(call(url,"eth_getBlockByNumber",[hex(END),False]),END)
    need(a["parent_hash"]==source.ANCHOR_HASH and
         a["timestamp"]>anchor["timestamp"] and b["timestamp"]>a["timestamp"],
         "future events cannot select source accounts")
    results=[]
    seen=set()
    coverage=[]
    segment=PROVIDER_SPANS.get(pid,CHUNK)
    need(1<=segment<=CHUNK,"unsafe log span")
    for lo in range(START,END+1,segment):
        hi=min(lo+segment-1,END)
        raw=call(url,"eth_getLogs",[{
            "address":AAVE_POOL,"topics":[LIQUIDATION_TOPIC],
            "fromBlock":hex(lo),"toBlock":hex(hi)
        }])
        need(type(raw) is list and len(raw)<10000,
             "Aave segmented logs not complete/fail-open provider")
        coverage.append([lo,hi])
        for log in raw:
            item=check_log(log,lo,hi)
            identity=(item["block_hash"],item["tx"],item["log_index"])
            need(identity not in seen,"duplicated Aave event receipt in partition")
            seen.add(identity)
            results.append(item)
    need(coverage[0][0]==START and coverage[-1][1]==END
         and all(coverage[i][1]+1==coverage[i+1][0]
                 for i in range(len(coverage)-1)),
         "segmented Ethereum event-range coverage gap")
    blocks={n:parent.checked_header(call(url,"eth_getBlockByNumber",[hex(n),False]),n)
            for n in sorted({r["block"] for r in results})}
    need(all(blocks[r["block"]]["hash"]==r["block_hash"] for r in results),
         "Aave event's historical block hash disagrees with canonical header")
    results.sort(key=lambda x:(x["block"],x["tx_index"],x["log_index"],x["tx"]))
    tx_to_block={}
    for row in results:
        earlier=tx_to_block.setdefault(row["tx"],row["block_hash"])
        need(earlier==row["block_hash"],
             "one real transaction hash cannot appear in multiple canonical blocks")
    # The FULL public outcome commitment includes normalized all-Aave
    # LiquidationCalls, not just our conveniently matched shortlist.
    digest=source.sha(b"".join(source.canonical(x) for x in results))
    matched=[x for x in results if x["borrower"] in source_members]
    matched_txs={r["tx"] for r in matched}
    matched_borrowers={r["borrower"] for r in matched}
    distributions={}
    for item in matched:
        k=("SAME_ASSET" if item["collateral_asset"]==item["debt_asset"]
           else "CROSS_ASSET")
        distributions[k]=distributions.get(k,0)+1
    return {
        "provider_id":pid,"operator":operator,
        "source_anchor_hash":anchor["hash"],
        "start_hash":a["hash"],"end_hash":b["hash"],
        "canonical_raw_event_count":len(results),
        "canonical_public_event_commitment_sha256":digest,
        "realized_cohort_event_count":len(matched),
        "realized_cohort_unique_winning_transactions":len(matched_txs),
        "realized_cohort_unique_borrowers":len(matched_borrowers),
        "realized_cohort_event_types":dict(sorted(distributions.items())),
        # sorted hashed matched identities, not original wallet addresses.
        "matched_cohort_event_commitment_sha256":
           source.sha(b"".join(source.canonical(x) for x in matched)),
        "strict_source_verified_contiguous_partitions":len(coverage),
        "canonical_nonempty_event_block_headers_verified":len(blocks),
        "event_data_from_only_post_anchor_blocks":True,
    }


def independently_supported_archives(*,call=rpc,candidates=None):
    """Reject historical log-limited free RPCs before claiming any full-window census.

    First scoped historical blocks are a real provider capability preflight;
    the full 7200-block original window is NOT attempted or certified here.
    No paid endpoint, API key, account signup or historical-result fallback.
    """
    order=("drpc","blast","blockscout","publicnode","llama","blockpi")
    if candidates is None:
        candidates=[next(p for p in PROVIDERS if p[0]==name) for name in order]
    need(len(candidates)>=2 and
         len({p[0] for p in candidates})==len(candidates) and
         len({p[1] for p in candidates})==len(candidates) and
         len({p[2] for p in candidates})==len(candidates),
         "preflight candidate providers not independently identified")
    selected=[]
    rejected=[]
    lo=START
    for p in candidates:
        pid,operator,url=p
        try:
            need(call(url,"eth_chainId",[])=="0x1","not Ethereum")
            hdr=parent.checked_header(
                call(url,"eth_getBlockByNumber",[hex(START),False]),START)
            need(hdr["parent_hash"]==source.ANCHOR_HASH,
                 "provider source predecessor hash mismatch")
            hi=min(lo+PROVIDER_SPANS.get(pid,CHUNK)-1,END)
            raw=call(url,"eth_getLogs",[{
                "address":AAVE_POOL,"topics":[LIQUIDATION_TOPIC],
                "fromBlock":hex(lo),"toBlock":hex(hi)}])
            need(type(raw) is list and len(raw)<10000,
                 "provider cannot supply bounded historical event logs")
            for item in raw: check_log(item,lo,hi)
            selected.append(p)
        except Exception as error:
            rejected.append({"provider_id":pid,
                             "operator":operator,
                             "reason":"HISTORICAL_LOGS_NOT_AUTHENTICATABLE_ON_PUBLIC_RPC",
                             "error_type":type(error).__name__,
                             "detail":str(error)[:180]})
        if len(selected)==2:
            break
    need(len(selected)==2 and selected[0][1]!=selected[1][1],
         "two independent public archive RPCs with actual historic logs unavailable: "+
         json.dumps(rejected,sort_keys=True))
    return selected,rejected


def assess(summary,watchlist_blob,*,call=rpc,providers=None):
    original=parent.all_preselected(summary,watchlist_blob)
    members={r["account"] for r in original}
    need(len(members)==857,"source fixed cohort missing accounts")
    if providers is None:
        providers,rejections=independently_supported_archives(call=call)
    else:
        rejections=[]
    need(len(providers)==2 and providers[0][0]!=providers[1][0] and
         providers[0][1]!=providers[1][1] and providers[0][2]!=providers[1][2],
         "two independent historical RPC operators/endpoints mandatory")
    a,b=[fetch_one(x,members,call=call) for x in providers]
    fields=( "source_anchor_hash","start_hash","end_hash",
             "canonical_raw_event_count","canonical_public_event_commitment_sha256",
             "realized_cohort_event_count","realized_cohort_unique_winning_transactions",
             "realized_cohort_unique_borrowers","realized_cohort_event_types",
             "matched_cohort_event_commitment_sha256",
             "canonical_nonempty_event_block_headers_verified")
    need(all(a[k]==b[k] for k in fields),
         "two independently observed Ethereum liquidation event universes disagree")
    report={
       "schema_version":1,
       "status":"RMC015_857_HISTORIC_REAL_POST_ANCHOR_EVENTS_VERIFIED_NOT_NQC_CAPTURE",
       "real_ethereum_chain_id":1,
       "original_D09_selection_block":source.ANCHOR,
       "original_D09_selection_block_hash":source.ANCHOR_HASH,
       "original_857_members_selected_without_winner_hindsight":True,
       "full_source_cohort_size":len(members),
       "source_watchlist_commitment_sha256":summary["watchlist_commitment_sha256"],
       "source_frontier_authority_sha256":summary["authority_commitment_sha256"],
       "event_window_start_block":START,
       "event_window_end_block":END,
       "fully_segmented_Aave_LiquidationCall_event_window":True,
       "event_scope":"FIRST_480_POST_ANCHOR_BLOCKS_ONLY",
       "full_7200_block_source_window_certified":False,
       "uninspected_original_successor_blocks":FULL_ORIGINAL_END-END,
       "original_successor_window_expected_blocks":ORIGINAL_TARGET_BLOCKS,
       "event_chunks_per_provider":{
          a["provider_id"]:a["strict_source_verified_contiguous_partitions"],
          b["provider_id"]:b["strict_source_verified_contiguous_partitions"],
       },
       "real_aave_liquidation_logs_in_window_all_borrowers":a["canonical_raw_event_count"],
       "real_aave_liquidation_events_matching_source_cohort":a["realized_cohort_event_count"],
       "real_winner_tx_count_matching_source_cohort":a["realized_cohort_unique_winning_transactions"],
       "distinct_original_cohort_borrowers_liquidated_in_window":a["realized_cohort_unique_borrowers"],
       "matched_event_type_counts":a["realized_cohort_event_types"],
       "all_liquidation_event_commitment_sha256":a["canonical_public_event_commitment_sha256"],
       "source_cohort_matched_event_commitment_sha256":a["matched_cohort_event_commitment_sha256"],
       "real_independent_operator_consensus":True,
       "observed_successful_public_rpc_operator_ids":[a["provider_id"],b["provider_id"]],
       "refused_other_public_rpc_operators":rejections,
       "paid_archive_rpc_credentials_or_services_used":False,
       "winners_are_third_parties_not_NQC":True,
       "matched_winners_profit_after_builder_inclusion_proven":False,
       "short_lived_unexecuted_liquidatable_opportunities_exhaustive":False,
       "time_of_first_eligibility_seen_by_NQC_real_time":False,
       "NQC_own_capital_zero_external_gas_authorized":False,
       "NQC_realized_profit_usd":"0",
       "NQC_probability_15k_or_55k_monthly_certified":False,
       "rmc015_terminal_authority_closed":False,
       "rms_future_event_window_complete_for_7200_blocks":False,
       "real_market_census_closed":False,
       "non_claims":[
           "FUTURE_WINNER_DOES_NOT_ENTER_ANCHOR_SELECTION",
           "ACTUAL_LIQUIDATION_EVENT_ONLY_NOT_PROOF_OF_POTENTIALLY_MISSED_OPPORTUNITIES",
           "NO_REALTIME_HAZARD_SIGNAL_FROM_ARCHIVE_QUERY",
           "EVENT_MATCH_NOT_AMOUNT_AVAILABLE_TO_NQC",
           "NO_BUILDER_BID_SVRECAPTURE_OR_NET_LIQUIDATOR_PNL",
           "NO_NQC_GAS_SPONSOR_OR_LIVE_TRADE",
       ]
    }
    report["report_sha256"]=source.sha(source.canonical(report))
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-summary",type=Path,required=True)
    p.add_argument("--watchlist-jsonl",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    need(not a.out.exists(),"append-only original successor event result required")
    s=source.unique_json(a.source_summary.read_bytes())
    r=assess(s,a.watchlist_jsonl.read_bytes())
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(source.canonical(r))
    print(r["status"],"observed_market_events",
          r["real_aave_liquidation_logs_in_window_all_borrowers"],
          "cohort_matched_liquidations",
          r["real_aave_liquidation_events_matching_source_cohort"],
          "cohort_unique_liquidated_borrowers",
          r["distinct_original_cohort_borrowers_liquidated_in_window"],
          "NQC_Net",r["NQC_realized_profit_usd"],"CENSUS_CLOSED=false")


if __name__=="__main__":
    main()

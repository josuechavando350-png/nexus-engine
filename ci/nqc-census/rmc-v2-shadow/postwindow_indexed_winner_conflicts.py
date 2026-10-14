#!/usr/bin/env python3
"""Aave indexed competitor winner/market census: historical hints, NOT Nexus P&L.

Only accept original Blockscout Actions ZIP and both unmodified source responses.
Deduplicate actual transaction hashes across pair/event rows; a multi-event
winning transaction never represents several independent gas-paid captures.
No chain-quorum, completeness, route profitability or P2 authority.
"""
from __future__ import annotations
from collections import defaultdict
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import argparse
import json
import zipfile
import blockscout_aave_89390_indexed_research as source

ZIP_SHA="b3d82ccd21cd683424b99c020732d2e2978ce2981a51b46df177a2d22c7bb722"
ORIGINAL_SHA="11b6c32acababce04fe653b92222d9fec480f76dc8f9bc51c17f0f0a9a561924"
POST_SHA="4cac41e47df4f59e6d08cacb201a39d8e788690d7c50e94c7c5e32e535262c59"
ARTIFACT_ID=11860545203
ORIGINAL_RUN_ID=38487719497
ORIGINAL_HEAD="ccd91241ceaa342ed40767be8104860fd4886715"
KNOWN_EVENTS=53
KNOWN_TX=47
KNOWN_PAIRS=21
MAX_ARTIFACT=2_000_000

class Rejected(ValueError):pass
def need(condition,reason):
    if not condition:raise Rejected(reason)
def sha(data):return sha256(data).hexdigest()
def canon(value):
    return (json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def authenticate_archive(body):
    need(type(body) is bytes and len(body)<=MAX_ARTIFACT,"unbounded artifact")
    need(sha(body)==ZIP_SHA,"upstream GitHub Actions artifact SHA256 mismatch")
    try:
        with zipfile.ZipFile(BytesIO(body)) as z:
            names=z.namelist()
            need(len(names)==len(set(names)),"duplicate archive file names")
            wanted=("raw-old-rmc016-indexer.json",
                    "raw-new-postwindow-indexer.json",
                    "indexed-postwindow-research.json")
            need(all(n in names and z.getinfo(n).file_size<=250_000
                     for n in wanted),"missing/oversized source response")
            old,new,research=(z.read(n) for n in wanted)
    except (zipfile.BadZipFile,EOFError,OSError,RuntimeError) as e:
        raise Rejected("unreadable upstream artifact") from e
    need(sha(old)==ORIGINAL_SHA and sha(new)==POST_SHA,
         "immutable original/new source response mismatch")
    a,b,p=(source.strict_json(s) for s in (old,new,research))
    need(p.get("original_source_response_sha256")==sha(old) and
         p.get("new_source_response_sha256")==sha(new) and
         p.get("indexer_full_event_completeness_certified") is False and
         p.get("postwindow_full_RPC_two_operator_quorum") is False and
         p.get("nqc_realized_pnl_usd")=="0",
         "source provenance/evidence scope mismatch")
    baseline=source.classify(a,source.BASE_START,source.BASE_END,require_any=True)
    need(len(baseline)==139 and
         len({x["tx_hash"] for x in baseline})==127,
         "original 139/127 positive-control corpus missing")
    source.require_rank1(baseline)
    result=source.classify(b,source.POST_START,source.POST_END,require_any=True)
    need(len(result)==KNOWN_EVENTS and
         len({x["tx_hash"] for x in result})==KNOWN_TX,
         "postwindow indexer row cardinality changed")
    return result

def rank(rows):
    need(type(rows) is list and len(rows)>0 and len(rows)<source.MAX_LOGS,
         "missing or capped event evidence")
    pairs=defaultdict(list);transactions=defaultdict(list);events_seen=set()
    for x in rows:
        need(type(x) is dict and type(x.get("block")) is int and
             source.POST_START<=x["block"]<=source.POST_END,
             "event block outside anchored interval")
        need(type(x.get("tx_hash")) is str and
             len(x["tx_hash"])==66 and x["tx_hash"].startswith("0x"),
             "unavailable transaction identity")
        need(type(x.get("log_index")) is int and x["log_index"]>=0 and
             type(x.get("transaction_index")) is int and x["transaction_index"]>=0,
             "invalid event ordering")
        need(type(x.get("borrower_sha256")) is str and
             len(x["borrower_sha256"])==64,"borrower commitment missing")
        ca,db=x.get("collateral_asset"),x.get("debt_asset")
        need(type(ca) is str and type(db) is str and
             len(ca)==42 and len(db)==42,"invalid pair identities")
        identity=(x["block"],x["tx_hash"],x["log_index"])
        need(identity not in events_seen,"duplicate winner event identity")
        events_seen.add(identity)
        pairs[(ca,db)].append(x);transactions[x["tx_hash"]].append(x)
    market_rows=[]
    for (ca,db),items in pairs.items():
        unique_txs=sorted({a["tx_hash"] for a in items})
        market_rows.append({
            "collateral_asset":ca,"debt_asset":db,
            "indexed_event_count":len(items),
            "distinct_historical_winner_tx_count":len(unique_txs),
            "unique_hashed_borrowers":len({x["borrower_sha256"] for x in items}),
            "first_indexed_block":min(x["block"] for x in items),
            "last_indexed_block":max(x["block"] for x in items),
            "winner_tx_list_sha256":sha(canon(unique_txs)),
            "symbolic_activity_only_not_net_pnl":True,
            "flash_route_execution_verified":False,
        })
    market_rows.sort(key=lambda d:(-d["distinct_historical_winner_tx_count"],
                                   -d["indexed_event_count"],
                                   d["collateral_asset"],d["debt_asset"]))
    for i,row in enumerate(market_rows,1):
        row["observed_index_activity_rank_not_profit_rank"]=i
    conflict_sets=[]
    for tx,events in sorted(transactions.items()):
        heights={e["block"] for e in events}
        need(len(heights)==1,"one winner tx appears in conflicting blocks")
        conflict_sets.append({
            "historical_winner_transaction":tx,"block":next(iter(heights)),
            "liquidation_logs_in_same_transaction":len(events),
            "asset_pair_count_in_same_transaction":len({
                (e["collateral_asset"],e["debt_asset"]) for e in events}),
            "winner_gas_must_be_counted_once":True,
        })
    return {
      "schema_version":1,
      "contract":"NQC_V2_POSTWINDOW_AAVE_INDEXER_MARKET_ACTIVITY_CONFLICTS",
      "status":"INDEXER_DISCOVERY_RANKING_ONLY_NOT_CANONICAL_P2_OR_PNL",
      "source_zip_sha256":ZIP_SHA,"source_indexed_response_sha256":POST_SHA,
      "source_upstream_workflow_run_id":ORIGINAL_RUN_ID,
      "source_upstream_head_commit":ORIGINAL_HEAD,
      "original_139_events_127_winner_txs_positive_control":True,
      "window":{"start":source.POST_START,"end":source.POST_END,
                "inclusive_blocks":source.POST_END-source.POST_START+1},
      "indexed_event_count":len(rows),
      "unique_indexed_winner_tx_count":len(transactions),
      "unique_indexed_pair_count":len(market_rows),
      "winner_txs_with_multiple_events":sum(
          x["liquidation_logs_in_same_transaction"]>1 for x in conflict_sets),
      "ranked_pairs":market_rows,"transaction_conflict_sets":conflict_sets,
      "no_susde_or_usdtb_in_this_indexer_response":not any(
          x["collateral_asset"] in (source.SUSDE,source.USDTB) or
          x["debt_asset"] in (source.SUSDE,source.USDTB) for x in rows),
      "not_proof_of_no_susde_or_usdtb_on_canonical_chain":True,
      "source_rest_indexer_full_onchain_completeness":False,
      "block_and_tx_receipt_independent_quorum":False,
      "price_oracle_token_decimals_gas_flash_swap_net_cost_proven":False,
      "capturable_future_opportunities_established":False,
      "first_month_45000_55000_net_usd_proven":False,
      "RMC_closed":False,"P2_shadow_certified":False,
      "commercial_score_upgrade":False,"nqc_realized_pnl_usd":"0",
    }

def run(zip_bytes):
    rows=authenticate_archive(zip_bytes)
    result=rank(rows)
    need(result["indexed_event_count"]==KNOWN_EVENTS and
         result["unique_indexed_winner_tx_count"]==KNOWN_TX and
         result["unique_indexed_pair_count"]==KNOWN_PAIRS,
         "immutable indexer market classification differs")
    top=result["ranked_pairs"][0]
    need(top["collateral_asset"]==
          "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" and
         top["debt_asset"]==
          "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" and
         top["indexed_event_count"]==10 and
         top["distinct_historical_winner_tx_count"]==9,
         "known WETH/USDC leader missing or manipulated")
    return result

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifact-zip",required=True,type=Path)
    parser.add_argument("--out",required=True,type=Path)
    args=parser.parse_args()
    data=run(args.artifact_zip.read_bytes())
    args.out.write_bytes(json.dumps(data,sort_keys=True,indent=2).encode()+b"\n")
    print(data["status"],data["indexed_event_count"],
          data["unique_indexed_winner_tx_count"],
          data["unique_indexed_pair_count"])

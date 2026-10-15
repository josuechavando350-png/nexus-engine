#!/usr/bin/env python3
"""NQC: authenticated partial 23-day Morpho cbXRP market capacity stress (OFFLINE).

No market/price oracle, sponsor quote, first-seen, P&L, live transactions or
forecast. Every figure is SOURCE-INDEXED hindsight and hypothetical underwriting.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, localcontext, ROUND_DOWN
from hashlib import sha256
from pathlib import Path
import json
import re
from zipfile import ZipFile

ORIGINAL_ZIP_SHA256 = "f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4"
ORIGINAL_CHECKOUT = "77b086f1da16ebec55e72758ce7c7eef6a4aa960"
ORIGINAL_SOURCE_TREE = "b085d773fe6f258c0b2a6094e985a470d508dda4"
ORIGINAL_ROWS_SHA256 = "8deb600b064bee39767f203e22f9cda3fd9ab61d67a2030e5369c5967215ff0e"
MARKET = "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109"
CHAIN = 8453
LOAN_DECIMALS = 6  # From separate PR742 single Morpho API metadata, NOT onchain quorum.
WAD = 10**18
LLTV_WAD = 625_000_000_000_000_000  # Single-indexer market metadata (PR742).
CURSOR_WAD = 300_000_000_000_000_000  # Original immutable Morpho Blue Solidity.
LIQUIDATION_FACTOR_WAD = min(1_150_000_000_000_000_000,
                             WAD*WAD // (WAD - CURSOR_WAD*(WAD-LLTV_WAD)//WAD))
HAIRCUTS_BPS = (0, 300, 500, 800, 1000, 1125, 1200)
EXPECTED_COUNTS = (2565, 1932, 418, 227, 31)

class BadEvidence(ValueError): pass

def require(test: bool, error: str) -> None:
    if not test: raise BadEvidence(error)

def source_uint(s: object, name: str) -> int:
    require(type(s) is str and bool(re.fullmatch(r"(?:0|[1-9][0-9]*)",s)) and len(s)<=78,
            "INVALID_INTEGER_"+name)
    n=int(s)
    require(n<=2**256-1,"OUT_OF_RANGE_"+name)
    return n

def usd2(raw: int) -> str:
    return str((Decimal(raw)/Decimal(10**6)).quantize(Decimal("0.01"),rounding=ROUND_DOWN))

def exact_unit(raw: int) -> str:
    return f"{raw//10**6}.{raw%10**6:06d}"

def checked_zip_bytes(raw: bytes) -> tuple[dict,list[dict]]:
    require(sha256(raw).hexdigest()==ORIGINAL_ZIP_SHA256,"ORIGINAL_ZIP_MISMATCH")
    import io
    with ZipFile(io.BytesIO(raw),"r") as z:
        names=z.namelist()
        require(len(names)==len(set(names)),"DUPLICATE_ZIP_MEMBER")
        manifest=z.read("manifest.sha256").decode("utf8").splitlines()
        require(len(manifest)==9,"UNEXPECTED_ORIGINAL_MANIFEST_CARDINALITY")
        verified=[]
        for entry in manifest:
            m=re.fullmatch(r"([0-9a-f]{64})  \./([a-zA-Z0-9_.\-/]+)",entry)
            require(m is not None,"MALFORMED_ORIGINAL_MANIFEST")
            expected, path=m.groups()
            require(".." not in path and path in names,"MISSING_OR_DANGEROUS_SOURCE_MEMBER")
            require(sha256(z.read(path)).hexdigest()==expected,"CORRUPTED_SOURCE_MEMBER_"+path)
            verified.append(path)
        require(len(set(verified))==9,"DUPLICATE_MANIFEST_MEMBER")
        require(z.read("code-commit.txt").decode().strip()==ORIGINAL_CHECKOUT,"ORIGINAL_COMMIT_MISMATCH")
        require(z.read("code-tree.txt").decode().strip()==ORIGINAL_SOURCE_TREE,"ORIGINAL_TREE_MISMATCH")
        corpus=z.read("liquidations.jsonl")
        require(sha256(corpus).hexdigest()==ORIGINAL_ROWS_SHA256,"SOURCE_ROW_DIGEST_MISMATCH")
        report=json.loads(z.read("census.json"))
    require(report["status"]=="INCOMPLETE_MORPHO_API_WINDOW","FALSE_FULL_30D_CERTIFICATE")
    require(report["source"]=="public_morpho_single_api_indexer_no_independent_rpc_quorum", "WRONG_SOURCE_TRUST_TIER")
    require(report["days_scoped"]==30 and report["days_attempted"]==24,"WRONG_SCOPED_DAYS")
    require(not report["market_canonical_completeness_proven"] and not report["gas_sponsor_proven"] and not report["competitive_capture_proven"] and report["nqc_pnl_usd"]=="0","FAKE_ECONOMIC_AUTHORITY")
    rows=[json.loads(b) for b in corpus.splitlines() if b]
    require(len(rows)==report["event_count"]==EXPECTED_COUNTS[0],"SOURCE_EVENT_COUNT_CONFLICT")
    require(len({r["win_id"] for r in rows})==report["unique_winning_transactions"]==EXPECTED_COUNTS[1],"SOURCE_WIN_ID_CONFLICT")
    require(report["events_sha256"]==ORIGINAL_ROWS_SHA256,"SOURCE_HASH_CONFLICT")
    days=report["daily_source_provenance"]
    require(len(days)==24 and len([d for d in days if d["status"]=="COMPLETE_MORPHO_API_DAY_INDEX_ONLY"])==23,"UNATTESTED_INTERVAL")
    complete=days[:23]
    require(all(d["day_index"]==i and d["end"]-d["start"]==86399 for i,d in enumerate(complete)),"DAYS_NOT_DISJOINT")
    require(all(complete[i]["end"]+1==complete[i+1]["start"] for i in range(22)),"GAPPED_SOURCE_INTERVAL")
    counts=defaultdict(int);ids=set()
    for r in rows:
        require(type(r.get("timestamp")) is int and any(d["start"]<=r["timestamp"]<=d["end"] for d in complete),"ROW_OUTSIDE_23_AUTHENTICATED_DAYS")
        for k in ("repaid_raw","seized_raw","bad_debt_raw"):
            source_uint(r[k],k)
        require(type(r.get("chain_id")) is int and type(r.get("log_index")) is int,"ROW_IDENTITY_TYPE")
        require(re.fullmatch(r"0x[0-9a-f]{64}",r["tx"]) and r["id"]==f"{r['chain_id']}:{r['tx']}:{r['log_index']}" and r["win_id"]==f"{r['chain_id']}:{r['tx']}","UNAUTHENTIC_EVENT_ID")
        require(r["id"] not in ids,"DUPLICATE_EVENT")
        ids.add(r["id"])
        counts[next(d["day_index"] for d in complete if d["start"]<=r["timestamp"]<=d["end"])]+=1
    require(all(counts[i]==d["event_count"] for i,d in enumerate(complete)),"DAY_COUNTS_DO_NOT_RECONCILE")
    return report,rows

def build_tx(rows: list[dict]) -> dict[str,dict]:
    matches=[r for r in rows if r["chain_id"]==CHAIN and r["market_id"]==MARKET]
    require(len(matches)==EXPECTED_COUNTS[2],"EXPECTED_INDEXED_MARKET_EVENTS_NOT_PRESENT")
    tx={}
    for r in matches:
        require(r["loan"]=="USDC" and r["collateral"]=="cbXRP", "TOKEN_INDEXER_ID_MISMATCH")
        require(re.fullmatch(r"0x[0-9a-f]{40}",r["liquidator"]),"INVALID_INDEXED_LIQUIDATOR")
        require(source_uint(r["bad_debt_raw"],"bad_debt")==0,"BAD_DEBT_NOT_COVERED_BY_PROFIT_MODEL")
        require(source_uint(r["repaid_raw"],"repaid")>0,"ZERO_DEBT_EVENT")
        k=r["win_id"]
        if k not in tx:
            tx[k]={"debt_raw":0,"liquidator":r["liquidator"],"timestamp":r["timestamp"],"events":0}
        obj=tx[k]
        require(obj["liquidator"]==r["liquidator"] and obj["timestamp"]==r["timestamp"],"MULTI_LOG_TX_IDENTITY_DIVERGENCE")
        obj["debt_raw"]+=int(r["repaid_raw"])
        obj["events"]+=1
    require(len(tx)==EXPECTED_COUNTS[3] and len({v["liquidator"] for v in tx.values()})==EXPECTED_COUNTS[4],"INDEXED_WINNERS_OR_LIQUIDATORS_DRIFT")
    require(sum(v["debt_raw"] for v in tx.values())==1_281_537_248_484,"INDEXED_DEBT_SUM_DRIFT")
    return tx

def compute(rows: list[dict]) -> dict:
    tx=build_tx(rows)
    perday=defaultdict(int);perliq=defaultdict(int)
    for obj in tx.values():
        day=datetime.fromtimestamp(obj["timestamp"],timezone.utc).date().isoformat()
        perday[day]+=obj["debt_raw"]
        perliq[obj["liquidator"]]+=obj["debt_raw"]
    peak_day=max(perday.items(), key=lambda item:(item[1],item[0]))[0]
    largest_three={a for a,_ in sorted(perliq.items(),key=lambda x:(-x[1],x[0]))[:3]}
    segments={
      "whole_observed_submarket":lambda x:True,
      "excluding_largest_utc_day":lambda x:datetime.fromtimestamp(x["timestamp"],timezone.utc).date().isoformat()!=peak_day,
      "excluding_top_three_liquidator_addresses":lambda x:x["liquidator"] not in largest_three,
      "excluding_both_peak_and_top_three":lambda x:(datetime.fromtimestamp(x["timestamp"],timezone.utc).date().isoformat()!=peak_day and x["liquidator"] not in largest_three),
    }
    all_debt=sum(x["debt_raw"] for x in tx.values())
    market_seg={}
    for name,predicate in segments.items():
        subset=[x for x in tx.values() if predicate(x)]
        nominal=sum(x["debt_raw"] for x in subset)
        hypot=[]
        for haircut in HAIRCUTS_BPS:
            # No true blockchain oracle prices: one uniform, openly hypothetical exit haircut.
            # Morpho original liquidation formula oracle LIF; no execution/timing price.
            # Floor each winning tx so the model cannot create fractions of USDC.
            rewards_raw=sum(max(0, x["debt_raw"]*(LIQUIDATION_FACTOR_WAD*(10_000-haircut)-WAD*10_000)//(WAD*10_000)) for x in subset)
            nqc50_raw=rewards_raw//2
            threshold_pct=None if not rewards_raw else str((Decimal(10_000)*Decimal(10**6)/Decimal(rewards_raw)*100).quantize(Decimal("0.01")))
            hypot.append({"exit_haircut_bps_hypothetical":haircut,
                          "operator_distributable_before_all_other_costs_usdc":exact_unit(rewards_raw),
                          "nqc_50percent_before_all_other_costs_usdc":exact_unit(nqc50_raw),
                          "required_capture_of_segment_for_5000_nqc_percent":threshold_pct,
                          "could_pass_5000_only_if_100pct_captured_before_costs":nqc50_raw>=5_000*10**6})
        market_seg[name]={"observed_hindsight_tx_count":len(subset),
                          "principal_usdc_source_indexed":exact_unit(nominal),
                          "principal_share_of_complete_23_day_indexed_submarket_percent":str((Decimal(nominal)/Decimal(all_debt)*100).quantize(Decimal("0.01"))),
                          "hypothetical_exit_haircuts":hypot}
    return {
      "status":"SOURCE_LOCKED_23D_MORPHO_MARKET_CAPACITY_SENSITIVITY_NOT_PROFIT",
      "scope":"Base cbXRP/USDC, 23 source-reconciled indexer days, not 30-day full market and not any future month",
      "source_zip_sha256":ORIGINAL_ZIP_SHA256,"source_rows_sha256":ORIGINAL_ROWS_SHA256,
      "source_single_indexer_only":True,"source_30d_window_complete":False,
      "observed_events":EXPECTED_COUNTS[2],"unique_winning_transactions":EXPECTED_COUNTS[3],
      "indexed_liquidator_addresses":EXPECTED_COUNTS[4],
      "peak_calendar_utc_day":peak_day,
      "peak_day_principal_usdc":exact_unit(perday[peak_day]),
      "peak_day_share_percent":str((Decimal(perday[peak_day])/Decimal(all_debt)*100).quantize(Decimal("0.01"))),
      "top_three_liquidator_debt_share_percent":str((Decimal(sum(perliq[a] for a in largest_three))/Decimal(all_debt)*100).quantize(Decimal("0.01"))),
      "lltv_wad_from_original_morpho_indexer":str(LLTV_WAD),
      "morpho_source_formula_liquidation_factor_wad":str(LIQUIDATION_FACTOR_WAD),
      "buyer_repayment_collateral_is_realized":False,
      "market_pnl_oracle_verified":False,"live_captured_opportunity_proven":False,
      "nqc_realized_pnl_usd":"0","own_capital_spent_usd":"0",
      "external_gas_sponsor_proven":False,"direct_competitor_advantage_proven":False,
      "no_nqc_monthly_forecast_permitted":True,"segments":market_seg,
      "interpretation":"SOURCE-INDEXED 23-day hindsight, per-winner oracle-LIF optimistic value; uniform DEX haircut, 50% share, zero native gas/builder/failed attempts/operator expense. Segments exclude selected historical competitor wins as STRESS only, never future NQC accessibility or a market-wide upper bound. No actual price, DEX sale, winner probability, legal sponsor, no forecast.",
    }

def run(original_zip:Path,output:Path)->dict:
    _,rows=checked_zip_bytes(original_zip.read_bytes())
    result=compute(rows)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n",encoding="utf8")
    return result

def main()->None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--source-zip",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    report=run(args.source_zip,args.output)
    block=report["segments"]["excluding_both_peak_and_top_three"]
    print(report["status"],"market wins",report["unique_winning_transactions"],
          "stress remainder",block["principal_usdc_source_indexed"],
          "NQC max optimistic 50pct cut",block["hypothetical_exit_haircuts"][0]["nqc_50percent_before_all_other_costs_usdc"])
if __name__=="__main__":main()

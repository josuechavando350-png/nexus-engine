#!/usr/bin/env python3
"""Three highest historical WETH/WETH competitor wins: exact earlier-state HF.

Selected retrospectively from future winners; NEVER an ex-ante trading signal,
capture observation, or Nexus economic capacity certificate.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import hashlib
import json
import time
from pathlib import Path

from rmc016_aave_event_legs import decode
from rmc016_probe_historical_rpc import PROVIDERS, rpc, AAVE_POOL, LIQUIDATION_TOPIC
from rmc016_resume_verified_receipts import authenticated_drpc_checkpoint
from rmc016_two_operator_receipts import receipt_normalized
from rmc016_weth_cashflow_audit import (
    EVENT_SHA, RECEIPT_SHA, LEGS_SHA, WETH,
    authenticated_zip, reconcile_legs, unique_json, canonical, digest, require,
)
from rmc016_rank1_prestate_probe import checked_block, HEX40
from rmc016_rank1_preblock_health import decode_user_account_data, GET_ACCOUNT_DATA, WAD

RANKED = (
    ("0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba",
      25938048,10684013854557827871,96136430295441074),
    ("0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb",
      26024990,1827043650017560428,81693946535782254),
    ("0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb",
      26071849,866504893554112580,38776135687875734),
)
RANK1_PREVIOUS_HF_WAD = 1000000001993818630


def recover_ranked_sources(event_zip,receipt_zip,legs_zip):
    receipts, original, ids = authenticated_drpc_checkpoint(receipt_zip,event_zip)
    require(len(ids)==127 and len(original)==127,"source winner receipt conservation drift")
    raw=authenticated_zip(legs_zip,LEGS_SHA,
                          {"decoded-liquidation-legs.jsonl","decoded-legs-report.json"})
    decoded=reconcile_legs(original,ids,raw["decoded-liquidation-legs.jsonl"],
                           unique_json(raw["decoded-legs-report.json"]))
    require(len(decoded)==139,"full decoded Aave historical event conservation")
    rows=[]
    for x in decoded:
        if x["collateral_asset"]!=WETH or x["debt_asset"]!=WETH:
            continue
        tx=x["transaction_hash"]
        r=receipts[tx]
        require(x["block_number"]==r["block_number"] and x["block_hash"]==r["block_hash"],
                "WETH event/receipt block drift")
        gross=int(x["collateral_liquidated_raw"])-int(x["debt_to_cover_raw"])-int(r["total_gas_paid_wei"])
        rows.append((gross,tx,x))
    rows.sort(key=lambda x:(-x[0],x[1]))
    require(len(rows)==9 and all(x[0]>0 for x in rows),
            "historical nine-WETH competitor set changed")
    targets=[]
    for i,(tx,block,debt,margin) in enumerate(RANKED):
        actual_margin,tid,leg=rows[i]
        receipt=receipts[tx]
        require(tid==tx and leg["block_number"]==block and
                int(leg["debt_to_cover_raw"])==debt and actual_margin==margin,
                "original top-3 WETH ranking or amounts changed")
        # One winner tx may contain other Aave LiquidationCall events; the
        # whole receipt is still authenticated once, then the selected
        # WETH/WETH event is matched by its exact canonical log index.
        require(len(original[tx])>=1,"historical competitor receipt missing Aave events")
        targets.append({
            "rank":i+1,
            "transaction_hash":tx,"winning_block_number":block,
            "winning_block_hash":receipt["block_hash"],
            "predecessor_number":block-1,
            "debt_to_cover_wei":str(debt),
            "collateral_minus_debt_minus_competitor_gas_wei":str(margin),
            "original_abi_event":leg,
            "original_event_list":original[tx],
            "original_receipt":receipt,
        })
    return targets


def observe_provider(provider,targets,call=rpc,spacing=0):
    pid,operator,url=provider
    require(call(url,"eth_chainId",[])=="0x1","historical provider is not Ethereum mainnet")
    results=[]
    for t in targets:
        block=t["winning_block_number"]
        winner=checked_block(call(url,"eth_getBlockByNumber",[hex(block),False]),block)
        require(winner["hash"]==t["winning_block_hash"],
                "historical competitor winner block mismatch/reorg")
        earlier=checked_block(call(url,"eth_getBlockByNumber",[hex(block-1),False]),block-1)
        require(earlier["hash"]==winner["parent_hash"],
                "earlier block not winner's canonical predecessor")
        raw=call(url,"eth_getTransactionReceipt",[t["transaction_hash"]])
        normalized=receipt_normalized(t["transaction_hash"],t["original_event_list"],raw)
        require(normalized==t["original_receipt"],
                "independent competitor winner receipt differs from original immutable dRPC")
        logs=[x for x in raw.get("logs",[]) if type(x) is dict
              and str(x.get("address","")).lower()==AAVE_POOL
              and type(x.get("topics")) is list and len(x["topics"])==4
              and str(x["topics"][0]).lower()==LIQUIDATION_TOPIC]
        require(len(logs)==len(t["original_event_list"]),
                "full Aave source event count disagrees with actual winner receipt")
        wanted_index=t["original_abi_event"]["log_index"]
        matches=[log for log in logs if int(str(log.get("logIndex","-1")),16)==wanted_index]
        require(len(matches)==1,
                "exact WETH/WETH liquidation log index not unique in historical winner")
        original_log=decode(matches[0])
        require(original_log==t["original_abi_event"],
                "raw source event ABI / borrower hash differs")
        borrower="0x"+str(matches[0]["topics"][3]).lower()[-40:]
        require(HEX40.fullmatch(borrower) is not None and borrower!="0x"+"0"*40,
                "invalid source borrower address")
        if spacing:time.sleep(spacing)
        data=GET_ACCOUNT_DATA+borrower[2:].rjust(64,"0")
        response=call(url,"eth_call",[{"to":AAVE_POOL,"data":data},hex(block-1)])
        account=decode_user_account_data(response)
        results.append({
            "rank":t["rank"],
            "winner_transaction_hash":t["transaction_hash"],
            "winner_block_number":block,"winner_block_hash":winner["hash"],
            "predecessor_block":earlier,
            "source_borrower_identity_sha256":original_log["borrower_identity_sha256"],
            "borrower":borrower,
            "account_data":account,
            "health_factor_below_one_at_predecessor":int(account["health_factor_wad"])<WAD,
            "receipt_evidence_sha256":normalized["receipt_evidence_sha256"],
        })
    return {"provider_id":pid,"operator":operator,"rows":results}


def assess(targets,*,call=rpc,providers=None,spacing=0.5):
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    require(len(providers)==2 and [p[0] for p in providers]==["drpc","blast"]
            and providers[0][1]!=providers[1][1],
            "exact two independent source RPC operators required")
    require(len(targets)==3 and [x["transaction_hash"] for x in targets]==[x[0] for x in RANKED],
            "not the exact original three largest WETH competitors")
    observed=[observe_provider(p,targets,call=call,spacing=spacing) for p in providers]
    left,right=observed
    require(left["rows"]==right["rows"],
            "Aave preceding-state or actual competitor receipt differs by RPC operator")
    rows=left["rows"]
    require(int(rows[0]["account_data"]["health_factor_wad"])==RANK1_PREVIOUS_HF_WAD
            and rows[0]["health_factor_below_one_at_predecessor"] is False,
            "previous independently certified rank-one healthy prestate drift")
    eligible=sum(r["health_factor_below_one_at_predecessor"] for r in rows)
    public=[{
        "rank":r["rank"],
        "historical_competitor_tx":r["winner_transaction_hash"],
        "previous_block_number":r["predecessor_block"]["number"],
        "previous_block_hash":r["predecessor_block"]["hash"],
        "previous_block_state_root":r["predecessor_block"]["state_root"],
        "source_borrower_identity_sha256":r["source_borrower_identity_sha256"],
        "health_factor_wad":r["account_data"]["health_factor_wad"],
        "total_debt_base":r["account_data"]["total_debt_base"],
        "below_one_at_previous_block":r["health_factor_below_one_at_predecessor"],
        "can_only_attempt_preblock_fork_if_below_one":r["health_factor_below_one_at_predecessor"],
    } for r in rows]
    out={
       "schema_version":1,
       "status":"RMC016_TOP3_HISTORICAL_WETH_PREBLOCK_HEALTH_TRUTH_ONLY",
       "source_event_archive_sha256":EVENT_SHA,
       "source_receipts_archive_sha256":RECEIPT_SHA,
       "source_integer_legs_archive_sha256":LEGS_SHA,
       "observed_historical_top_three_count":3,
       "observed_predecessor_below_one_count":eligible,
       "observed_predecessor_not_below_one_count":3-eligible,
       "three_source_rows":public,
       "independent_two_provider_parity":True,
       "source_selection_uses_future_winner_knowledge":True,
       "evidence_of_ex_ante_discovery_or_strategy_capture":False,
       "replayed_real_liquidation_in_preblock":False,
       "flash_principal_and_gas_externally_financed":False,
       "complete_costs_or_realized_nexus_profit_certified":False,
       "real_market_census_closed":False,
       "provider_records":observed,
    }
    out["report_sha256"]=digest(canonical(out))
    return out


def main():
    p=argparse.ArgumentParser()
    for k in ("event-zip","receipt-zip","legs-zip","out"):
        p.add_argument("--"+k,type=Path,required=True)
    args=p.parse_args()
    require(not args.out.exists(),"append-only result required")
    targets=recover_ranked_sources(args.event_zip,args.receipt_zip,args.legs_zip)
    result=assess(targets)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(canonical(result))
    print(result["status"],"underwater_previous",result["observed_predecessor_below_one_count"],
          "healthy_previous",result["observed_predecessor_not_below_one_count"],
          "hfs",[x["health_factor_wad"] for x in result["three_source_rows"]],
          "nexus_ex_ante_captures_proven",False)


if __name__=="__main__":
    main()

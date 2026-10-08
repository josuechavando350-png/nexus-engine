#!/usr/bin/env python3
"""Historical rank-2 WETH/WETH oracle witness, not Nexus execution or profitability.

Source archives and historical receipt identities are immutable. Historical
selection is retrospective and is never an ex-ante candidate/trading signal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from rmc016_weth_cashflow_audit import (
    EVENT_SHA, RECEIPT_SHA, LEGS_SHA, WETH, HYPOTHETICAL_FLASH_BPS,
    authenticated_zip, canonical, digest, reconcile_legs, require, signed_usd_wad,
    uint, unique_json,
)
from rmc016_two_operator_receipts import load_source
from rmc016_resume_verified_receipts import authenticated_drpc_checkpoint
from rmc016_preblock_gas_oracle_batch import src, acquire

RANK = 2
TX = "0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb"
BLOCK = 26024990
SORTED_WINNER_BLOCK_OFFSET = 80
DEBT_WEI = 1827043650017560428
COLLATERAL_WEI = 1909260614268350646
HISTORICAL_WINNER_GAS_WEI = 523017715007964
AFTER_GAS_WEI = 81693946535782254
AFTER_ILLUSTRATIVE_5BPS_WEI = 80780424710773473

def ranked_weth_rows(legs, receipts):
    require(type(legs) is list and len(legs)==139 and type(receipts) is dict and len(receipts)==127,
            "immutable 139/127 historical corpus mismatch")
    grouped = {}
    for leg in legs:
        tid=leg["transaction_hash"]
        require(tid in receipts, "historical leg receipt missing")
        if leg["collateral_asset"]==WETH and leg["debt_asset"]==WETH:
            grouped.setdefault(tid, []).append(leg)
    require(len(grouped)==9 and sum(map(len,grouped.values()))==9,
            "expected all nine real WETH/WETH winner events")
    result=[]
    for tid, group in grouped.items():
        receipt=receipts[tid]
        require(all(x["block_hash"]==receipt["block_hash"] and
                    x["block_number"]==receipt["block_number"] for x in group),
                "winner receipt not bound to event")
        debt=sum(uint(x["debt_to_cover_raw"],"historical WETH debt",positive=True) for x in group)
        collateral=sum(uint(x["collateral_liquidated_raw"],"historical WETH collateral",positive=True) for x in group)
        gas=uint(receipt["total_gas_paid_wei"],"competitor full transaction gas",positive=True)
        fee=(debt*HYPOTHETICAL_FLASH_BPS + 9999)//10000
        result.append({
            "transaction_hash":tid,"block_number":receipt["block_number"],
            "block_hash":receipt["block_hash"],
            "debt_wei":str(debt),"collateral_wei":str(collateral),
            "competitor_full_transaction_gas_wei":str(gas),
            "historical_after_competitor_gas_wei":str(collateral-debt-gas),
            "conditional_after_hypothetical_5bps_wei":str(collateral-debt-gas-fee),
            "receive_a_token":any(x["receive_a_token"] for x in group),
        })
    result.sort(key=lambda r:(-int(r["historical_after_competitor_gas_wei"]),r["transaction_hash"]))
    require(len(result)==9 and all(int(r["historical_after_competitor_gas_wei"])>0 for r in result),
            "historical WETH gross/gas evidence no longer matches authenticated corpus")
    chosen=result[RANK-1]
    require(chosen["transaction_hash"]==TX and chosen["block_number"]==BLOCK and
            int(chosen["debt_wei"])==DEBT_WEI and
            int(chosen["collateral_wei"])==COLLATERAL_WEI and
            int(chosen["competitor_full_transaction_gas_wei"])==HISTORICAL_WINNER_GAS_WEI and
            int(chosen["historical_after_competitor_gas_wei"])==AFTER_GAS_WEI and
            int(chosen["conditional_after_hypothetical_5bps_wei"])==AFTER_ILLUSTRATIVE_5BPS_WEI and
            chosen["receive_a_token"] is False,
            "rank-two historical WETH winner source quantity/identity drift")
    return result,chosen

def validate_price(chosen,block_universe,by,observed):
    require(len(block_universe)==123 and block_universe[SORTED_WINNER_BLOCK_OFFSET]==BLOCK,
            "rank-two block offset differs from immutable 123-block winner universe")
    require(len(by[BLOCK])==1 and by[BLOCK][0]["transaction_hash"]==TX and
            by[BLOCK][0]["block_hash"]==chosen["block_hash"] and
            int(by[BLOCK][0]["total_gas_paid_wei"])==HISTORICAL_WINNER_GAS_WEI,
            "rank-two transaction differs from receipt archive")
    require(type(observed) is dict and
            observed.get("status")=="RMC016_DUAL_OPERATOR_PREBLOCK_GAS_REFERENCE_PASS" and
            observed.get("two_provider_consensus") is True and
            observed.get("verified_blocks")==1 and
            observed.get("offset")==SORTED_WINNER_BLOCK_OFFSET and
            observed.get("count")==1 and
            observed.get("requested_blocks")==[BLOCK] and
            observed.get("exact_pre_tx_state_proven") is False and
            observed.get("nexus_net_profit_proven") is False and
            observed.get("real_market_census_closed") is False,
            "rank-two price source must be one observed block and no Nexus profitability")
    pair=observed.get("prices")
    require(type(pair) is list and len(pair)==1,"historical oracle price record count")
    p=pair[0]
    pre,ended=p.get("preblock"),p.get("block_end")
    require(type(pre) is dict and type(ended) is dict and
            pre.get("block")==BLOCK-1 and ended.get("block")==BLOCK and
            ended.get("hash")==chosen["block_hash"] and
            p.get("tx_block")==BLOCK and p.get("winner_transaction_count")==1 and
            p.get("winner_gas_wei")==str(HISTORICAL_WINNER_GAS_WEI) and
            p.get("pre_transaction_price_certified") is False,
            "rank-two historical oracle not transaction/receipt bound")
    before=uint(pre.get("oracle_usd_base_1e8"),"previous-block WETH price",positive=True)
    end=uint(ended.get("oracle_usd_base_1e8"),"winner block-end WETH price",positive=True)
    require(before>0 and end>0,"missing block-pinned oracle price")
    amount=int(chosen["conditional_after_hypothetical_5bps_wei"])
    return {
      "transaction_hash":TX,"block_number":BLOCK,"block_hash":chosen["block_hash"],
      "historical_rank_after_competitor_gas":RANK,
      "historical_weth_debt_wei":chosen["debt_wei"],
      "historical_weth_collateral_wei":chosen["collateral_wei"],
      "historical_winner_full_tx_gas_wei":str(HISTORICAL_WINNER_GAS_WEI),
      "historical_after_winner_gas_wei":str(AFTER_GAS_WEI),
      "hypothetical_flash_fee_bps":HYPOTHETICAL_FLASH_BPS,
      "conditional_after_hypothetical_5bps_wei":str(amount),
      "historical_preblock_oracle":pre,"historical_winner_block_end_oracle":ended,
      "conditional_remaining_usd_wad_preblock_reference":str(signed_usd_wad(amount,str(before))),
      "two_independent_operator_price_consensus":True,
      "previous_block_price_is_not_exact_pretransaction_price":True,
      "flash_fee_is_not_an_authenticated_capital_quote":True,
      "competitor_execution_is_not_nexus_execution":True,
      "nexus_gas_financing_proven":False,"nexus_flash_principal_funding_proven":False,
      "nexus_capture_proven":False,"nexus_positive_net_pnl_proven":False,
      "real_market_census_closed":False,
    }

def audit(event_zip,receipt_zip,legs_zip,sample_zip,*,spacing=1.5,price_getter=acquire):
    _,orig,ids=load_source(event_zip,EVENT_SHA)
    receipts,checkpoint_events,checkpoint_ids=authenticated_drpc_checkpoint(receipt_zip,event_zip)
    require(orig==checkpoint_events and ids==checkpoint_ids, "original log/receipt source drift")
    raw=authenticated_zip(legs_zip,LEGS_SHA,
                          {"decoded-liquidation-legs.jsonl","decoded-legs-report.json"})
    legs=reconcile_legs(orig,ids,raw["decoded-liquidation-legs.jsonl"],
                        unique_json(raw["decoded-legs-report.json"]))
    _,chosen=ranked_weth_rows(legs,receipts)
    by,blocks,_=src(event_zip,receipt_zip,sample_zip)
    require(blocks[SORTED_WINNER_BLOCK_OFFSET]==BLOCK and
            by[BLOCK][0]["transaction_hash"]==TX,"winner block index drift")
    observed=price_getter(event_zip,receipt_zip,sample_zip,
                          offset=SORTED_WINNER_BLOCK_OFFSET,count=1,spacing=spacing)
    if observed.get("status")!="RMC016_DUAL_OPERATOR_PREBLOCK_GAS_REFERENCE_PASS":
        out={"schema_version":1,"status":"RMC016_RANK2_WETH_ORACLE_SOURCE_BLOCKED",
             "historical_source_event_sha256":EVENT_SHA,"historical_receipts_sha256":RECEIPT_SHA,
             "historical_legs_sha256":LEGS_SHA,"rank_two_tx":TX,"rank_two_block":BLOCK,
             "source_error":str(observed.get("error"))[:240],
             "nexus_net_profit_proven":False,"real_market_census_closed":False}
    else:
        row=validate_price(chosen,blocks,by,observed)
        out={"schema_version":1,
             "status":"RMC016_RANK2_WETH_DUAL_OPERATOR_PREBLOCK_ORACLE_PASS",
             "source_hashes":{"event_zip_sha256":EVENT_SHA,
                              "receipt_zip_sha256":RECEIPT_SHA,
                              "legs_zip_sha256":LEGS_SHA},
             "historical_weth_weth_winner_count":9,
             "historical_positive_after_competitor_gas_count":9,
             "selected_rank":RANK,"source_selection_retrospective":True,
             "row":row,
             "nexus_net_profit_proven":False,
             "nexus_own_capital_required_usd":"0",
             "nexus_gas_or_flash_provider_authorized":False,
             "real_market_census_closed":False}
    out["report_sha256"]=digest(canonical(out))
    return out

def main():
    p=argparse.ArgumentParser()
    for name in ("event-zip","receipt-zip","legs-zip","sample-zip","out"):
        p.add_argument("--"+name,required=True,type=Path)
    p.add_argument("--spacing",type=float,default=1.5)
    a=p.parse_args()
    require(not a.out.exists(),"append-only output required")
    report=audit(a.event_zip,a.receipt_zip,a.legs_zip,a.sample_zip,spacing=a.spacing)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(report))
    print(report["status"],"rank",RANK,"block",BLOCK,
          "nexus_net_proven",report["nexus_net_profit_proven"])
    return 0 if report["status"]=="RMC016_RANK2_WETH_DUAL_OPERATOR_PREBLOCK_ORACLE_PASS" else 2

if __name__=="__main__":
    raise SystemExit(main())

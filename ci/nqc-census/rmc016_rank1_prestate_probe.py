#!/usr/bin/env python3
"""Source-locked historical rank-one WETH/WETH liquidation prestate witness.

This is an intentionally retrospective candidate chosen from a future winning
transaction, not an ex-ante signal. No trade, gas sponsor, or P&L is claimed.
"""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path

from rmc016_aave_event_legs import decode
from rmc016_probe_historical_rpc import PROVIDERS, rpc, AAVE_POOL, LIQUIDATION_TOPIC
from rmc016_resume_verified_receipts import authenticated_drpc_checkpoint
from rmc016_two_operator_receipts import receipt_normalized
from rmc016_weth_cashflow_audit import (
    EVENT_SHA, RECEIPT_SHA, LEGS_SHA, WETH,
    authenticated_zip, reconcile_legs, unique_json, canonical, digest, require,
)

TX = "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba"
BLOCK = 25938048
WINNER_HASH = "0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4"
PRINCIPAL = 10684013854557827871
HISTORICAL_COMPETITOR_GAS = 19694395579376
AFTER_COMPETITOR_GAS = 96136430295441074
HEX64 = re.compile(r"0x[0-9a-f]{64}\Z")
HEX40 = re.compile(r"0x[0-9a-f]{40}\Z")


def authenticated_target(event_zip,receipt_zip,legs_zip):
    receipts, originals, ids = authenticated_drpc_checkpoint(receipt_zip,event_zip)
    require(len(ids)==127 and TX in ids,"source-winning transaction missing")
    original_receipt=receipts[TX]
    require(original_receipt["block_number"]==BLOCK and
            original_receipt["block_hash"]==WINNER_HASH and
            int(original_receipt["total_gas_paid_wei"])==HISTORICAL_COMPETITOR_GAS,
            "immutable historical winning receipt drift")
    raw=authenticated_zip(legs_zip,LEGS_SHA,
                          {"decoded-liquidation-legs.jsonl","decoded-legs-report.json"})
    decoded=reconcile_legs(originals,ids,raw["decoded-liquidation-legs.jsonl"],
                           unique_json(raw["decoded-legs-report.json"]))
    selected=[x for x in decoded if x["transaction_hash"]==TX]
    require(len(selected)==1 and selected[0]["block_hash"]==WINNER_HASH and
            selected[0]["block_number"]==BLOCK and
            selected[0]["collateral_asset"]==WETH and selected[0]["debt_asset"]==WETH and
            int(selected[0]["debt_to_cover_raw"])==PRINCIPAL and
            selected[0]["receive_a_token"] is False,
            "rank-one exact WETH/WETH liquidation record altered")
    return original_receipt, originals[TX], selected[0]


def checked_block(header,number):
    require(type(header) is dict and int(header.get("number","-1"),16)==number,
            "wrong historical block number")
    for key in ("hash","parentHash","stateRoot"):
        val=header.get(key)
        require(type(val) is str and HEX64.fullmatch(val) is not None,
                "malformed historical "+key)
    return {"number":number,"hash":header["hash"],
            "parent_hash":header["parentHash"],
            "state_root":header["stateRoot"]}


def verify_one(provider,baseline,original_events,decoded_target,call=rpc):
    name,operator,url=provider
    require(call(url,"eth_chainId",[])=="0x1","non-Ethereum JSON-RPC")
    winning=checked_block(call(url,"eth_getBlockByNumber",[hex(BLOCK),False]),BLOCK)
    require(winning["hash"]==WINNER_HASH,"winner block reorg or wrong network")
    previous=checked_block(call(url,"eth_getBlockByNumber",[hex(BLOCK-1),False]),BLOCK-1)
    require(previous["hash"]==winning["parent_hash"],"predecessor canonical parent mismatch")
    receipt=call(url,"eth_getTransactionReceipt",[TX])
    normalized=receipt_normalized(TX,original_events,receipt)
    require(normalized==baseline,"independent raw receipt not byte-equivalent in normalized fields")
    logs=[x for x in receipt["logs"]
          if type(x) is dict and str(x.get("address","")).lower()==AAVE_POOL
          and type(x.get("topics")) is list and x["topics"]
          and str(x["topics"][0]).lower()==LIQUIDATION_TOPIC]
    require(len(logs)==1,"rank-one transaction has unexpected liquidation log cardinality")
    parsed=decode(logs[0])
    require(parsed==decoded_target,"raw ABI event differs from source-authenticated amount/identity hashes")
    topics=[str(x).lower() for x in logs[0]["topics"]]
    borrower="0x"+topics[3][-40:]
    require(HEX40.fullmatch(borrower) is not None and borrower!="0x"+"0"*40,
            "historical borrower identity invalid")
    return {
        "operator":operator,
        "provider_id":name,
        "winning_block":winning,
        "predecessor_block":previous,
        "borrower":borrower,
        "borrower_identity_sha256":decoded_target["borrower_identity_sha256"],
        "rank_one_source_event_commitment":decoded_target["original_event_commitment_sha256"],
        "receipt_commitment":normalized["receipt_evidence_sha256"],
    }


def assess(event_zip,receipt_zip,legs_zip,*,call=rpc,providers=None):
    baseline,original,decoded=authenticated_target(event_zip,receipt_zip,legs_zip)
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    require(len(providers)==2 and [p[0] for p in providers]==["drpc","blast"]
            and providers[0][1]!=providers[1][1],"two independent RPC operators required")
    observations=[verify_one(p,baseline,original,decoded,call=call) for p in providers]
    a,b=observations
    require((a["winning_block"],a["predecessor_block"],a["borrower"],
             a["rank_one_source_event_commitment"],a["receipt_commitment"])==
            (b["winning_block"],b["predecessor_block"],b["borrower"],
             b["rank_one_source_event_commitment"],b["receipt_commitment"]),
            "independent receipt, borrower or prior state operators disagree")
    report={
        "schema_version":1,
        "status":"RMC016_RANK1_SOURCE_AUTHENTICATED_PREDECESSOR_STATE_WITNESS",
        "source_sha256":{"events":EVENT_SHA,"receipts":RECEIPT_SHA,"decoded_legs":LEGS_SHA},
        "tx":TX,"winning_block_number":BLOCK,"winning_block_hash":WINNER_HASH,
        "previous_block":a["predecessor_block"],
        "borrower_address_for_local_fork_only":a["borrower"],
        "borrower_identity_sha256":a["borrower_identity_sha256"],
        "historical_competitor_gas_wei":str(HISTORICAL_COMPETITOR_GAS),
        "debt_to_cover_raw_wei":str(PRINCIPAL),
        "historical_competitor_weth_after_gas_wei":str(AFTER_COMPETITOR_GAS),
        "collateral_asset":WETH,"debt_asset":WETH,
        "independent_operator_receipt_and_parent_hash_consensus":True,
        "source_selection_retrospective_from_future_winner_tx":True,
        "decision_time_prior_awareness_of_this_opportunity_proven":False,
        "borrower_liquidatable_at_previous_block_proven":False,
        "aave_atomic_liquidation_replayed":False,
        "flash_principal_and_gas_externally_authorized":False,
        "nexus_realized_net_profit_proven":False,
        "real_market_census_closed":False,
        "operators":observations,
    }
    report["report_sha256"]=digest(canonical(report))
    return report


def main():
    p=argparse.ArgumentParser()
    for k in ("event-zip","receipt-zip","legs-zip","out"):
        p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    require(not a.out.exists(),"append-only report output")
    r=assess(a.event_zip,a.receipt_zip,a.legs_zip)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(r))
    print(r["status"],"tx",TX,"prevblock",BLOCK-1,
          "retrospective",True,"nexus_pnl_proven",False)


if __name__=="__main__":
    main()

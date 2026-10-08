#!/usr/bin/env python3
"""RMC-016 observed WETH/WETH historical winner leg-versus-gas arithmetic.

Does NOT demonstrate NQC execution, competition capture, or realized net P&L.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from collections import defaultdict

WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
LEGS_SHA="51dfc4c9c3031a7bf3bb6ce019eb3a9184a1f2327f1accedcc2c6e165af91acb"
DRPC_SHA="182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6"
HEX64=re.compile(r"^0x[0-9a-f]{64}$")
DECIMAL=re.compile(r"^(?:0|[1-9][0-9]*)$")
LEGS_FILES={"archive.sha256","decoded-legs-report.json","decoded-liquidation-legs.jsonl"}
DRPC_FILES={"archive.sha256","receipt-parity-report.json","verified-drpc-receipts.jsonl"}

def need(cond,msg):
    if not cond:raise ValueError(msg)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def amount(val,name):
    need(type(val) is str and DECIMAL.fullmatch(val) is not None,name+" not unsigned integer string")
    return int(val)

def load_exact(path,expected,files):
    need(path.is_file(),"source ZIP missing")
    need(sha(path.read_bytes())==expected,"source ZIP SHA256 mismatch")
    with zipfile.ZipFile(path) as z:
        info=z.infolist()
        names=[x.filename for x in info]
        need(len(names)==len(set(names)) and set(names)==files,"ZIP member set mismatch")
        for m in info:
            need(m.filename==Path(m.filename).name,"unsafe ZIP member path")
            need((m.external_attr>>16)&0o170000 != 0o120000,"ZIP symlink forbidden")
            need(m.file_size<=15_000_000,"ZIP member exceeds evidence bound")
        members={n:z.read(n) for n in files}
    checked=set()
    for line in members["archive.sha256"].decode("ascii").splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,"noncanonical ZIP manifest")
        digest,name=line.split("  ")
        need(name in files-{"archive.sha256"} and name not in checked,"missing or duplicated manifest name")
        need(sha(members[name])==digest,"ZIP member digest mismatch")
        checked.add(name)
    need(checked==files-{"archive.sha256"},"incomplete manifest")
    return members

def parse_doc(raw):
    def unique(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,"duplicate JSON key")
            out[k]=v
        return out
    return json.loads(raw,object_pairs_hook=unique)

def rows(raw,expected):
    need(raw.endswith(b"\n") and raw,"empty/nonnewline JSONL")
    out=[]
    for line in raw.splitlines():
        rec=parse_doc(line)
        need(type(rec) is dict and canonical(rec).rstrip(b"\n")==line,"noncanonical JSONL")
        out.append(rec)
    need(len(out)==expected,"source row cardinality incorrect")
    return out

def verify_inputs(legs_zip,receipts_zip):
    a=load_exact(legs_zip,LEGS_SHA,LEGS_FILES)
    b=load_exact(receipts_zip,DRPC_SHA,DRPC_FILES)
    l_report=parse_doc(a["decoded-legs-report.json"])
    r_report=parse_doc(b["receipt-parity-report.json"])
    need(l_report.get("status")=="RMC016_SINGLE_OPERATOR_REAL_INTEGER_LIQUIDATION_LEGS_SOURCE_MATCH",
         "leg source not admitted")
    need(l_report.get("events")==139 and l_report.get("unique_winner_transactions")==127,
         "leg counts wrong")
    need(l_report.get("block_pinned_token_decimals_complete") is False
         and l_report.get("execution_route_costs_complete") is False
         and l_report.get("nexus_net_profitability_proven") is False,"leg authority overclaimed")
    lraw=a["decoded-liquidation-legs.jsonl"]
    need(sha(lraw)==l_report.get("event_rows_sha256"),"leg event commitment mismatch")
    lrows=rows(lraw,139)
    rrows=rows(b["verified-drpc-receipts.jsonl"],127)
    need(r_report.get("status")=="RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED"
         and r_report.get("blocked_at")=="blast"
         and r_report.get("nexus_net_pnl_proven") is False
         and r_report.get("independent_receipt_parity_complete") is False,
         "receipt parent must remain overall FAILED; first operator only")
    stages=r_report.get("provider_stages")
    need(type(stages) is list and len(stages)==2
         and stages[0].get("provider_id")=="drpc"
         and stages[0].get("verified_transaction_count")==127,"dRPC complete stage absent")
    ids=set()
    receipts={}
    for rec in rrows:
        tid=rec.get("transaction_hash")
        need(type(tid) is str and HEX64.fullmatch(tid) is not None and tid not in ids,
             "invalid, duplicate or missing transaction receipt")
        ids.add(tid)
        gas=amount(rec.get("total_gas_paid_wei"),"receipt total gas")
        need(gas==amount(rec.get("execution_gas_wei"),"exec gas")+
             amount(rec.get("blob_gas_wei"),"blob gas"),"gas cost arithmetic inconsistent")
        need(amount(rec.get("gas_used"),"gas used")*amount(rec.get("effective_gas_price_wei"),"gas price")==
             amount(rec.get("execution_gas_wei"),"execution gas paid"),"receipt gas-used/effective-price mismatch")
        receipts[tid]=rec
    event_ids=set()
    for rec in lrows:
        tid=rec.get("transaction_hash")
        need(type(tid) is str and tid in receipts,"leg missing authenticated receipt")
        block=rec.get("block_number")
        need(type(block) is int and 25880316<=block<=26095351,"bad original block")
        need(rec.get("block_hash")==receipts[tid].get("block_hash")
             and block==receipts[tid].get("block_number")
             and rec.get("transaction_index")==receipts[tid].get("transaction_index"),
             "leg and actual winner receipt block/order mismatch")
        key=(rec.get("block_hash"),tid,rec.get("log_index"))
        need(key not in event_ids,"duplicated liquidation event")
        event_ids.add(key)
        amount(rec.get("debt_to_cover_raw"),"debt raw")
        amount(rec.get("collateral_liquidated_raw"),"collateral raw")
        need(rec.get("receive_a_token") is False,"unexpected aToken receipt in certified source")
        need(type(rec.get("original_event_commitment_sha256")) is str and
             re.fullmatch("[0-9a-f]{64}",rec["original_event_commitment_sha256"]) is not None,
             "event provenance absent")
    need({x["transaction_hash"] for x in lrows}==ids,"127 event transaction identities differ from dRPC")
    return lrows,receipts

def evaluate(legs,receipt_by_tx):
    groups=defaultdict(list)
    for leg in legs:groups[leg["transaction_hash"]].append(leg)
    accepted=[]
    same_asset_event_count=0
    for tx,legs in sorted(groups.items()):
        same_asset_event_count+=sum(x["collateral_asset"]==x["debt_asset"] for x in legs)
        if not all(x["collateral_asset"]==WETH and x["debt_asset"]==WETH
                   and x["receive_a_token"] is False for x in legs):
            continue
        debt=sum(amount(x["debt_to_cover_raw"],"weth debt") for x in legs)
        collateral=sum(amount(x["collateral_liquidated_raw"],"weth collateral") for x in legs)
        gas=amount(receipt_by_tx[tx]["total_gas_paid_wei"],"winner gas")
        raw=collateral-debt
        after=raw-gas
        accepted.append({
            "transaction_hash":tx,"block_number":legs[0]["block_number"],
            "liquidation_event_count":len(legs),
            "debt_repaid_weth_wei":str(debt),"collateral_seized_weth_wei":str(collateral),
            "raw_leg_surplus_weth_wei":str(raw),
            "historical_winner_gas_eth_wei":str(gas),
            "observed_leg_surplus_less_historical_gas_weth_equivalent_wei":str(after),
            "raw_leg_surplus_positive":raw>0,
            "after_historical_gas_positive":after>0,
            "tx_exact_economic_replay_proven":False,
            "flash_premium_and_route_costs_proven":False,
            "nexus_capture_proven":False})
    accepted.sort(key=lambda x:(x["block_number"],x["transaction_hash"]))
    need(len(groups)==127 and len(legs)==139,"inconsistent received event universe")
    need(same_asset_event_count==12,"same-asset event census changed")
    need(len(accepted)==7 and all(x["liquidation_event_count"]==1 for x in accepted),
         "7 WETH-only source winners failed exact baseline conservation")
    gross=sum(int(x["raw_leg_surplus_weth_wei"]) for x in accepted)
    gas=sum(int(x["historical_winner_gas_eth_wei"]) for x in accepted)
    net=gross-gas
    need(gross==139804855784991720 and gas==1715445788361971 and net==138089409996629749,
         "historical exact-match WETH leg/gas arithmetic shifted")
    report={"schema_version":1,
        "status":"RMC016_WETH_SAME_ASSET_OBSERVED_MARGIN_BEFORE_OTHER_COSTS",
        "source_leg_artifact_sha256":LEGS_SHA,"source_drpc_receipt_artifact_sha256":DRPC_SHA,
        "historical_liquidation_event_count":139,"historical_winner_transaction_count":127,
        "total_same_underlying_liquidation_events":same_asset_event_count,
        "weth_weth_only_winner_transaction_count":len(accepted),
        "weth_weth_only_winner_event_count":sum(x["liquidation_event_count"] for x in accepted),
        "raw_weth_leg_surplus_total_wei":str(gross),
        "observed_competitor_gas_total_wei":str(gas),
        "observed_weth_leg_surplus_less_winner_gas_equivalent_wei":str(net),
        "positive_after_gas_winner_tx_count":sum(x["after_historical_gas_positive"] for x in accepted),
        "gross_leg_valuation_is_actual_wallet_pnl":False,
        "complete_flash_and_protocol_fees_proven":False,
        "nexus_same_block_execution_capital_and_gas_proven":False,
        "nexus_capture_probability_calibrated":False,
        "nexus_realized_net_profitability_proven":False,
        "nexus_monthly_pnl_estimate":None,
        "real_market_census_closed":False,
        "entries":accepted}
    report["commitment_sha256"]=sha(canonical(report))
    return report

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--legs",required=True,type=Path)
    p.add_argument("--receipts",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(not a.out.exists(),"append-only economic output required")
    l,r=verify_inputs(a.legs,a.receipts)
    report=evaluate(l,r)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(report))
    print(report["status"],"tx",report["weth_weth_only_winner_transaction_count"],
          "surplus_after_gas_wei",report["observed_weth_leg_surplus_less_winner_gas_equivalent_wei"])

if __name__=="__main__":main()

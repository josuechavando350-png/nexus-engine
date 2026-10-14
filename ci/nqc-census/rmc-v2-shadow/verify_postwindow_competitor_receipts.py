#!/usr/bin/env python3
"""Verify two genuinely executed historical Aave liquidations, READ ONLY.

Index source: immutable Blockscout postwindow ZIP + RMC016 positive control.
Canonical block, tx receipt and exact indexed ABI must agree on two distinct
Ethereum RPC endpoints. Two URLs do NOT independently certify operator identity.
NOT an opportunity Nexus detected or won, not net P&L or an inclusion forecast.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

import blockscout_aave_89390_indexed_research as source
import postwindow_indexed_winner_conflicts as indexed

PROVIDERS={
    "drpc":("dRPC","https://eth.drpc.org"),
    "blast":("BlastAPI","https://eth-mainnet.public.blastapi.io"),
}
WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDT="0xdac17f958d2ee523a2206206994597c13d831ec7"
PINS=[
    {"label":"WETH_COLLATERAL_USDC_DEBT","block":26_142_067,
     "tx":"0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625",
     "log_index":15,"collateral":WETH,"debt":USDC},
    {"label":"WETH_COLLATERAL_USDT_DEBT","block":26_149_038,
     "tx":"0xe05b78bfeff1496c696bc8c9385c8e702352ce02df6a3225fa1d047439cdde91",
     "log_index":165,"collateral":WETH,"debt":USDT},
]
MAX_RPC_BYTES=6_000_000
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
QTY=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
ALLOWED=frozenset(("eth_chainId","eth_getBlockByNumber",
                   "eth_getTransactionReceipt"))

class Rejected(ValueError):pass
def need(cond,why):
    if not cond:raise Rejected(why)
def sha(value):
    return hashlib.sha256(indexed.canon(value)).hexdigest()
def qty(raw,name):
    need(type(raw) is str and QTY.fullmatch(raw) is not None,name+": hex quantity invalid")
    return int(raw,16)
def hex32(raw,name):
    need(type(raw) is str and HEX32.fullmatch(raw) is not None,name+": bytes32 invalid")
    return raw.lower()

def header(raw,expected):
    need(type(raw) is dict and qty(raw.get("number"),"block")==expected,
         "unverifiable canonical block height")
    h=hex32(raw.get("hash"),"block hash")
    parent=hex32(raw.get("parentHash"),"block parent")
    need(h!=parent,"degenerate block ancestry")
    state=hex32(raw.get("stateRoot"),"state root")
    time=qty(raw.get("timestamp"),"block timestamp")
    need(time>0,"missing block time")
    return {"number":expected,"hash":h,"parent_hash":parent,
            "state_root":state,"timestamp":time}

def expected_events(index_rows):
    matched=[]
    for p in PINS:
        rows=[x for x in index_rows if
              x["tx_hash"]==p["tx"] and x["block"]==p["block"] and
              x["log_index"]==p["log_index"] and
              x["collateral_asset"]==p["collateral"] and
              x["debt_asset"]==p["debt"]]
        need(len(rows)==1,"immutable indexer positive-control not unique")
        matched.append((p,rows[0]))
    return matched

def verify_receipt(receipt,head,pin,row):
    need(type(receipt) is dict,"missing Ethereum transaction receipt")
    need(str(receipt.get("transactionHash","")).lower()==pin["tx"],
         "receipt transaction hash mismatched")
    need(qty(receipt.get("blockNumber"),"receipt block")==pin["block"],
         "receipt wrong block")
    need(hex32(receipt.get("blockHash"),"receipt block hash")==head["hash"],
         "receipt not committed to canonical header")
    need(qty(receipt.get("status"),"receipt status")==1,"transaction reverted")
    need(qty(receipt.get("transactionIndex"),"receipt tx order")==
         row["transaction_index"],"transaction ordering changed")
    gas=qty(receipt.get("gasUsed"),"receipt gasUsed")
    price=qty(receipt.get("effectiveGasPrice"),"receipt effective gas price")
    need(gas>0 and price>0,"missing real gas accounting")
    logs=receipt.get("logs")
    need(type(logs) is list and len(logs)<10_000,"receipt logs missing/capped")
    candidates=[x for x in logs if
                type(x) is dict and
                x.get("address","").lower()==source.POOL and
                qty(x.get("logIndex"),"log ordering")==pin["log_index"]]
    need(len(candidates)==1,"original Aave LiquidationCall absent/duplicated")
    log=candidates[0]
    if "removed" in log:
        need(log["removed"] is False,"log removed/reorged")
    observed=source.normalize(log,pin["block"],pin["block"])
    for key in ("block","tx_hash","transaction_index","log_index",
                "collateral_asset","debt_asset","debt_raw","collateral_raw",
                "borrower_sha256","raw_event_hex_data_sha256","raw_topics","raw_data"):
        need(observed[key]==row[key],"indexed winner raw ABI mismatch: "+key)
    need(hex32(log.get("blockHash"),"event blockHash")==head["hash"],
         "event block differs from canonical")
    return {"label":pin["label"],
       "tx_hash":pin["tx"],"block_number":pin["block"],
       "block_hash":head["hash"],
       "event_log_index":pin["log_index"],
       "indexed_raw_event_sha256":row["raw_event_hex_data_sha256"],
       "canonical_event_raw_sha256":observed["raw_event_hex_data_sha256"],
       "receipt_gas_used_raw":str(gas),
       "receipt_effective_gas_price_wei_raw":str(price),
       "realized_Nexus_revenue_from_this_tx":"0",
       "receipt_event_identity_matches":True,
       "historical_competitor_execution_only":True}

class RPC:
    def __init__(self,provider,transport=None):
        need(provider in PROVIDERS,"unapproved RPC")
        self.provider=provider
        self.label,self.url=PROVIDERS[provider]
        self.transport=transport or self.fetch
        self.calls=0
    @staticmethod
    def fetch(url,method,params):
        need(url in {x[1] for x in PROVIDERS.values()},"unapproved RPC URL")
        need(method in ALLOWED,"write method forbidden")
        payload=json.dumps({"jsonrpc":"2.0","id":7,
                            "method":method,"params":params}).encode()
        req=Request(url,data=payload,headers={"Content-Type":"application/json",
                    "User-Agent":"NQC-RMC-V2-ReadOnlyWinnerReceipt/1"},method="POST")
        try:
            with urlopen(req,timeout=24) as res:
                body=res.read(MAX_RPC_BYTES+1)
            need(len(body)<=MAX_RPC_BYTES,"oversized RPC result")
            result=json.loads(body)
        except (OSError,TimeoutError,ValueError,UnicodeError) as exc:
            raise Rejected("RPC_SOURCE_FAILURE_"+type(exc).__name__+
                           ":"+str(exc)[:130]) from exc
        need(type(result) is dict and
             result.get("jsonrpc")=="2.0" and result.get("id")==7 and
             "error" not in result and "result" in result,
             "RPC error or malformed result")
        return result["result"]
    def call(self,method,params):
        need(method in ALLOWED,"non-read-only call prohibited")
        self.calls+=1
        need(self.calls<=12,"RPC request budget exhausted")
        return self.transport(self.url,method,params)
    def verify(self,events):
        need(qty(self.call("eth_chainId",[]),"chain_id")==1,
             "source not Ethereum mainnet")
        out=[]
        for pin,row in events:
            tag=hex(pin["block"])
            first=header(self.call("eth_getBlockByNumber",[tag,False]),pin["block"])
            receipt=self.call("eth_getTransactionReceipt",[pin["tx"]])
            witness=verify_receipt(receipt,first,pin,row)
            last=header(self.call("eth_getBlockByNumber",[tag,False]),pin["block"])
            need(first==last,"block changed/reorg during receipt verification")
            out.append({"header":first,"receipt_witness":witness})
        return out

def run(zip_data,transport=None,provider_ids=("drpc","blast")):
    need(type(provider_ids) in (tuple,list) and
         len(provider_ids)==2 and set(provider_ids)==set(PROVIDERS),
         "two distinct documented RPC endpoints required")
    indexed_rows=indexed.authenticate_archive(zip_data)
    events=expected_events(indexed_rows)
    proofs={}
    for provider in provider_ids:
        proofs[provider]=RPC(provider,transport).verify(events)
    need(proofs["drpc"]==proofs["blast"],
         "independent RPC results disagree on header/receipt/ABI/gas")
    return {"schema_version":1,
      "contract":"NQC_RMC_V2_TWO_RPC_POSTWINDOW_KNOWN_COMPETITOR_LIQUIDATION_RECEIPTS",
      "status":"TWO_PUBLIC_RPC_HISTORICAL_RECEIPT_PARITY_NO_NEXUS_CAPTURE",
      "source_indexer_artifact_sha256":indexed.ZIP_SHA,
      "source_positive_events":[p["label"] for p,_ in events],
      "rpc_provider_ids":sorted(proofs),
      "different_public_rpc_urls_not_proven_independent_operators":True,
      "historical_receipt_witnesses":proofs["drpc"],
      "full_89390_block_completeness_certified":False,
      "competitive_ex_ante_Nexus_capture_probability_calibrated":False,
      "net_execution_after_gas_builder_swap_flash_costs_proven":False,
      "external_nonrecourse_gas_funding_proven":False,
      "canary_live_authorized":False,
      "nqc_realized_pnl_usd":"0",
      "RMC_closed":False,"P2_shadow_certified":False,
      "commercial_score_upgrade":False}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--indexer-artifact",required=True,type=Path)
    ap.add_argument("--out",required=True,type=Path)
    args=ap.parse_args()
    result=run(args.indexer_artifact.read_bytes())
    args.out.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(result["status"],result["source_positive_events"])

if __name__=="__main__":main()

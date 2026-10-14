#!/usr/bin/env python3
"""Public Blockscout read-only POSITIVE historic Aave LiquidationCall test.

A REST indexer is untrusted until it reproduces a known positive Ethereum
event. Even a matching single event NEVER establishes index completeness,
canonical HF state, opportunity capture or revenue.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

BASE="https://eth.blockscout.com/api"
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
LIQ="0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
BLOCK=25938048
HASH="0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4"
TX="0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba"
WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
PRINCIPAL=10684013854557827871
SEIZED_WETH_RAW=10780169979248848321
BORROWER="0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3"
LIQUIDATOR="0x9e3e25dcc3ed4a97e6fdcb166280a248d8c42219"
EVENT_SHA256="d25b174177afd25fc6b789a4d76bad535120a9a883209ee7205a49d703d73949"
PIN_ORIGINAL_RMC016_SHA="6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
MAX_PAYLOAD=2_000_000
HEX64=re.compile(r"0x[0-9a-f]{64}\Z")

class Rejected(ValueError): pass
def need(ok,why):
    if not ok:raise Rejected(why)
def address(t):
    need(type(t) is str and HEX64.fullmatch(t.lower()) is not None
         and t.lower()[2:26]=="0"*24,"bad ABI indexed address")
    return "0x"+t.lower()[-40:]
def strict_json(raw):
    def no_dups(pairs):
        d={}
        for k,v in pairs:
            need(k not in d,"duplicate key in API response")
            d[k]=v
        return d
    try:return json.loads(raw,object_pairs_hook=no_dups)
    except (UnicodeError,TypeError,ValueError) as e:
        raise Rejected("malformed Blockscout indexer JSON") from e

def validate(d):
    need(type(d) is dict and d.get("status")=="1" and
         type(d.get("result")) is list,"known-positive source returned no events/error")
    events=d["result"]
    need(0<len(events)<950,"known-positive indexed results empty or truncated")
    matched=[]
    seen=set()
    for e in events:
        need(type(e) is dict and
             str(e.get("address","")).lower()==POOL,
             "log origin differs from Aave V3 Pool")
        topics=e.get("topics")
        need(type(topics) is list and len(topics)==4 and
             str(topics[0]).lower()==LIQ,"invalid indexed LiquidationCall")
        collateral=address(topics[1]);debt=address(topics[2]);address(topics[3])
        raw=e.get("data")
        need(type(raw) is str and re.fullmatch("0x[0-9a-fA-F]{256}",raw),
             "liquidation raw ABI unavailable")
        num=e.get("blockNumber")
        need(type(num) is str and int(num,16)==BLOCK,
             "event missing historical block height")
        # The classic Blockscout REST logs response omits blockHash.
        # NEVER claim it was provided; bind positive raw ABI to the exact
        # canonical BlockHash already authenticated in original RMC016.
        indexer_supplied_hash = "blockHash" in e
        if indexer_supplied_hash:
            need(str(e["blockHash"]).lower()==HASH,
                 "event canonical block hash mismatch")
        tx=str(e.get("transactionHash","")).lower()
        need(HEX64.fullmatch(tx) is not None,"transaction hash malformed")
        idx=e.get("logIndex")
        need(type(idx) is str,"log index missing")
        k=(tx,int(idx,16))
        need(k not in seen,"duplicate log index for transaction")
        seen.add(k)
        if tx==TX:
            # Known RMC016 winning liquidation exact WETH/WETH repaid amount,
            # NOT a bot-owned/captured liquidation or profitable outcome.
            need(collateral==WETH and debt==WETH and
                 int(raw[2:66],16)==PRINCIPAL and
                 int(raw[66:130],16)==SEIZED_WETH_RAW and
                 address(topics[3])==BORROWER and
                 address("0x"+raw[130:194])==LIQUIDATOR and
                 int(raw[194:258],16)==0 and
                 e.get("transactionIndex")=="0x1" and idx=="0x15",
                 "winner indexed event differs from immutable Aave proof")
            proof={
              "pool":POOL,
              "topics":[str(x).lower() for x in topics],
              "data":raw.lower(),
              "block_hash":HASH,
              "block_number":BLOCK,
              "tx_hash":TX,
              "tx_index":1,
              "log_index":21,
            }
            expected_raw_event_sha=hashlib.sha256(
                (json.dumps(proof,sort_keys=True,
                  separators=(',',':'),ensure_ascii=True)+chr(10)).encode()
            ).hexdigest()
            need(expected_raw_event_sha==EVENT_SHA256,
                 "indexer raw event fails immutable original event SHA256")
            matched.append({"source_log":e,
                            "indexer_supplied_block_hash":indexer_supplied_hash,
                            "original_event_sha256":expected_raw_event_sha})
    need(len(matched)==1,"original rank-one winner not uniquely retrieved")
    return {
        "schema_version":1,
        "contract":"NQC_V2_BLOCKSCOUT_POSITIVE_AAVE_INDEXER_ANCHOR",
        "status":"KNOWN_REAL_WETH_WETH_LIQUIDATION_INDEXED_ONCE_NOT_QUORUM",
        "chain_id_assumed_but_not_verified":1,
        "original_RMC016_events_artifact_sha256":PIN_ORIGINAL_RMC016_SHA,
        "historical_block":BLOCK,
        "winning_tx":TX,
        "winning_block_hash":HASH,
        "authentic_debt_paid_wei":str(PRINCIPAL),
        "matching_real_liquidation_events":len(matched),
        "matching_original_raw_event_sha256":EVENT_SHA256,
        "indexer_supplied_canonical_block_hash":matched[0]["indexer_supplied_block_hash"],
        "canonical_block_hash_provenance":"PRIOR_IMMUTABLE_RMC016_NOT_FROM_BLOCKSCOUT_WHEN_MISSING",
        "all_indexed_aave_liquidation_events_in_that_block":len(events),
        "raw_log_replay_from_independent_rpc_certified":False,
        "whole_indexer_history_complete_certified":False,
        "Nexus_won_liquidation":False,"nqc_realized_pnl_usd":"0",
        "p2_shadow_certified":False,"rmc_closed":False,
        "commercial_score_upgrade":False,
    }

def fetch():
    url=BASE+"?"+urlencode({
        "module":"logs","action":"getLogs","fromBlock":BLOCK,"toBlock":BLOCK,
        "address":POOL,"topic0":LIQ
    })
    req=Request(url,method="GET",headers={
        "Accept":"application/json","User-Agent":"NQC-V2-Positive-Indexer-Probe/1"})
    try:
        with urlopen(req,timeout=35) as res:raw=res.read(MAX_PAYLOAD+1)
    except (HTTPError,URLError,TimeoutError,OSError) as err:
        raise Rejected("SOURCE_NOT_AVAILABLE:"+type(err).__name__+
                       ":"+str(err)[:180]) from err
    need(len(raw)<=MAX_PAYLOAD,"unbounded API response")
    return raw

def main():
    a=argparse.ArgumentParser();a.add_argument("--out-dir",required=True,type=Path)
    ns=a.parse_args();need(ns.out_dir.is_dir(),"output directory absent")
    raw=fetch()
    (ns.out_dir/"raw-blockscout-known-positive.json").write_bytes(raw)
    d=validate(strict_json(raw))
    d["raw_indexer_response_sha256"]=hashlib.sha256(raw).hexdigest()
    (ns.out_dir/"positive-anchor.json").write_text(
        json.dumps(d,indent=2,sort_keys=True)+"\n")
    print(d["status"],d["winning_tx"])

if __name__=="__main__":main()

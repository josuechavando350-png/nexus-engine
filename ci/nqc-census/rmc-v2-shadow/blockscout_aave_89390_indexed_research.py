#!/usr/bin/env python3
"""NQC RMC V2: bounded untrusted Aave indexer period discovery; NO P2.

First demand that REST indexer matches 139 exact original Aave event count and
127 distinct winning transactions in previous RMC016 period. Only then inspect
new 89,390-block postwindow. Indexer results are CANDIDATE DISCOVERY ONLY;
canonical block identity, log/receipt, HF and portfolio costs must be replayed
against independently authenticated Ethereum RPC operators.
"""
from __future__ import annotations
import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
from time import sleep
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
TOPIC="0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
SUSDE="0x9d39a5de30e57443bff2a8307a4256c8797a3497"
USDTB="0xc139190f447e929f090edeb554d95abb8b18ac1c"
URL="https://eth.blockscout.com/api"
BASE_START=25880316
BASE_END=26095351
POST_START=26095352
POST_END=26184741
BASE_EVENTS=139
BASE_TX=127
RANK1_TX="0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba"
RANK1_BLOCK=25938048
RANK1_DEBT_RAW=10684013854557827871
RANK1_COLLATERAL_RAW=10780169979248848321
RANK1_COLLATERAL="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
RANK1_EVENT_SHA="d25b174177afd25fc6b789a4d76bad535120a9a883209ee7205a49d703d73949"
RANK1_BH="0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4"
SOURCE_RMC016_SHA="6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
MAX_BODY=3_000_000
MAX_LOGS=950
HEX64=re.compile(r"0x[0-9a-f]{64}\Z")
HEXN=re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")

class Rejected(ValueError):
    pass

def need(cond,why):
    if not cond: raise Rejected(why)

def sha(b):return sha256(b).hexdigest()

def canonical(v):
    return (json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def strict_json(data):
    def no_duplicate(fields):
        d={}
        for k,v in fields:
            need(k not in d,"duplicate JSON data key")
            d[k]=v
        return d
    try:return json.loads(data,object_pairs_hook=no_duplicate)
    except (ValueError,UnicodeError,TypeError) as e:
        raise Rejected("malformed or duplicate-key JSON result") from e

def qty(raw,label):
    need(type(raw) is str and HEXN.fullmatch(raw.lower()) is not None,
         label+": noncanonical hex quantity")
    return int(raw,16)

def address(raw,label):
    need(type(raw) is str and HEX64.fullmatch(raw.lower()) is not None
         and raw.lower()[2:26]=="0"*24,
         label+": incorrect address ABI padding")
    return "0x"+raw.lower()[-40:]

def normalize(log,lo,hi):
    need(type(log) is dict and str(log.get("address","")).lower()==POOL,
         "log is not from Aave Pool")
    topics=log.get("topics")
    need(type(topics) is list and len(topics)==4 and
         str(topics[0]).lower()==TOPIC, "unexpected event signature")
    coll=address(topics[1],"collateral")
    debt=address(topics[2],"debt")
    borrower=address(topics[3],"borrower")
    bh=log.get("blockHash")
    if bh is not None:
        need(type(bh) is str and HEX64.fullmatch(bh.lower()) is not None,
             "indexed blockHash malformed")
    tx=str(log.get("transactionHash","")).lower()
    need(HEX64.fullmatch(tx) is not None,"unavailable transaction hash")
    data=log.get("data")
    need(type(data) is str and re.fullmatch("0x[0-9a-fA-F]{256}",data),
         "raw LiquidationCall integer ABI unavailable")
    block=qty(log.get("blockNumber"),"blockNumber")
    need(lo<=block<=hi,"indexed event outside requested window")
    logidx=qty(log.get("logIndex"),"logIndex")
    txidx=qty(log.get("transactionIndex"),"transactionIndex")
    debt_raw=int(data[2:66],16)
    coll_raw=int(data[66:130],16)
    need(debt_raw>0 and coll_raw>0,"zero debt/collateral amount from indexed source")
    need(data[130:154]=='0'*24 and int(data[194:258],16) in (0,1),
         "liquidator/receiveAToken ABI malformed")
    return {
      "block":block,"block_hash_indexer":bh.lower() if bh is not None else None,
      "tx_hash":tx,"transaction_index":txidx,"log_index":logidx,
      "collateral_asset":coll,"debt_asset":debt,
      "debt_raw":str(debt_raw),"collateral_raw":str(coll_raw),
      "borrower_sha256":sha(borrower.encode()),
      "raw_event_hex_data_sha256":sha(data.lower().encode()),
      # This indexed source cannot independently authenticate a missing blockHash.
      "raw_topics":[str(x).lower() for x in topics],
      "raw_data":data.lower(),
    }

def classify(raw,lo,hi,*,require_any=False):
    need(type(raw) is dict and "result" in raw and
         type(raw.get("status")) is str and type(raw.get("message")) is str,
         "indexer response does not prove successful query")
    if raw["status"]=="0":
        need(type(raw["result"]) is list and raw["result"]==[] and
             raw["message"].strip().lower() in
             ("no records found","no logs found","no records","no logs"),
             "provider error cannot be an empty result")
    else:
        need(raw["status"]=="1" and type(raw["result"]) is list,
             "indexer did not return event list")
    rows=raw["result"]
    need(len(rows)<MAX_LOGS,"indexer response may be truncated or paginated")
    need(not require_any or len(rows)>0,"positive-control corpus unexpectedly empty")
    out=[normalize(x,lo,hi) for x in rows]
    ids=[(x["block"],x["tx_hash"],x["log_index"]) for x in out]
    need(len(ids)==len(set(ids)),"duplicate indexed LiquidationCall")
    return sorted(out,key=lambda x:(x["block"],x["transaction_index"],x["log_index"]))

def require_rank1(rows):
    ranked=[x for x in rows if x["tx_hash"]==RANK1_TX]
    need(len(ranked)==1,"rank1 original transaction missing/duplicated in index")
    x=ranked[0]
    need(x["block"]==RANK1_BLOCK and
         x["collateral_asset"]==RANK1_COLLATERAL and
         x["debt_asset"]==RANK1_COLLATERAL and
         int(x["debt_raw"])==RANK1_DEBT_RAW and
         int(x["collateral_raw"])==RANK1_COLLATERAL_RAW and
         x["transaction_index"]==1 and x["log_index"]==21,
         "rank1 original onchain integer event mismatched")
    # The REST API usually omits blockHash. Reconstruct the previously
    # published original event commitment with its original block hash ONLY.
    proof={
       "pool":POOL,"topics":x["raw_topics"],"data":x["raw_data"],
       "block_hash":RANK1_BH,"block_number":RANK1_BLOCK,
       "tx_hash":RANK1_TX,"tx_index":1,"log_index":21,
    }
    need(sha(canonical(proof))==RANK1_EVENT_SHA,
         "raw ABI event differs from original RMC016 SHA256")
    return x

def report(base_data,post_data,base_raw,post_raw):
    base=classify(base_data,BASE_START,BASE_END,require_any=True)
    ids={x["tx_hash"] for x in base}
    need(len(base)==BASE_EVENTS and len(ids)==BASE_TX,
         "indexer original 139-event/127-tx corpus mismatch")
    a=require_rank1(base)
    post=classify(post_data,POST_START,POST_END)
    # An all-zero across the entire Pool is suspicious; do not accept a
    # second-indexer zero as an Ethereum-wide negative without receipt parity.
    need(len(post)>0,"POSTWINDOW_EMPTY_POOL_LOGS_UNVERIFIED_INDEXER")
    targeted=[x for x in post if
              x["collateral_asset"] in (SUSDE,USDTB) or
              x["debt_asset"] in (SUSDE,USDTB)]
    summaries={
      "total_aave_liquidation_logs_indexed":len(post),
      "unique_winner_transactions_indexed":len({x["tx_hash"] for x in post}),
      "with_susde":sum(SUSDE in (x["collateral_asset"],x["debt_asset"]) for x in post),
      "with_usdtb":sum(USDTB in (x["collateral_asset"],x["debt_asset"]) for x in post),
      "susde_collateral_usdtb_debt":sum(
          x["collateral_asset"]==SUSDE and x["debt_asset"]==USDTB for x in post),
      "usdtb_collateral_susde_debt":sum(
          x["collateral_asset"]==USDTB and x["debt_asset"]==SUSDE for x in post),
      "targeted_liquidation_event_count":len(targeted),
    }
    return {
      "schema_version":1,
      "contract":"NQC_V2_AAVE_POSTWINDOW_INDEXED_DISCOVERY_NOT_CANONICAL",
      "status":"OLD_WINDOW_CARDINALITY_MATCH_NEW_TARGETED_INDEX_HINTS_NOT_P2",
      "chain_id_assumed_not_verified_independently":1,
      "original_provenance_artifact_sha256":SOURCE_RMC016_SHA,
      "original_window":{"start":BASE_START,"end":BASE_END,
                         "indexed_event_count":len(base),
                         "indexed_winner_tx_count":len(ids)},
      "known_positive_rank1_transaction_in_original_window":RANK1_TX,
      "known_positive_exact_original_event_commitment_sha256":RANK1_EVENT_SHA,
      "rank1_rest_api_omitted_block_hash":a["block_hash_indexer"] is None,
      "post_window":{"start":POST_START,"end":POST_END},
      "postwindow_indexed_stats":summaries,
      "targeted_historical_index_hints":[{
            k:v for k,v in x.items() if k not in ("raw_topics","raw_data")
       } for x in targeted],
      "original_source_response_sha256":sha(base_raw),
      "new_source_response_sha256":sha(post_raw),
      "rest_source_url":URL,
      "provider_response_under_950_log_cap":True,
      "indexer_full_event_completeness_certified":False,
      "original_event_by_event_139_log_parity_certified":False,
      "postwindow_canonical_block_receipts_independently_verified":False,
      "postwindow_full_RPC_two_operator_quorum":False,
      "no_negative_zero_claim_about_other_chains_protocols":True,
      "no_Nexus_capture_calibration":True,
      "no_Nexus_realized_revenue":True,
      "nqc_realized_pnl_usd":"0",
      "p2_shadow_certified":False,"rmc_closed":False,
      "commercial_score_upgrade":False,
    }

def api_logs(start,end):
    u=URL+"?"+urlencode({
        "module":"logs","action":"getLogs","fromBlock":start,"toBlock":end,
        "address":POOL,"topic0":TOPIC,
    })
    req=Request(u,method="GET",headers={
        "Accept":"application/json","User-Agent":"NQC-RMC-V2-ReadOnly-Aave-Indexer-Crosscheck/1"})
    try:
        with urlopen(req,timeout=55) as stream:raw=stream.read(MAX_BODY+1)
    except (HTTPError,URLError,TimeoutError,OSError) as e:
        raise Rejected("INDEXER_HTTP_OR_NETWORK_ERROR:"+type(e).__name__+
                       ":"+str(e)[:180]) from e
    need(len(raw)<=MAX_BODY,"indexed response exceeded byte limit")
    return raw

def main():
    a=argparse.ArgumentParser();a.add_argument('--out-dir',required=True,type=Path)
    args=a.parse_args()
    need(args.out_dir.is_dir(),"artifact output folder absent")
    old_raw=api_logs(BASE_START,BASE_END)
    (args.out_dir/'raw-old-rmc016-indexer.json').write_bytes(old_raw)
    old=strict_json(old_raw)
    old_rows=classify(old,BASE_START,BASE_END,require_any=True)
    need(len(old_rows)==BASE_EVENTS and
         len({x["tx_hash"] for x in old_rows})==BASE_TX,
         "indexer cannot reconcile old 139-event/127-winner period")
    require_rank1(old_rows)
    sleep(3) # rate respectful, not a provider quota workaround
    new_raw=api_logs(POST_START,POST_END)
    (args.out_dir/'raw-new-postwindow-indexer.json').write_bytes(new_raw)
    new=strict_json(new_raw)
    result=report(old,new,old_raw,new_raw)
    (args.out_dir/'indexed-postwindow-research.json').write_bytes(canonical(result))
    print(result["status"],result["postwindow_indexed_stats"])

if __name__=='__main__':main()

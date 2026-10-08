#!/usr/bin/env python3
"""Read-only full-window Aave LiquidationCall discovery and receipt collection.

One-provider discovery is NOT independent temporal authority or Nexus P&L.
Runs with exact RMC015B anchor; no estimates, signing or broadcasts.
"""
from __future__ import annotations
import argparse, hashlib, json, re, sys, time
from pathlib import Path
from rmc016_probe_historical_rpc import (
    AAVE_POOL, CHAIN_ID, START_BLOCK, START_HASH, END_BLOCK, END_HASH,
    LIQUIDATION_TOPIC, PROVIDERS, rpc, as_hex_quantity, checked_header, checked_log,
)

EVENTS_EXPECTED = 139
WINNERS_EXPECTED = 127
MAX_CALLS = 1200
MAX_SPLITS = 11
HEX = re.compile(r"^0x[0-9a-f]{64}$")

def need(v, message):
    if not v: raise ValueError(message)
def canonical(v):
    return (json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True)+"\n").encode()
def sha(v):
    return hashlib.sha256(v).hexdigest()
def quantity(v, name):
    need(type(v) is str, name+" missing hex")
    return as_hex_quantity(v.lower(), name)

def event(raw, lo, hi):
    need(type(raw) is dict, "log not a mapping")
    row = dict(raw)
    for k in ("address","blockHash","transactionHash","data",
              "blockNumber","transactionIndex","logIndex"):
        if type(row.get(k)) is str: row[k] = row[k].lower()
    if type(row.get("topics")) is list:
        row["topics"] = [x.lower() if type(x) is str else x for x in row["topics"]]
    checked_log(row,lo,hi)
    n = quantity(row.get("blockNumber"),"blockNumber")
    log = quantity(row.get("logIndex"),"logIndex")
    txi = quantity(row.get("transactionIndex"),"transactionIndex")
    need(row.get("removed") is False,"removed/reorg log")
    proof = {"pool":row["address"],"topics":row["topics"],"data":row["data"],
             "block_hash":row["blockHash"],"block_number":n,
             "tx_hash":row["transactionHash"],"tx_index":txi,"log_index":log}
    return {"block_number":n,"block_hash":row["blockHash"],
            "transaction_hash":row["transactionHash"],
            "transaction_index":txi,"log_index":log,
            "event_commitment_sha256":sha(canonical(proof))}
def sortkey(v):
    return (v["block_number"],v["transaction_index"],v["log_index"],v["transaction_hash"])

def split_allowed(error):
    s = str(error).lower()
    if any(x in s for x in ("403","401","429","personal token","unknown state",
                           "forbidden","unauthorized","rate limit","api key")):return False
    return any(x in s for x in ("more than","too many results","range","up to",
                                "timeout","timed out","500","502","503","504",
                                "response exceeds bound"))

def gather(provider, call=rpc, *, chunk=8192, call_budget=MAX_CALLS, receipts=False,
           start=START_BLOCK, end=END_BLOCK, strict_counts=True, min_rpc_interval=0.0):
    need(provider in PROVIDERS,"noncanonical provider")
    need(type(start) is int and type(end) is int and START_BLOCK<=start<=end<=END_BLOCK,
         "invalid block range")
    need(type(chunk) is int and 0<chunk<=262144, "invalid chunk")
    need(type(min_rpc_interval) in (int,float) and 0<=min_rpc_interval<=30,
         "invalid rate limit spacing")
    need(type(call_budget) is int and 3<call_budget<=5000,"invalid budget")
    name,operator,url=provider
    calls = 0
    last_rpc_at = None
    errors = []
    shards = []
    events = []
    gas_rows = []
    def query(method,params):
        nonlocal calls, last_rpc_at
        need(calls<call_budget,"RPC_CALL_BUDGET_EXHAUSTED")
        if last_rpc_at is not None and min_rpc_interval:
            remaining=min_rpc_interval-(time.monotonic()-last_rpc_at)
            if remaining>0:time.sleep(remaining)
        last_rpc_at=time.monotonic()
        calls+=1
        try:
            return call(url,method,params)
        except Exception as e:
            raise ValueError(f"{method}: {type(e).__name__}: {str(e)[:180]}") from e
    def scan(a,b,depth=0):
        need(a<=b and START_BLOCK<=a and b<=END_BLOCK,"invalid shard")
        try:
            result=query("eth_getLogs",[{"address":AAVE_POOL,"topics":[LIQUIDATION_TOPIC],
                          "fromBlock":hex(a),"toBlock":hex(b)}])
        except Exception as exc:
            if a<b and depth<MAX_SPLITS and split_allowed(exc):
                mid=(a+b)//2
                scan(a,mid,depth+1)
                scan(mid+1,b,depth+1)
                return
            errors.append({"start":a,"end":b,"reason":str(exc)[:250]})
            raise
        need(type(result) is list,"eth_getLogs result not a list")
        need(len(result)<1000,"possible 1000-log truncation")
        values=[event(x,a,b) for x in result]
        need(len(values)==len({sortkey(x) for x in values}),"duplicated log in shard")
        values.sort(key=sortkey)
        events.extend(values)
        shards.append({"start":a,"end":b,"logs":len(values),
                       "canonical_sha256":sha(b"".join(canonical(x) for x in values))})
    def blocked(exc):
        return {"schema_version":1,"status":"RMC016_FULL_HISTORICAL_LOG_RECOVERY_BLOCKED",
                "provider_id":name,"operator":operator,
                "range":{"start":start,"end":end},
                "rpc_min_interval_seconds":min_rpc_interval,
                "rpc_calls":calls,"completed_shards":len(shards),"partial_logs":len(events),
                "partial_events_sha256":sha(b"".join(canonical(e) for e in sorted(events,key=sortkey))),
                "partial_shard_coverage":shards,
                "failure_type":type(exc).__name__,"failure":str(exc)[:300],
                "shard_failures":errors,"coverage_complete":False,
                "independent_provider_consensus":False,"nexus_pnl_proven":False,
                "real_market_census_closed":False},[],[],[]
    try:
        need(quantity(query("eth_chainId",[]),"chainId")==CHAIN_ID,"wrong chain")
        first=checked_header(query("eth_getBlockByNumber",[hex(START_BLOCK),False]),
                            START_BLOCK,START_HASH)
        last=checked_header(query("eth_getBlockByNumber",[hex(END_BLOCK),False]),
                           END_BLOCK,END_HASH)
        for a in range(start,end+1,chunk):
            scan(a,min(end,a+chunk-1))
        shards.sort(key=lambda x:x["start"])
        cursor=start
        for s in shards:
            need(s["start"]==cursor,"gap or overlap in shard coverage")
            cursor=s["end"]+1
        need(cursor==end+1,"incomplete final shard")
        events.sort(key=sortkey)
        need(len(events)==len({sortkey(e) for e in events}),"duplicate historical event")
        need(len(events)==len({(e["block_hash"],e["transaction_hash"],e["log_index"]) for e in events}),
             "duplicate block/tx/log ID")
        ids=sorted(set(e["transaction_hash"] for e in events))
        conserved=(len(events)==EVENTS_EXPECTED and len(ids)==WINNERS_EXPECTED)
        if strict_counts:
            need(start==START_BLOCK and end==END_BLOCK,"partial range cannot pass census counts")
        if receipts and conserved and strict_counts:
            for tid in ids:
                receipt=query("eth_getTransactionReceipt",[tid])
                need(type(receipt) is dict and receipt.get("transactionHash","").lower()==tid,
                     "missing or substituted receipt")
                need(quantity(receipt.get("status"),"status")==1,"failed historical tx")
                b=quantity(receipt.get("blockNumber"),"receipt block")
                need(start<=b<=end,"receipt outside source window")
                bh=receipt.get("blockHash","").lower()
                need(type(bh) is str and HEX.fullmatch(bh) is not None,"receipt block hash invalid")
                logids={(e["log_index"],e["block_hash"]) for e in events if e["transaction_hash"]==tid}
                need(logids and all(h==bh for _,h in logids),"receipt and event block conflict")
                receipt_ids=set()
                for l in receipt.get("logs",[]):
                    if type(l) is dict and str(l.get("address","")).lower()==AAVE_POOL and \
                            type(l.get("topics")) is list and l["topics"] and \
                            str(l["topics"][0]).lower()==LIQUIDATION_TOPIC:
                        receipt_ids.add((quantity(l.get("logIndex"),"receipt log index"),
                                         str(l.get("blockHash","")).lower()))
                need(receipt_ids==logids,"receipt liquidation logs differ from scanned event set")
                gas=quantity(receipt.get("gasUsed"),"gasUsed")
                price=quantity(receipt.get("effectiveGasPrice"),"effectiveGasPrice")
                need(gas>0 and price>0,"receipt lacks gas pricing")
                gas_rows.append({"transaction_hash":tid,"block_number":b,"block_hash":bh,
                                 "gas_used":str(gas),"gas_price_wei":str(price),
                                 "gas_paid_wei":str(gas*price),
                                 "receipt_commitment_sha256":sha(canonical({
                                     "transaction_hash":tid,"block_hash":bh,
                                     "gas_used":gas,"gas_price_wei":price,
                                     "liquidation_log_ids":sorted(receipt_ids)}))})
        report={"schema_version":1,
                "status":("RMC016_SINGLE_SOURCE_WINNER_EVENTS_COUNTS_RECONCILED"
                          if conserved and strict_counts else
                          "RMC016_SINGLE_SOURCE_EVENT_COUNTS_NOT_RECONCILED"),
                "claim_scope":"PUBLIC_HISTORICAL_CHAIN_OBSERVATION_ONLY",
                "provider_id":name,"operator":operator,"chain_id":CHAIN_ID,
                "source_window":{"start_block":START_BLOCK,"start_hash":START_HASH,
                                 "end_block":END_BLOCK,"end_hash":END_HASH},
                "queried_range":{"start":start,"end":end},
                "start_header":first,"end_header":last,
                "coverage_complete":True,"shard_count":len(shards),
                "rpc_min_interval_seconds":min_rpc_interval,
                "rpc_calls":calls,"liquidation_event_count":len(events),
                "unique_winner_transaction_count":len(ids),
                "expected_liquidation_event_count":EVENTS_EXPECTED,
                "expected_winner_transaction_count":WINNERS_EXPECTED,
                "counts_match_source_certificate":conserved and strict_counts,
                "events_sha256":sha(b"".join(canonical(e) for e in events)),
                "transactions_sha256":sha(b"".join((x+"\n").encode() for x in ids)),
                "shards_sha256":sha(b"".join(canonical(x) for x in shards)),
                "receipt_count":len(gas_rows),
                "receipts_complete":len(gas_rows)==len(ids) and bool(gas_rows),
                "observed_market_gas_wei":str(sum(int(x["gas_paid_wei"]) for x in gas_rows))
                                          if gas_rows else None,
                "independent_provider_consensus":False,"historical_usd_net_certified":False,
                "nexus_capture_calibrated":False,"nexus_pnl_proven":False,
                "own_capital_funding_proven":False,"real_market_census_closed":False,
                "next_gate":"INDEPENDENT_PROVIDER_EVENT_AND_RECEIPT_PARITY"}
        report["commitment_sha256"]=sha(canonical(report))
        return report,events,ids,gas_rows
    except Exception as exc:
        failure=blocked(exc)
        return failure[0], sorted(events,key=sortkey), sorted({e["transaction_hash"] for e in events}), []

def write_report(directory, result, events, ids, receipts):
    need(not directory.exists(),"output must be a fresh directory")
    directory.mkdir(parents=True)
    (directory/"discovery-report.json").write_bytes(canonical(result))
    if result.get("coverage_complete"):
        (directory/"liquidation-events.jsonl").write_bytes(b"".join(canonical(x) for x in events))
        (directory/"winner-transactions.txt").write_bytes(b"".join((x+"\n").encode() for x in ids))
        if receipts:
            (directory/"winner-receipts-gas.jsonl").write_bytes(b"".join(canonical(x) for x in receipts))
    if not result.get("coverage_complete") and events:
        (directory/"partial-event-identities.jsonl").write_bytes(b"".join(
            canonical(x) for x in sorted(events,key=sortkey)))
        (directory/"partial-winner-hashes.txt").write_bytes(b"".join(
            (x+"\n").encode() for x in sorted(ids)))
    with (directory/"archive.sha256").open("w") as f:
        for p in sorted(directory.iterdir()):
            if p.is_file() and p.name!="archive.sha256":
                f.write(sha(p.read_bytes())+"  "+p.name+"\n")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--provider",choices=sorted({v[0] for v in PROVIDERS}),default="blockscout")
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--chunk",default=262144,type=int)
    p.add_argument("--min-rpc-interval",default=0.0,type=float)
    p.add_argument("--max-calls",default=MAX_CALLS,type=int)
    p.add_argument("--receipts",action="store_true")
    args=p.parse_args()
    provider=next(x for x in PROVIDERS if x[0]==args.provider)
    result,events,ids,gas=gather(provider,chunk=args.chunk,call_budget=args.max_calls,
                                  receipts=args.receipts,min_rpc_interval=args.min_rpc_interval)
    write_report(args.out,result,events,ids,gas)
    print(result["status"],"events",result.get("liquidation_event_count"),
          "txs",result.get("unique_winner_transaction_count"),
          "calls",result.get("rpc_calls"))
    return 0 if result.get("coverage_complete") and result.get("counts_match_source_certificate") and \
      (not args.receipts or result.get("receipts_complete")) else 2

if __name__=="__main__":
    sys.exit(main())

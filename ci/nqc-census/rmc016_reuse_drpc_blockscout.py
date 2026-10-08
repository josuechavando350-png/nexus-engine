#!/usr/bin/env python3
"""Independent Blockscout receipt parity against immutable 127 dRPC witnesses.

The original dual-RPC workflow authenticated *all 127 dRPC receipts*, then
failed closed at BlastAPI's public rate limit after six additional receipts.
Reuse exact source bytes instead of spending another 127 dRPC requests.
No trading, monthly forecast, price conversion, or Nexus P&L.
"""
from __future__ import annotations
import argparse,hashlib,json,re,sys,time,zipfile
from pathlib import Path
from rmc016_two_operator_receipts import load_source,receipt_normalized,canonical,sha
from rmc016_probe_historical_rpc import PROVIDERS,rpc

SOURCE_SHA="6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
DRPC_PARTIAL_ZIP_SHA="182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6"
DRPC_ROWS_SHA="c486bc5788e306965e0c3924fda1a0264ba0e67c8eb6ebfdc585072676575f78"
BLOCKSCOUT="https://eth.blockscout.com/api/eth-rpc"
EXPECTED=frozenset({"archive.sha256","receipt-parity-report.json","verified-drpc-receipts.jsonl"})
CANONICAL_FIELDS=frozenset({
  "transaction_hash","block_number","block_hash","transaction_index","liquidation_event_count",
  "gas_used","effective_gas_price_wei","execution_gas_wei","blob_gas_wei",
  "total_gas_paid_wei","receipt_evidence_sha256"})
HEX64=re.compile(r"^[0-9a-f]{64}$")

def need(ok,msg):
    if not ok:raise ValueError(msg)
def checked_zip(path:Path,expected_sha:str):
    need(path.is_file(),"missing original receipt ZIP")
    need(sha(path.read_bytes())==expected_sha,"original receipt ZIP SHA-256 mismatch")
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        need(len(names)==len(set(names)) and set(names)==EXPECTED,
             "ZIP missing/extra/duplicate members")
        need(all(x.filename==Path(x.filename).name for x in z.infolist()),
             "unexpected archive directory")
        need(all((x.external_attr>>16)&0o170000 != 0o120000 for x in z.infolist()),
             "ZIP symlink")
        content={k:z.read(k) for k in EXPECTED}
    checksum=content["archive.sha256"].decode("ascii")
    seen=set()
    for line in checksum.splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
             "noncanonical inner SHA")
        d,name=line.split("  ")
        need(name in EXPECTED-{"archive.sha256"} and name not in seen and
             d==sha(content[name]),"inner receipt SHA mismatch")
        seen.add(name)
    need(seen==EXPECTED-{"archive.sha256"},"uncommitted archive member")
    need(sha(content["verified-drpc-receipts.jsonl"])==DRPC_ROWS_SHA,
         "dRPC receipt rows changed from original verified source")
    return content

def admitted_drpc(source_zip:Path,drpc_zip:Path):
    _,events,ids=load_source(source_zip,SOURCE_SHA)
    contents=checked_zip(drpc_zip,DRPC_PARTIAL_ZIP_SHA)
    meta=json.loads(contents["receipt-parity-report.json"])
    need(meta.get("status")=="RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED",
         "unexpected source receipt report status")
    need(meta.get("independent_receipt_parity_complete") is False and
         meta.get("nexus_net_pnl_proven") is False,"source leaked unsupported profits")
    need(meta.get("source_event_artifact_sha256")==SOURCE_SHA,
         "original dRPC receipt evidence bound to different source events")
    stages=meta.get("provider_stages")
    need(type(stages) is list and len(stages)==2 and
         stages[0].get("provider_id")=="drpc" and
         stages[0].get("verified_transaction_count")==127 and
         stages[1].get("provider_id")=="blast" and
         stages[1].get("verified_transaction_count")==6,
         "different incomplete external provider history")
    raw=contents["verified-drpc-receipts.jsonl"]
    need(raw and raw.endswith(b"\n"),"missing canonical dRPC JSONL")
    rows={}
    for line in raw.splitlines():
        x=json.loads(line)
        need(type(x) is dict and set(x)==CANONICAL_FIELDS and
             canonical(x).rstrip(b"\n")==line,
             "dRPC record noncanonical/invalid fields")
        txid=x["transaction_hash"]
        need(txid in events and txid not in rows,"unknown/duplicate source tx")
        h=x["receipt_evidence_sha256"]
        need(type(h) is str and HEX64.fullmatch(h) is not None,"missing receipt commitment")
        without={k:v for k,v in x.items() if k!="receipt_evidence_sha256"}
        need(h==sha(canonical(without)),"receipt evidence self-commitment changed")
        need(type(x["block_number"]) is int and
             all(e["block_number"]==x["block_number"] and
                 e["block_hash"]==x["block_hash"] and
                 e["transaction_index"]==x["transaction_index"] for e in events[txid]),
             "receipt header drift from source")
        need(x["liquidation_event_count"]==len(events[txid]),
             "receipt event count mismatch")
        for k in ("gas_used","effective_gas_price_wei","execution_gas_wei",
                  "blob_gas_wei","total_gas_paid_wei"):
            need(type(x[k]) is str and re.fullmatch(r"(?:0|[1-9][0-9]*)",x[k]),
                 "invalid integer gas provenance")
        need(int(x["gas_used"])*int(x["effective_gas_price_wei"])==
             int(x["execution_gas_wei"]),"invalid EVM gas multiplication")
        need(int(x["execution_gas_wei"])+int(x["blob_gas_wei"])==
             int(x["total_gas_paid_wei"]),"invalid total gas")
        rows[txid]=x
    need(set(rows)==set(ids) and len(rows)==127,"complete dRPC receipt set required")
    return events,ids,rows

def choose_ids(ids,limit):
    need(type(limit) is int and 1<=limit<=127,"invalid deterministic sample size")
    if limit==127:return ids
    if limit==1:return [ids[0]]
    selection=[ids[(i*(len(ids)-1))//(limit-1)] for i in range(limit)]
    need(len(set(selection))==limit,"stratification duplicate")
    return selection

def audit(source:Path,drpc:Path,limit:int,call=rpc,interval:float=0.0):
    events,ids,rows=admitted_drpc(source,drpc)
    target=choose_ids(ids,limit)
    need(type(interval) in (float,int) and 0<=interval<=30,"invalid interval")
    other=next(x for x in PROVIDERS if x[0]=="blockscout")
    need(other[1]=="Blockscout" and other[2]==BLOCKSCOUT,"independent operator changed")
    confirmed=[]
    for txid in target:
        try:
            if interval:time.sleep(interval)
            raw=call(other[2],"eth_getTransactionReceipt",[txid])
            new=receipt_normalized(txid,events[txid],raw)
            need(new==rows[txid],"Blockscout and dRPC receipt disagreement")
            confirmed.append(new)
        except Exception as exc:
            return make_report(ids,target,rows,confirmed,
                               str(type(exc).__name__)+": "+str(exc)[:180])
    return make_report(ids,target,rows,confirmed,None)

def make_report(all_ids,target,drpc,confirmed,blocked):
    complete=(blocked is None and len(target)==127 and len(confirmed)==127)
    total_all=sum(int(x["total_gas_paid_wei"]) for x in drpc.values())
    total_verified=sum(int(x["total_gas_paid_wei"]) for x in confirmed)
    output={"schema_version":1,
            "status":("RMC016_TWO_OPERATOR_127_RECEIPT_PARITY_PASS_NO_NET_CLAIM"
                      if complete else
                      "RMC016_BLOCKSCOUT_DRPC_RECEIPT_SAMPLE_PASS"
                      if blocked is None else
                      "RMC016_BLOCKSCOUT_DRPC_RECEIPT_PARITY_BLOCKED"),
            "claim_scope":"HISTORICAL_MARKET_WINNERS_NOT_NEXUS",
            "source_blockscout_log_artifact_sha256":SOURCE_SHA,
            "source_drpc_receipt_artifact_sha256":DRPC_PARTIAL_ZIP_SHA,
            "provider_ids":["drpc","blockscout"],
            "source_event_count":139,"source_winner_count":127,
            "drpc_verified_receipt_count":127,
            "sample_target_count":len(target),
            "blockscout_verified_receipt_count":len(confirmed),
            "complete_independent_receipt_parity":complete,
            "blocked_reason":blocked,
            "drpc_gas_paid_wei":str(total_all),
            "independently_cross_checked_sample_gas_wei":str(total_verified),
            "all_127_receipt_gas_wei_proven_by_two_operators":str(total_all) if complete else None,
            "checked_txids_sha256":sha(b"".join((x["transaction_hash"]+"\n").encode()
                                     for x in confirmed)),
            "independent_full_historical_event_discovery_proven":False,
            "historical_127_gas_usd_valued":False,
            "nexus_external_capital_and_gas_proven":False,
            "nexus_capture_probability_calibrated":False,
            "nexus_monthly_net_pnl_usd":None,
            "nexus_pnl_proven":False,
            "real_market_census_closed":False}
    output["commitment_sha256"]=sha(canonical(output))
    return output,confirmed

def output_file(directory:Path,report,receipts):
    need(not directory.exists(),"append-only output required")
    directory.mkdir(parents=True)
    (directory/"parity-report.json").write_bytes(canonical(report))
    (directory/"blockscout-verified-receipts.jsonl").write_bytes(
        b"".join(canonical(x) for x in receipts))
    with (directory/"archive.sha256").open("w") as f:
        for p in sorted(directory.iterdir()):
            if p.name!="archive.sha256":
                f.write(sha(p.read_bytes())+"  "+p.name+"\n")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--drpc-receipts",required=True,type=Path)
    p.add_argument("--limit",type=int,default=12)
    p.add_argument("--min-interval",type=float,default=5.0)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    report,receipts=audit(a.source,a.drpc_receipts,a.limit,interval=a.min_interval)
    output_file(a.out,report,receipts)
    print(report["status"],"Blockscout receipts",report["blockscout_verified_receipt_count"],
          "of",report["sample_target_count"])
    return 0 if report["blocked_reason"] is None and (
        (a.limit==127 and report["complete_independent_receipt_parity"]) or
        (a.limit<127 and not report["complete_independent_receipt_parity"])
    ) else 2
if __name__=="__main__":sys.exit(main())

#!/usr/bin/env python3
"""RMC-016: independent two-operator historical winner receipts; never Nexus P&L.

Only exact successful 139-event / 127-tx single-source artifact inputs are
eligible. Receiver never signs, broadcasts or assumes funded gas/principal.
"""
from __future__ import annotations
import argparse, hashlib, json, re, time, zipfile
from collections import defaultdict
from pathlib import Path
from rmc016_probe_historical_rpc import (
    AAVE_POOL, LIQUIDATION_TOPIC, PROVIDERS, START_BLOCK, END_BLOCK,
    START_HASH, END_HASH, rpc, as_hex_quantity,
)
from rmc016_collect_winner_events import event

WANTED = frozenset({"archive.sha256","discovery-report.json",
                    "liquidation-events.jsonl","winner-transactions.txt"})
HEX64 = re.compile(r"^0x[0-9a-f]{64}$")
NUMERIC = re.compile(r"^0x(?:0|[1-9a-f][0-9a-f]*)$")

def need(ok,msg):
    if not ok:raise ValueError(msg)
def canonical(x):
    return (json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()
def sha(x):
    return hashlib.sha256(x).hexdigest()
def num(x,name):
    need(type(x) is str and NUMERIC.fullmatch(x.lower()) is not None,
         name+" must be canonical hex quantity")
    return int(x,16)

def load_source(zip_path:Path, expected_sha:str):
    need(type(expected_sha) is str and len(expected_sha)==64,"expected SHA")
    need(sha(zip_path.read_bytes())==expected_sha,"source ZIP SHA256 drift")
    with zipfile.ZipFile(zip_path) as z:
        names=z.namelist()
        need(len(names)==len(set(names)) and set(names)==WANTED,"missing/extra/duplicate ZIP members")
        for info in z.infolist():
            need(info.filename==Path(info.filename).name,"ZIP path traversal")
            need((info.external_attr>>16)&0o170000 != 0o120000,"symlink forbidden")
        data={n:z.read(n) for n in WANTED}
    declared=data["archive.sha256"].decode("ascii").splitlines()
    checked=set()
    for line in declared:
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
             "noncanonical archive checksum")
        digest,name=line.split("  ")
        need(name in WANTED-{"archive.sha256"} and name not in checked and
             sha(data[name])==digest,"archive SHA mismatch")
        checked.add(name)
    need(checked==WANTED-{"archive.sha256"},"incomplete archive checksum set")
    report=json.loads(data["discovery-report.json"])
    need(type(report) is dict and report.get("status")=="RMC016_SINGLE_SOURCE_WINNER_EVENTS_COUNTS_RECONCILED",
         "event discovery is not admitted")
    need(report.get("provider_id")=="blockscout" and
         report.get("independent_provider_consensus") is False,
         "single-source boundary changed")
    need(report.get("counts_match_source_certificate") is True and
         report.get("coverage_complete") is True and
         report.get("liquidation_event_count")==139 and
         report.get("unique_winner_transaction_count")==127,
         "unexpected event universe")
    need(report.get("source_window",{})=={
         "start_block":START_BLOCK,"start_hash":START_HASH,
         "end_block":END_BLOCK,"end_hash":END_HASH},"source anchor drift")
    need(report.get("nexus_pnl_proven") is False,"fabricated profit claim")
    raw_events=data["liquidation-events.jsonl"]
    need(raw_events.endswith(b"\n") and raw_events,"empty event ledger")
    events=[]
    for line in raw_events.splitlines():
        x=json.loads(line)
        need(type(x) is dict and canonical(x).rstrip(b"\n")==line,
             "noncanonical event JSONL")
        need(type(x.get("transaction_hash")) is str and HEX64.fullmatch(x["transaction_hash"]),
             "event invalid transaction hash")
        need(type(x.get("event_commitment_sha256")) is str and
             re.fullmatch(r"[0-9a-f]{64}",x["event_commitment_sha256"]),
             "missing event commitment")
        need(type(x.get("block_number")) is int and
             START_BLOCK<=x["block_number"]<=END_BLOCK,"event block outside window")
        events.append(x)
    ids=[x.decode("ascii") for x in data["winner-transactions.txt"].splitlines()]
    need(len(events)==139 and len(ids)==127 and ids==sorted(set(ids)),"139/127 identity mismatch")
    need({x["transaction_hash"] for x in events}==set(ids),"event to transaction conservation")
    need(sha(raw_events)==report["events_sha256"] and
         sha(data["winner-transactions.txt"])==report["transactions_sha256"],
         "event hashes not bound to parent")
    expected={}
    for x in events:
        expected.setdefault(x["transaction_hash"],[]).append(x)
    for txid in expected:
        expected[txid].sort(key=lambda x:x["log_index"])
        need(len({(x["block_hash"],x["log_index"]) for x in expected[txid]})==len(expected[txid]),
             "duplicate event lineage in source")
    return report,expected,ids

def receipt_normalized(txid,source_events,raw):
    need(type(raw) is dict and str(raw.get("transactionHash","")).lower()==txid,
         "receipt missing or wrong transactionHash")
    need(num(raw.get("status"),"status")==1,"winner reverted")
    need(type(raw.get("blockHash")) is str and HEX64.fullmatch(raw["blockHash"].lower()),
         "receipt block hash")
    bh=raw["blockHash"].lower()
    block=num(raw.get("blockNumber"),"blockNumber")
    idx=num(raw.get("transactionIndex"),"transactionIndex")
    need(all(x["block_number"]==block and x["block_hash"]==bh and
             x["transaction_index"]==idx for x in source_events),
         "receipt block/index differs from event ledger")
    logs=[]
    for entry in raw.get("logs",[]):
        if type(entry) is not dict or str(entry.get("address","")).lower()!=AAVE_POOL:
            continue
        topics=entry.get("topics")
        if type(topics) is not list or not topics or str(topics[0]).lower()!=LIQUIDATION_TOPIC:
            continue
        x=event(entry,START_BLOCK,END_BLOCK)
        need(x["transaction_hash"]==txid,"receipt Aave liquidation log tx drift")
        logs.append(x)
    logs.sort(key=lambda x:x["log_index"])
    need(logs==source_events,"receipt logs not equal to original LiquidationCall events")
    gas=num(raw.get("gasUsed"),"gasUsed")
    price=num(raw.get("effectiveGasPrice"),"effectiveGasPrice")
    need(gas>0 and price>0,"zero/nonexistent receipt gas")
    blob_used=raw.get("blobGasUsed"); blob_price=raw.get("blobGasPrice")
    need((blob_used is None)==(blob_price is None),"incomplete optional blob fee witness")
    blob=0 if blob_used is None else num(blob_used,"blobGasUsed")*num(blob_price,"blobGasPrice")
    result={"transaction_hash":txid,"block_number":block,"block_hash":bh,
            "transaction_index":idx,"liquidation_event_count":len(logs),
            "gas_used":str(gas),"effective_gas_price_wei":str(price),
            "execution_gas_wei":str(gas*price),
            "blob_gas_wei":str(blob),"total_gas_paid_wei":str(gas*price+blob)}
    result["receipt_evidence_sha256"]=sha(canonical(result))
    return result

def reconcile(receipts_a:dict,receipts_b:dict,source_zip:Path,source_sha:str):
    report,events,ids=load_source(source_zip,source_sha)
    need(set(receipts_a)==set(ids) and set(receipts_b)==set(ids),
         "incomplete independent receipt universe")
    result=[]
    for tid in ids:
        x=receipt_normalized(tid,events[tid],receipts_a[tid])
        y=receipt_normalized(tid,events[tid],receipts_b[tid])
        need(x==y,"independent provider receipt disagreement: "+tid)
        result.append(x)
    result.sort(key=lambda x:x["transaction_hash"])
    total=sum(int(x["total_gas_paid_wei"]) for x in result)
    out={"schema_version":1,"status":"RMC016_TWO_OPERATOR_RECEIPT_CONSISTENCY_ONLY",
         "claim_scope":"ETHEREUM_HISTORICAL_WINNER_RECEIPTS_EXCLUDING_NEXUS",
         "event_count":139,"winner_transaction_count":127,
         "gas_paid_wei":str(total),
         "receipt_records_sha256":sha(b"".join(canonical(x) for x in result)),
         "source_event_artifact_sha256":source_sha,
         "independent_source_log_completeness_certified":False,
         "gas_usd_conversion_completed":False,"fifteen_cost_categories_proven":False,
         "operator_gas_funding_proven":False,"nexus_execution_proven":False,
         "nexus_capture_calibrated":False,"nexus_net_pnl_proven":False,
         "real_market_census_closed":False,"monthly_nexus_pnl_usd":None}
    out["report_sha256"]=sha(canonical(out))
    return out,result

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--event-zip",required=True,type=Path)
    p.add_argument("--event-sha256",required=True)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--providers",nargs=2,default=["drpc","blast"])
    p.add_argument("--min-interval",type=float,default=2.0)
    args=p.parse_args()
    need(args.providers==["drpc","blast"],"must use two fixed independent operators")
    need(0<=args.min_interval<=30,"invalid interval")
    _,events,ids=load_source(args.event_zip,args.event_sha256)
    need(not args.out.exists(),"append-only output")
    args.out.mkdir(parents=True)
    got=[]
    stages=[]
    current="NONE"
    def checksum_manifest():
        with (args.out/"archive.sha256").open("w") as f:
            for path in sorted(args.out.iterdir()):
                if path.is_file() and path.name!="archive.sha256":
                    f.write(sha(path.read_bytes())+"  "+path.name+"\n")
    try:
        for provider_id in args.providers:
            current=provider_id
            provider=next(x for x in PROVIDERS if x[0]==provider_id)
            values={}
            attest=[]
            stages.append({"provider_id":provider_id,"verified_transaction_count":0,
                           "source_scope":"ONE_PROVIDER_RECEIPT_WITNESSES_ONLY"})
            for tid in ids:
                time.sleep(args.min_interval)
                raw=rpc(provider[2],"eth_getTransactionReceipt",[tid])
                need(raw is not None,provider_id+" receipt unavailable")
                record=receipt_normalized(tid,events[tid],raw)
                values[tid]=raw
                attest.append(record)
                stages[-1]["verified_transaction_count"]=len(attest)
            got.append(values)
            (args.out/f"verified-{provider_id}-receipts.jsonl").write_bytes(
                b"".join(canonical(x) for x in attest))
        current="FINAL_CROSS_PROVIDER_PARITY"
        report,rows=reconcile(got[0],got[1],args.event_zip,args.event_sha256)
        (args.out/"receipt-parity-report.json").write_bytes(canonical(report))
        (args.out/"winner-receipt-evidence.jsonl").write_bytes(b"".join(canonical(x) for x in rows))
        checksum_manifest()
        print(report["status"],"transactions",report["winner_transaction_count"],
              "gas_wei",report["gas_paid_wei"])
    except Exception as error:
        report={"schema_version":1,"status":"RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED",
                "source_event_artifact_sha256":args.event_sha256,
                "expected_unique_winner_transaction_count":127,
                "provider_stages":stages,"blocked_at":current,
                "blocking_reason":f"{type(error).__name__}: {str(error)[:240]}",
                "independent_receipt_parity_complete":False,
                "gas_usd_conversion_completed":False,
                "nexus_execution_proven":False,"nexus_capture_calibrated":False,
                "nexus_net_pnl_proven":False,"real_market_census_closed":False}
        (args.out/"receipt-parity-report.json").write_bytes(canonical(report))
        checksum_manifest()
        print(report["status"],"blocked_at",current,"stages",stages)
        raise SystemExit(2) from error

if __name__=="__main__":main()

#!/usr/bin/env python3
"""RMC-016 second-operator verified receipt batch, no NQC capture or P&L authority.

Reads immutable full event ZIP, full dRPC receipt checkpoint and an exact previous
Blockscout partial ZIP. Only NEW observed Blockscout receipts are requested.
Never re-promotes a failed parent workflow or fabricates economic costs.
"""
from __future__ import annotations

import argparse
import json
import re
import time
import zipfile
from pathlib import Path

from rmc016_resume_verified_receipts import (
    SOURCE_ARTIFACT_SHA256, DRPC_CHECKPOINT_SHA256, CHECKPOINT_COLUMNS,
    authenticated_drpc_checkpoint, canonical, need, receipt_normalized, rpc, sha,
)
from rmc016_two_operator_receipts import PROVIDERS

PREVIOUS_SHA256 = "85e2ad6262d556a69c210469419feaab3966693b955f332579b9c28bc2cbbafc"
PREVIOUS_RUN_ID = 37721369826
PREVIOUS_ARTIFACT_ID = 11525806907
PREVIOUS_MEMBERS = {"archive.sha256", "receipt-parity-report.json",
                    "verified-blockscout-receipts.jsonl"}
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")

def unsigned(value, field):
    need(type(value) is str and DECIMAL.fullmatch(value) is not None,
         field+" must be unsigned canonical decimal")
    return int(value)

def validate_prior_row(row, expected, events):
    need(type(row) is dict and set(row)==CHECKPOINT_COLUMNS, "invalid prior receipt field set")
    tx=row["transaction_hash"]
    need(type(tx) is str and tx in events, "unknown prior receipt")
    for field in ("block_number","transaction_index","liquidation_event_count"):
        need(type(row[field]) is int and row[field]>=0, "invalid prior ordering/count")
    need(all(e["block_number"]==row["block_number"] and
             e["block_hash"]==row["block_hash"] and
             e["transaction_index"]==row["transaction_index"]
             for e in events[tx]), "prior block identity differs")
    need(row["liquidation_event_count"]==len(events[tx]), "prior event count differs")
    gas=unsigned(row["gas_used"],"gas")
    price=unsigned(row["effective_gas_price_wei"],"effective price")
    exec_cost=unsigned(row["execution_gas_wei"],"execution wei")
    blob_cost=unsigned(row["blob_gas_wei"],"blob wei")
    total=unsigned(row["total_gas_paid_wei"],"total wei")
    need(gas>0 and price>0 and exec_cost==gas*price and
         total==exec_cost+blob_cost, "prior gas arithmetic")
    witness=row["receipt_evidence_sha256"]
    need(type(witness) is str and DIGEST.fullmatch(witness), "prior witness invalid")
    computed=sha(canonical({k:v for k,v in row.items()
                            if k!="receipt_evidence_sha256"}))
    need(computed==witness,"prior receipt content witness altered")
    need(row==expected[tx], "prior independent receipt differs from dRPC")
    return tx

def load_prior(path, expected_sha, drpc, events, txids):
    need(path.is_file() and sha(path.read_bytes())==expected_sha,
         "previous Blockscout ZIP SHA256 differs")
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        need(len(names)==len(set(names)) and set(names)==PREVIOUS_MEMBERS,
             "prior archive members incorrect")
        for m in z.infolist():
            need(m.filename==Path(m.filename).name and
                 (m.external_attr >> 16)&0o170000 != 0o120000,
                 "unsafe previous ZIP member")
        contents={name:z.read(name) for name in names}
    hashes=set()
    for line in contents["archive.sha256"].decode("ascii").splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
             "invalid prior archive manifest line")
        value,name=line.split("  ")
        need(name in PREVIOUS_MEMBERS-{"archive.sha256"} and name not in hashes
             and sha(contents[name])==value, "prior archive member digest mismatch")
        hashes.add(name)
    need(hashes==PREVIOUS_MEMBERS-{"archive.sha256"},"prior archive checksum incomplete")
    report=json.loads(contents["receipt-parity-report.json"])
    need(type(report) is dict and
         report.get("status") in {
            "RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED",
            "RMC016_SECOND_OPERATOR_BATCH_CHECKPOINT_PARTIAL"
         } and report.get("nexus_realized_pnl_proven") is False and
         report.get("real_market_census_closed") is False and
         report.get("historical_source_artifact_sha256",
                    report.get("source_event_artifact_sha256"))==SOURCE_ARTIFACT_SHA256 and
         report.get("prior_drpc_checkpoint_artifact_sha256",
                    report.get("drpc_source_checkpoint_artifact_sha256"))==DRPC_CHECKPOINT_SHA256,
         "prior Blockscout source boundary differs")
    if report["status"]=="RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED":
        need(report.get("independent_receipt_parity_complete") is False and
             report.get("first_operator")=="dRPC" and
             report.get("second_operator")=="Blockscout" and
             report.get("dRPC_receipts_verified_from_checkpoint")==127,
             "prior failed-run stages differ")
    else:
        need(report.get("all_127_receipts_cross_operator_reconciled") is False and
             report.get("independent_full_window_log_consensus") is False and
             report.get("nexus_gas_funding_proven") is False and
             report.get("nexus_execution_proven") is False and
             report.get("nexus_capture_probability_calibrated") is False,
             "prior batch exceeds receipt-only authority")
    prior_raw=contents["verified-blockscout-receipts.jsonl"]
    prev_digest=report.get("partial_evidence_sha256",
                           report.get("verified_receipts_sha256"))
    need(type(prev_digest) is str and sha(prior_raw)==prev_digest,
         "prior partial ledger SHA differs")
    need(prior_raw.endswith(b"\n"), "prior partial ledger not newline-terminated")
    rows=[]
    observed=set()
    for line in prior_raw.splitlines():
        row=json.loads(line)
        need(canonical(row).rstrip(b"\n")==line,"noncanonical prior JSONL")
        tx=validate_prior_row(row,drpc,events)
        need(tx not in observed,"duplicate prior receipt")
        observed.add(tx)
        rows.append(row)
    count=report.get("blockscout_receipts_verified",
                     report.get("verified_receipt_count"))
    need(type(count) is int and 10<=count<127 and count==len(rows),
         "prior checkpoint has wrong count")
    if report["status"]=="RMC016_SECOND_OPERATOR_BATCH_CHECKPOINT_PARTIAL":
        need(type(report.get("remaining_receipt_count")) is int and
             report["remaining_receipt_count"]==127-count and
             type(report.get("new_receipt_count")) is int and
             0<report["new_receipt_count"]<=8 and
             report.get("historical_liquidation_event_count")==139,
             "prior batch chain did not conserve 127/139")
    need([r["transaction_hash"] for r in rows]==txids[:count],
         "prior receipt identities are not an exact sorted prefix")
    return rows

def collect_batch(source_zip, drpc_zip, prior_zip, out,
                  *, prior_sha=None, max_new=6,
                  min_interval=7.0, retry_delays=(45,90),
                  rpc_call=rpc, sleep=time.sleep):
    need(type(max_new) is int and 1<=max_new<=8, "batch limit must be 1..8")
    need(type(min_interval) in (int,float) and 2<=min_interval<=30,
         "inter-query spacing must be 2..30 seconds")
    need(not out.exists(), "output directory must be append-only")
    if prior_sha is None:
        prior_sha=PREVIOUS_SHA256
    drpc,events,txids=authenticated_drpc_checkpoint(drpc_zip,source_zip)
    prior=load_prior(prior_zip,prior_sha,drpc,events,txids)
    provider=next(p for p in PROVIDERS if p[0]=="blockscout")
    need(provider[1]=="Blockscout","second operator not Blockscout")
    out.mkdir(parents=True)
    rows=list(prior)
    initial=len(rows)
    failure=None
    for tx in txids[initial:initial+max_new]:
        try:
            raw=None
            for attempt in range(len(retry_delays)+1):
                sleep(min_interval)
                try:
                    raw=rpc_call(provider[2],"eth_getTransactionReceipt",[tx])
                    break
                except Exception as exc:
                    if "429" in str(exc) and attempt<len(retry_delays):
                        sleep(retry_delays[attempt])
                        continue
                    raise
            need(raw is not None, "missing historical Blockscout receipt")
            row=receipt_normalized(tx,events[tx],raw)
            need(row==drpc[tx],"second operator receipt mismatch "+tx)
            rows.append(row)
        except Exception as exc:
            failure={"blocked_transaction_prefix":tx[:18],
                     "error_type":type(exc).__name__,
                     "error":str(exc)[:220]}
            break
    raw_rows=b"".join(canonical(x) for x in rows)
    (out/"verified-blockscout-receipts.jsonl").write_bytes(raw_rows)
    complete=len(rows)==len(txids)
    # A progress checkpoint is not the terminal two-operator certificate.
    status=("RMC016_TWO_OPERATOR_RECEIPT_PARITY_HISTORICAL_ONLY"
            if complete else "RMC016_SECOND_OPERATOR_BATCH_CHECKPOINT_PARTIAL")
    report={
        "schema_version":1,"status":status,
        "claim_scope":"PUBLIC_HISTORICAL_WINNER_RECEIPTS_ONLY",
        "source_event_artifact_sha256":SOURCE_ARTIFACT_SHA256,
        "drpc_source_checkpoint_artifact_sha256":DRPC_CHECKPOINT_SHA256,
        "prior_blockscout_checkpoint_artifact_sha256":prior_sha,
        "prior_blockscout_workflow_run_id":PREVIOUS_RUN_ID,
        "prior_blockscout_workflow_conclusion":"failure",
        "prior_receipt_count":initial,"new_receipt_count":len(rows)-initial,
        "verified_receipt_count":len(rows),"target_receipt_count":len(txids),
        "historical_liquidation_event_count":139,
        "verified_receipts_sha256":sha(raw_rows),
        "aggregate_verified_gas_wei":str(sum(int(x["total_gas_paid_wei"]) for x in rows)),
        "all_127_receipts_cross_operator_reconciled":complete,
        "independent_full_window_log_consensus":False,
        "historical_gas_usd_priced":False,"complete_execution_costs_proven":False,
        "nexus_gas_funding_proven":False,"nexus_execution_proven":False,
        "nexus_capture_probability_calibrated":False,
        "nexus_realized_pnl_proven":False,
        "nexus_monthly_net_pnl_usd":None,
        "real_market_census_closed":False,
        "remaining_receipt_count":len(txids)-len(rows),
        "failure":failure,
    }
    (out/"receipt-parity-report.json").write_bytes(canonical(report))
    with (out/"archive.sha256").open("w") as f:
        for item in sorted(out.iterdir()):
            if item.is_file() and item.name!="archive.sha256":
                f.write(sha(item.read_bytes())+"  "+item.name+"\n")
    return report

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-zip",required=True,type=Path)
    p.add_argument("--drpc-zip",required=True,type=Path)
    p.add_argument("--prior-blockscout-zip",required=True,type=Path)
    p.add_argument("--max-new",type=int,default=6)
    p.add_argument("--min-interval",type=float,default=7.0)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    result=collect_batch(args.source_zip,args.drpc_zip,args.prior_blockscout_zip,args.out,
                         max_new=args.max_new,min_interval=args.min_interval)
    print(result["status"],"prior",result["prior_receipt_count"],
          "new",result["new_receipt_count"],"verified",result["verified_receipt_count"],
          "remaining",result["remaining_receipt_count"])
    if result["new_receipt_count"]==0 and not result["all_127_receipts_cross_operator_reconciled"]:
        raise SystemExit(2)

if __name__=="__main__":main()

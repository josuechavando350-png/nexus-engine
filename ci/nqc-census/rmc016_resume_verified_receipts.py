#!/usr/bin/env python3
"""Authenticate prior complete dRPC receipt checkpoint and independently replay Blockscout.

Historical market receipts ONLY. Does not certify Nexus execution, gas funding,
counterfactual capture, USD-denominated net profits, or Census closure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import zipfile
from pathlib import Path

from rmc016_two_operator_receipts import (
    PROVIDERS, canonical, load_source, need, receipt_normalized, sha, rpc,
)

SOURCE_ARTIFACT_SHA256 = "6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
SOURCE_RUN_ID = 37718661409
SOURCE_ARTIFACT_ID = 11524139188
DRPC_CHECKPOINT_SHA256 = "182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6"
DRPC_CHECKPOINT_RUN_ID = 37719091371
DRPC_CHECKPOINT_ARTIFACT_ID = 11524199698
CHECKPOINT_MEMBERS = {
    "archive.sha256", "receipt-parity-report.json", "verified-drpc-receipts.jsonl"
}
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
CHECKPOINT_COLUMNS = {
    "transaction_hash", "block_number", "block_hash", "transaction_index",
    "liquidation_event_count", "gas_used", "effective_gas_price_wei",
    "execution_gas_wei", "blob_gas_wei", "total_gas_paid_wei",
    "receipt_evidence_sha256",
}

def uint(v, field):
    need(type(v) is str and DECIMAL.fullmatch(v) is not None, field + " not canonical unsigned decimal")
    return int(v)

def archive_members(path: Path, expected_sha: str):
    need(path.is_file(), "archive unavailable")
    need(sha(path.read_bytes()) == expected_sha, "archive outer SHA256 mismatch")
    with zipfile.ZipFile(path, "r") as z:
        infos = z.infolist()
        names = [x.filename for x in infos]
        need(len(names) == len(set(names)) and set(names) == CHECKPOINT_MEMBERS,
             "unexpected, duplicate or missing checkpoint members")
        for member in infos:
            need(member.filename == Path(member.filename).name, "archive path unsafe")
            need((member.external_attr >> 16) & 0o170000 != 0o120000,
                 "archive symlink forbidden")
        data = {name: z.read(name) for name in CHECKPOINT_MEMBERS}
    seen = set()
    for line in data["archive.sha256"].decode("ascii").splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+", line) is not None,
             "checkpoint checksum line not canonical")
        digest, name = line.split("  ")
        need(name in CHECKPOINT_MEMBERS - {"archive.sha256"} and name not in seen,
             "checkpoint checksum missing or duplicated")
        need(sha(data[name]) == digest, "checkpoint member SHA mismatch")
        seen.add(name)
    need(seen == CHECKPOINT_MEMBERS - {"archive.sha256"}, "incomplete checkpoint checksum list")
    return data

def authenticated_drpc_checkpoint(path: Path, source_zip: Path):
    _, event_rows, tids = load_source(source_zip, SOURCE_ARTIFACT_SHA256)
    data = archive_members(path, DRPC_CHECKPOINT_SHA256)
    report = json.loads(data["receipt-parity-report.json"])
    need(type(report) is dict
         and report.get("status") == "RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED"
         and report.get("blocked_at") == "blast"
         and report.get("independent_receipt_parity_complete") is False
         and report.get("nexus_net_pnl_proven") is False
         and report.get("source_event_artifact_sha256") == SOURCE_ARTIFACT_SHA256,
         "incompatible partial predecessor provenance")
    stages = report.get("provider_stages")
    need(type(stages) is list and len(stages) == 2 and
         stages[0].get("provider_id") == "drpc" and
         stages[0].get("verified_transaction_count") == 127 and
         stages[1].get("provider_id") == "blast" and
         0 <= stages[1].get("verified_transaction_count", -1) < 127,
         "dRPC checkpoint stages not exactly authenticated")
    lines = data["verified-drpc-receipts.jsonl"]
    need(lines.endswith(b"\n"), "missing final newline in dRPC checkpoint")
    rows = {}
    for line in lines.splitlines():
        obj = json.loads(line)
        need(type(obj) is dict and set(obj) == CHECKPOINT_COLUMNS, "unexpected dRPC record schema")
        need(canonical(obj).rstrip(b"\n") == line, "noncanonical dRPC record JSONL")
        tid = obj["transaction_hash"]
        need(type(tid) is str and tid in event_rows and tid not in rows,
             "unknown or duplicate dRPC receipt transaction")
        need(type(obj["block_number"]) is int and type(obj["transaction_index"]) is int,
             "wrong ordering number types")
        need(type(obj["block_hash"]) is str
             and all(e["block_number"] == obj["block_number"] and
                     e["block_hash"] == obj["block_hash"] and
                     e["transaction_index"] == obj["transaction_index"]
                     for e in event_rows[tid]), "dRPC receipt block differs from source events")
        need(obj["liquidation_event_count"] == len(event_rows[tid]),
             "dRPC event count differs from source")
        gas = uint(obj["gas_used"], "gas_used")
        price = uint(obj["effective_gas_price_wei"], "effective_gas_price_wei")
        exec_gas = uint(obj["execution_gas_wei"], "execution_gas_wei")
        blob_gas = uint(obj["blob_gas_wei"], "blob_gas_wei")
        all_gas = uint(obj["total_gas_paid_wei"], "total_gas_paid_wei")
        need(gas > 0 and price > 0 and gas*price == exec_gas and exec_gas+blob_gas == all_gas,
             "dRPC historical receipt gas arithmetic diverges")
        witness = obj.pop("receipt_evidence_sha256")
        need(type(witness) is str and DIGEST.fullmatch(witness) and
             sha(canonical(obj)) == witness, "dRPC normalized receipt evidence commitment differs")
        obj["receipt_evidence_sha256"] = witness
        rows[tid] = obj
    need(set(rows) == set(tids) and len(rows) == 127,
         "source's 127 receipts not completely present in dRPC checkpoint")
    need([json.loads(line)["transaction_hash"] for line in lines.splitlines()] == tids,
         "dRPC checkpoint not sorted by exact source transaction identities")
    need(sum(int(x["total_gas_paid_wei"]) for x in rows.values()) == 448369976498898050,
         "source dRPC partial-run gas conservation differs from expected immutable checkpoint")
    return rows, event_rows, tids

def collect(source_zip: Path, drpc_checkpoint: Path, out: Path,
            rpc_call=rpc, sleep=time.sleep, minimum_seconds=3.0,
            retry_delays=(15, 30)):
    need(type(minimum_seconds) in (int, float) and 1 <= minimum_seconds <= 30,
         "rate control must use 1..30 seconds")
    need(not out.exists(), "output must be append-only")
    drpc_rows, source_events, tids = authenticated_drpc_checkpoint(drpc_checkpoint, source_zip)
    provider = next(p for p in PROVIDERS if p[0] == "blockscout")
    need(provider[1] == "Blockscout", "second source operator identity missing")
    out.mkdir(parents=True)
    written = []
    report = None
    failures = []
    def record():
        payload = b"".join(canonical(x) for x in written)
        (out/"verified-blockscout-receipts.jsonl").write_bytes(payload)
        return sha(payload)
    try:
        for tid in tids:
            raw = None
            for attempt in range(len(retry_delays)+1):
                sleep(minimum_seconds)
                try:
                    raw = rpc_call(provider[2], "eth_getTransactionReceipt", [tid])
                    break
                except Exception as error:
                    message = str(error)
                    # Respect provider quotas: explicit backoff with finite retry budget.
                    if "429" in message and attempt < len(retry_delays):
                        sleep(retry_delays[attempt])
                        continue
                    raise ValueError(f"blockscout receipt {tid[:18]} failed: {type(error).__name__}: {message[:160]}") from error
            need(raw is not None, "Blockscout missing historical receipt: "+tid)
            observed = receipt_normalized(tid, source_events[tid], raw)
            need(observed == drpc_rows[tid], "dRPC/Blockscout receipt disagree: "+tid)
            written.append(observed)
            if len(written) % 16 == 0:
                record()
        ledger_sha = record()
        gas = sum(int(x["total_gas_paid_wei"]) for x in written)
        report = {
            "schema_version": 1,
            "status": "RMC016_TWO_OPERATOR_RECEIPT_PARITY_HISTORICAL_ONLY",
            "historical_source_event_run_id": SOURCE_RUN_ID,
            "historical_source_artifact_id": SOURCE_ARTIFACT_ID,
            "historical_source_artifact_sha256": SOURCE_ARTIFACT_SHA256,
            "prior_drpc_checkpoint_run_id": DRPC_CHECKPOINT_RUN_ID,
            "prior_drpc_checkpoint_artifact_id": DRPC_CHECKPOINT_ARTIFACT_ID,
            "prior_drpc_checkpoint_artifact_sha256": DRPC_CHECKPOINT_SHA256,
            "prior_drpc_workflow_completed_successfully": False,
            "prior_drpc_receipt_stage_complete": True,
            "blockscout_receipt_stage_complete": True,
            "independent_receipt_operator_count": 2,
            "source_liquidation_event_count": 139,
            "unique_winner_transaction_count": len(written),
            "gas_paid_wei": str(gas),
            "cross_operator_receipt_ledger_sha256": ledger_sha,
            "independent_full_window_event_enumeration_certified": False,
            "historical_gas_usd_certified": False,
            "all_route_costs_certified": False,
            "nexus_external_gas_funding_proven": False,
            "nexus_execution_proven": False,
            "nexus_capture_calibrated": False,
            "nexus_realized_pnl_proven": False,
            "nexus_monthly_net_pnl_estimate_usd": None,
            "real_market_census_closed": False,
        }
    except Exception as error:
        ledger_sha = record()
        failures.append({"error_type": type(error).__name__, "error": str(error)[:260]})
        report = {
            "schema_version": 1,
            "status": "RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED",
            "first_operator": "dRPC",
            "second_operator": "Blockscout",
            "prior_drpc_checkpoint_artifact_sha256": DRPC_CHECKPOINT_SHA256,
            "historical_source_artifact_sha256": SOURCE_ARTIFACT_SHA256,
            "dRPC_receipts_verified_from_checkpoint": 127,
            "blockscout_receipts_verified": len(written),
            "partial_evidence_sha256": ledger_sha,
            "independent_receipt_parity_complete": False,
            "failures": failures,
            "nexus_realized_pnl_proven": False,
            "real_market_census_closed": False,
        }
    (out/"receipt-parity-report.json").write_bytes(canonical(report))
    with (out/"archive.sha256").open("w") as manifest:
        for f in sorted(out.iterdir()):
            if f.is_file() and f.name != "archive.sha256":
                manifest.write(sha(f.read_bytes())+"  "+f.name+"\n")
    return report

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-zip", required=True, type=Path)
    parser.add_argument("--drpc-checkpoint-zip", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--min-interval", type=float, default=3.0)
    args = parser.parse_args()
    report = collect(args.source_zip, args.drpc_checkpoint_zip, args.out,
                     minimum_seconds=args.min_interval)
    print(report["status"],
          "verified", report.get("unique_winner_transaction_count",report.get("blockscout_receipts_verified")),
          "gas_wei", report.get("gas_paid_wei"))
    if report["status"] != "RMC016_TWO_OPERATOR_RECEIPT_PARITY_HISTORICAL_ONLY":
        raise SystemExit(2)

if __name__ == "__main__":
    main()

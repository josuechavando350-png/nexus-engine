#!/usr/bin/env python3
"""Replay four authenticated ETH/USD primary/secondary transactions in pinned forks.

Bounded historical read-only research, never broadcasts or deploys on Ethereum.
Fork results show what Aave price *would read at that historical pre/post-state*;
they are not network first-seen signals, HF triggers, win probability or P&L.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import zipfile

import oracle_round_transaction_order as prior

ZIP_SHA = "5e5684fb4a98b87b1d9e2f15facb03ddb093e50a6e75ff4553b79fc192e69d38"
ZIP_HEAD = "635a10da08bb5b4cea7639c555cb2ddf7b38c551"
CONTRACT = "NqcV2OraclePricePathTest"
METRIC_KEYS = (
    "NQC_AAVE_PRICE_BEFORE", "NQC_AAVE_PRICE_AFTER",
    "NQC_CHAINLINK_ANSWER_BEFORE", "NQC_CHAINLINK_ANSWER_AFTER",
    "NQC_CHAINLINK_ROUND_BEFORE", "NQC_CHAINLINK_ROUND_AFTER",
    "NQC_PRICE_CHANGED", "NQC_MATCHED_ORACLE_EVENT",
)
ADDRESS_KEYS = ("NQC_AAVE_PRICE_ORACLE", "NQC_CHAINLINK_PRICE_SOURCE")


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def utc():
    return datetime.now(timezone.utc).isoformat()


def canon(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def new_json(path, value):
    with path.open("xb") as f:
        f.write(canon(value))


def valid_archive_name(name):
    need(type(name) is str and 1 <= len(name) <= 250
         and "\\" not in name and not name.startswith("./../"), "unsafe ZIP entry name")
    p = PurePosixPath(name)
    need(not p.is_absolute() and ".." not in p.parts, "unsafe ZIP traversal")
    return name


def authenticate_source(raw):
    need(type(raw) is bytes and 0 < len(raw) < 15_000_000, "source archive oversized")
    need(sha256(raw).hexdigest() == ZIP_SHA, "producer ZIP digest disagreement")
    with zipfile.ZipFile(BytesIO(raw)) as z:
        entries = [i for i in z.infolist() if not i.is_dir()]
        names = [valid_archive_name(i.filename) for i in entries]
        need(len(names) == len(set(names)) and len(names) <= 40,
             "duplicate or oversized source member list")
        need(sum(i.file_size for i in entries) < 30_000_000,
             "archive decompression budget exceeded")
        need("manifest.sha256" in names, "source manifest missing")
        declared = {}
        for line in z.read("manifest.sha256").decode().splitlines():
            m = re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9_./\-]+)", line)
            need(m is not None, "source manifest malformed")
            name = valid_archive_name(m[2])
            need(name not in declared and name != "manifest.sha256",
                 "duplicate/self-referential source digest")
            declared[name] = m[1]
        need(set(declared) == set(names) - {"manifest.sha256"},
             "source file set incomplete")
        for name, digest in declared.items():
            need(sha256(z.read(name)).hexdigest() == digest,
                 "source manifest member changed: " + name)
        need(z.read("code-commit.txt").decode().strip() == ZIP_HEAD,
             "producer commit head differs")
        source = prior.cadence.strict_json(z.read("round-receipt-order.json"))
        nested = z.read("pr707-dual-source.zip")
    _, events, groups = prior.auth_zip(nested)
    need(source.get("status") == "SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY"
         and source.get("cross_endpoint_receipt_parity") is False
         and source.get("profitable_aave_liquidation_capture_proven") is False
         and source.get("nqc_realized_pnl_usd") == "0"
         and source.get("RMC_closed") is False,
         "source historical authority drift")
    need(source.get("producer_pr707_zip_sha256") == prior.SOURCE_SHA,
         "inherited producer not source-bound")
    orig = source.get("sources")
    need(type(orig) is dict and set(orig) == {"drpc", "blast"} and
         orig["drpc"]["status"] == "ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED"
         and orig["blast"]["status"] == "INCOMPLETE_RECEIPT_SOURCE",
         "expected single-source receipt baseline drift")
    records = orig["drpc"]["results"]
    need(type(records) is list and len(records) == len(events) == 4,
         "exact four-event input identity missing")
    normalized = {v["tx_hash"]: v for v in records}
    need(len(normalized) == 4, "duplicate original receipt")
    cases = []
    for e in events:
        r = normalized.get(e["transaction_hash"])
        need(r is not None and
             r["block"] == e["block_number"] and
             r["block_hash"] == e["block_hash"] and
             r["timestamp"] == e["block_timestamp"] and
             r["round_id"] == e["round_id"] and
             r["event_family"] == e["event_family"] and
             r["global_log_index"] == e["log_index"] and
             r["receipt_event_content_matches_source"] is True,
             "source event/receipt mismatch")
        cases.append({
            "tx_hash": r["tx_hash"], "block": r["block"],
            "block_hash": r["block_hash"], "timestamp": r["timestamp"],
            "tx_index": r["transaction_index"], "round_id": r["round_id"],
            "family": r["event_family"], "topic": e["topic0"],
            "source_event_log_index": e["log_index"],
            "source_price_answer_raw": e["price_answer_raw"],
        })
    cases.sort(key=lambda x: (x["block"], x["tx_index"]))
    need(len(groups) == 2 and
         {x["round_id"] for x in cases} == set(groups), "round mismatch")
    return cases, {
        "zip_sha256": ZIP_SHA,
        "producer_commit": ZIP_HEAD,
        "producer_source_status": source["status"],
        "PR707_two_operator_receipt_parity_inherited": False,
        "manifest_members_verified": len(declared),
        "historical_selection_post_source_observation": True,
    }


def parse_forge_log(output, case):
    need(type(output) is str and "1 passed; 0 failed; 0 skipped" in output
         and "[PASS] testPinnedConfirmedOracleTransactionPricePath()" in output,
         "wrong or failed Solidity fork execution")
    found = re.findall(r"^\s+(NQC_[A-Z0-9_]+): (\d+)(?: \[[^\n]*\])?\s*$", output, re.M)
    need(len(found) == len(METRIC_KEYS) and {x[0] for x in found} == set(METRIC_KEYS),
         "missing/duplicate/unknown integer fork metrics")
    m = {name: int(value) for name, value in found}
    addresses = {}
    for key in ADDRESS_KEYS:
        matches = re.findall(r"^\s+" + key + r": (0x[0-9a-fA-F]{40})\s*$",
                             output, re.M)
        need(len(matches) == 1 and int(matches[0], 16) != 0, "missing/invalid canonical address")
        addresses[key] = matches[0].lower()
    need(m["NQC_MATCHED_ORACLE_EVENT"] == 1 and
         m["NQC_AAVE_PRICE_BEFORE"] > 0 and m["NQC_AAVE_PRICE_AFTER"] > 0 and
         m["NQC_CHAINLINK_ANSWER_BEFORE"] > 0 and
         m["NQC_CHAINLINK_ANSWER_AFTER"] > 0 and
         m["NQC_CHAINLINK_ROUND_BEFORE"] > 0 and
         m["NQC_CHAINLINK_ROUND_AFTER"] > 0,
         "missing actual historical price/round evidence")
    expected_changed = int(m["NQC_AAVE_PRICE_BEFORE"] != m["NQC_AAVE_PRICE_AFTER"])
    need(m["NQC_PRICE_CHANGED"] == expected_changed,
         "false Aave WETH price change classification")
    need(case["family"] in ("PRIMARY_NEW_TRANSMISSION", "SECONDARY_ROUND_ID_UPDATED"),
         "unsupported source event family")
    # The event identity is verified in the fork, but the secondary event does
    # NOT itself carry an int192 price answer. No inference about its direction.
    return {**m, **addresses, "AAVE_PRICE_DELTA_RAW":
            m["NQC_AAVE_PRICE_AFTER"] - m["NQC_AAVE_PRICE_BEFORE"],
            "source_event_family": case["family"],
            "source_event_does_not_guarantee_price_change": True,
            "historical_only": True}


def run_case(case, provider, root, forge):
    folder = root / (str(case["block"]) + "-" + case["family"].lower() +
                     "-" + provider)
    folder.mkdir()
    (folder / "test").mkdir()
    root_src = Path(__file__).resolve().parents[1] / "weth-physical"
    test_file = root_src / "test/NqcV2OraclePricePath.t.sol"
    shutil.copy(test_file, folder / "test/")
    shutil.copy(root_src / "foundry-time-only.toml", folder / "foundry.toml")

    rpc = prior.RPC(provider)
    transcript = []
    try:
        need(prior.quantity(rpc.call("eth_chainId", [])) == 1, "not Ethereum")
        bn = case["block"]
        header_raw = rpc.call("eth_getBlockByNumber", [hex(bn), False],
                              allowed_blocks={bn})
        header = prior.cadence.canonical_header(header_raw, bn)
        need(header["hash"] == case["block_hash"] and
             header["timestamp"] == case["timestamp"], "fork header changed")
        # Source/contract code hashes are kept immutable by git HEAD + manifest.
        inputs = {
            "NQC_RPC_URL": prior.PROVIDERS[provider],
            "NQC_CONFIRMED_TX": case["tx_hash"],
            "NQC_CONFIRMED_BLOCK": str(case["block"]),
            "NQC_CONFIRMED_TIMESTAMP": str(case["timestamp"]),
            "NQC_CONFIRMED_PARENT": header["parent"],
            "NQC_EXPECTED_TOPIC": case["topic"],
            "NQC_EXPECTED_ROUND": str(case["round_id"]),
        }
        new_json(folder / "inputs-redacted.json",
                 {k: v for k, v in inputs.items() if k != "NQC_RPC_URL"})
        new_json(folder / "source-files-sha256.json", {
            p.name: sha256(p.read_bytes()).hexdigest()
            for p in (folder / "foundry.toml", folder / "test/NqcV2OraclePricePath.t.sol")
        })
        with (folder / "forge.log").open("xb") as stream:
            try:
                result = subprocess.run(
                    [forge, "test", "--match-contract", CONTRACT,
                     "--fork-url", inputs["NQC_RPC_URL"], "--fork-block-number",
                     str(case["block"] - 1), "--no-storage-caching",
                     "--compute-units-per-second", "5", "--fork-retries", "2",
                     "--fork-retry-backoff", "10000", "--threads", "1", "-vvv"],
                    cwd=folder, env={**os.environ, **inputs},
                    stdout=stream, stderr=subprocess.STDOUT,
                    check=False, timeout=620)
            except subprocess.TimeoutExpired:
                new_json(folder / "exit.json", {"status": "TIMEOUT", "seconds": 620})
                raise
        new_json(folder / "exit.json", {"returncode": result.returncode})
        need(result.returncode == 0, "fork failed; retain unmodified log")
        parsed = parse_forge_log((folder / "forge.log").read_text(), case)
        new_json(folder / "metrics.json", parsed)
        end_raw = rpc.call("eth_getBlockByNumber", [hex(bn), False],
                           allowed_blocks={bn})
        need(prior.cadence.canonical_header(end_raw, bn) == header,
             "reorg during source-bound fork")
        transcript = rpc.records
        return parsed
    finally:
        new_json(folder / "rpc-transcript.json", rpc.records)


def summary(rows):
    ready = [r for r in rows if r.get("dRPC") is not None]
    if len(ready) != 4:
        return {"status": "UNKNOWN_INCOMPLETE_PRICE_PATH",
                "available_single_source_paths": len(ready)}
    by_family = {}
    for row in ready:
        label = row["case"]["family"]
        by_family.setdefault(label, {"transactions": 0,
                                    "aave_price_changed": 0,
                                    "aave_price_unchanged": 0})
        bucket = by_family[label]
        bucket["transactions"] += 1
        bucket["aave_price_changed"] += row["dRPC"]["NQC_PRICE_CHANGED"]
        bucket["aave_price_unchanged"] += 1-row["dRPC"]["NQC_PRICE_CHANGED"]
    return {"status": "FOUR_HISTORICAL_PRICE_PATHS_SINGLE_SOURCE_ONLY",
            "by_event_family": by_family}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--producer-artifact", type=Path, required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--forge", type=Path, required=True)
    args = p.parse_args()
    need(args.out_dir.is_absolute() and not args.out_dir.exists(),
         "fresh absolute evidence directory required")
    args.out_dir.mkdir(parents=True)
    report = {
        "schema_version": 1, "status": "INCOMPLETE_ORACLE_PRICE_PATH_FORK",
        "started_at_utc": utc(), "source": None, "cases": [],
        "errors": [], "summary": None,
        "posthoc_historical_event_selection": True,
        "source_blok_confirmed_before_hypothetical_replay": True,
        "cross_rpc_operator_independence_proven": False,
        "production_oracle_price_mutation_performed": False,
        "prospective_first_seen_proven": False,
        "contemporaneous_borrower_liquidatable_proven": False,
        "native_gas_external_nonrecourse_sponsor_proven": False,
        "profitable_competitive_capture_proven": False,
        "net_pnl_certified": False, "RMC_closed": False,
        "P2_shadow_certified": False, "canary_live_authorized": False,
        "commercial_score_upgrade": False, "nqc_realized_pnl_usd": "0",
    }
    try:
        cases, report["source"] = authenticate_source(args.producer_artifact.read_bytes())
        for case in cases:
            row = {"case": case, "dRPC": None, "BlastAPI": None,
                   "source_parity": False}
            report["cases"].append(row)
            for provider, field in (("drpc", "dRPC"), ("blast", "BlastAPI")):
                try:
                    row[field] = run_case(case, provider, args.out_dir, str(args.forge))
                except Exception as exc:
                    report["errors"].append({
                        "provider": provider, "block": case["block"],
                        "tx_hash": case["tx_hash"],
                        "kind": type(exc).__name__,
                        "detail": str(exc).split("https://")[0][:250],
                    })
            row["source_parity"] = (row["dRPC"] is not None and
                                    row["dRPC"] == row["BlastAPI"])
        report["summary"] = summary(report["cases"])
        if len(report["cases"]) == 4 and all(x["source_parity"] for x in report["cases"]):
            report["status"] = "TWO_RPC_HISTORICAL_PRICE_PATH_PARITY_NO_LIVE_CAPTURE"
        elif (len(report["cases"]) == 4 and
              all(x["dRPC"] is not None for x in report["cases"])):
            report["status"] = "ONE_RPC_HISTORICAL_PRICE_PATH_ONLY"
    except Exception as exc:
        report["errors"].append({"kind": type(exc).__name__,
                                 "detail": str(exc)[:300]})
    report["finished_at_utc"] = utc()
    new_json(args.out_dir / "price-path-fork.json", report)
    print(report["status"], report["summary"],
          "failures", len(report["errors"]))
    return 0  # Source failures are preserved. No LIVE / profitability authority.


if __name__ == "__main__":
    raise SystemExit(main())

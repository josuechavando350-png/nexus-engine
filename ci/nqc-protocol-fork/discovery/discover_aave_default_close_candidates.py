#!/usr/bin/env python3
"""Discover real Aave V3 liquidations that can be probed for the default close cap.

This gate is deliberately non-admitting. It binds successful historical receipts,
canonical block identity, and decoded LiquidationCall events across independent
Ethereum RPC providers. Exact transaction-prestate math is proved separately.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "ci/nqc-protocol-fork/discovery/aave_default_close_candidates.json"
CONTRACT = ROOT / "ci/nqc-protocol-fork/PROTOCOL_FORK_TRUTH_CONTRACT.json"
OUT = Path(os.environ.get(
    "NQC_PFT_DEFAULT_CLOSE_DISCOVERY_OUT",
    "/tmp/nqc-pft-default-close-discovery",
))
USER_AGENT = "nqc-protocol-fork-default-close-discovery/1"
REQUEST_TIMEOUT = 45
SOURCE_SHA = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
).strip()


def fail(message: str) -> None:
    raise SystemExit(message)


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        fail(f"{path}: {exc}")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def rpc(url: str, method: str, params: list, request_id: int):
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
    last = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "content-type": "application/json",
                    "accept": "application/json",
                    "user-agent": USER_AGENT,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
                body = json.loads(response.read())
            if "error" in body:
                raise RuntimeError(f"rpc error: {body['error']}")
            if "result" not in body:
                raise RuntimeError("missing result")
            return body["result"]
        except Exception as exc:
            last = exc
            if attempt != 5:
                time.sleep(min(8, attempt + 1))
    raise RuntimeError(str(last))


def normalize_address(value):
    return value.lower() if isinstance(value, str) else value


def decode_topic_address(value: str, label: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 64 or any(ch not in "0123456789abcdef" for ch in raw):
        raise RuntimeError(f"{label}: invalid indexed address")
    return "0x" + raw[-40:]


def decode_word_address(word: str, label: str) -> str:
    if len(word) != 64 or any(ch not in "0123456789abcdef" for ch in word.lower()):
        raise RuntimeError(f"{label}: invalid ABI address word")
    return "0x" + word[-40:].lower()


def decode_liquidation(log: dict, topic0: str) -> dict:
    topics = [str(item).lower() for item in log.get("topics", [])]
    if len(topics) != 4 or topics[0] != topic0:
        raise RuntimeError("invalid LiquidationCall topics")
    raw = str(log.get("data", "")).lower().removeprefix("0x")
    if len(raw) != 4 * 64 or any(ch not in "0123456789abcdef" for ch in raw):
        raise RuntimeError("invalid LiquidationCall data")
    words = [raw[i * 64:(i + 1) * 64] for i in range(4)]
    receive = int(words[3], 16)
    if receive not in (0, 1):
        raise RuntimeError("LiquidationCall receiveAToken outside bool domain")
    log_index = log.get("logIndex")
    if not isinstance(log_index, str) or not log_index.startswith("0x"):
        raise RuntimeError("LiquidationCall missing logIndex")
    return {
        "log_index": log_index.lower(),
        "borrower": decode_topic_address(topics[3], "borrower"),
        "collateral_asset": decode_topic_address(topics[1], "collateral_asset"),
        "debt_asset": decode_topic_address(topics[2], "debt_asset"),
        "debt_to_cover": str(int(words[0], 16)),
        "liquidated_collateral_amount": str(int(words[1], 16)),
        "liquidator": decode_word_address(words[2], "liquidator"),
        "receive_atoken": bool(receive),
    }


config = load_json(CONFIG)
contract = load_json(CONTRACT)
if config.get("schema_version") != 1 or config.get("chain_id") != 1:
    fail("candidate config must be schema_version=1 on Ethereum mainnet")
if len(SOURCE_SHA) != 40 or any(ch not in "0123456789abcdef" for ch in SOURCE_SHA):
    fail("checked-out source SHA is not a full lowercase 40-hex commit")
if contract.get("status") not in {"NOT_TESTED", "RUNTIME_CLOSEOUT_CANDIDATE_READY"}:
    fail("unexpected Protocol/Fork truth contract phase")
checkpoint = contract["recovered_physical_source"]["git_bundle_checkpoint"]
if len(checkpoint) != 40:
    fail("invalid recovered physical-source checkpoint")

protocol = config["protocol"]
pool = protocol["pool"].lower()
topic0 = protocol["liquidation_call_topic0"].lower()
policy = config["policy"]
min_providers = int(policy["minimum_anchor_consensus_providers"])
required_logs = int(policy["required_liquidation_logs_per_candidate"])
if min_providers < 2 or required_logs != 1:
    fail("probe requires >=2 providers and exactly one liquidation log")
if policy.get("fixture_admission") != "FORBIDDEN_BY_DISCOVERY_PROBE":
    fail("discovery probe must remain non-admitting")
providers = config.get("providers", [])
if len(providers) < min_providers:
    fail("insufficient configured providers")

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "providers").mkdir(exist_ok=True)
(OUT / "candidates").mkdir(exist_ok=True)

summaries = []
accepted = 0
for candidate_index, candidate in enumerate(config.get("candidates", []), start=1):
    case_id = candidate["case_id"]
    tx_hash = candidate["transaction_hash"].lower()
    expected_status = candidate["expected_receipt_status"].lower()
    observations = []

    for provider_index, provider in enumerate(providers, start=1):
        provider_id = provider["id"]
        url = provider["url"]
        observation = {
            "provider_id": provider_id,
            "provider_url_sha256": sha256_text(url),
            "rpc_ok": False,
        }
        base_id = candidate_index * 1000 + provider_index * 100
        try:
            chain_id = int(rpc(url, "eth_chainId", [], base_id + 1), 16)
            if chain_id != 1:
                raise RuntimeError(f"wrong chain id {chain_id}")
            receipt = rpc(url, "eth_getTransactionReceipt", [tx_hash], base_id + 2)
            if not receipt:
                raise RuntimeError("transaction receipt unavailable")
            status = str(receipt.get("status", "")).lower()
            if status != expected_status:
                raise RuntimeError(f"receipt status {status} != expected {expected_status}")

            block_hash = str(receipt.get("blockHash", "")).lower()
            block_number_hex = str(receipt.get("blockNumber", ""))
            if len(block_hash) != 66 or not block_number_hex.startswith("0x"):
                raise RuntimeError("receipt lacks canonical block identity")
            block_number = int(block_number_hex, 16)
            block = rpc(url, "eth_getBlockByHash", [block_hash, False], base_id + 3)
            if not block or str(block.get("hash", "")).lower() != block_hash:
                raise RuntimeError("block-by-hash mismatch")
            if int(block.get("number", "0x0"), 16) != block_number:
                raise RuntimeError("block number mismatch")
            by_number = rpc(
                url, "eth_getBlockByNumber", [block_number_hex, False], base_id + 4
            )
            if not by_number or str(by_number.get("hash", "")).lower() != block_hash:
                raise RuntimeError("canonical block-number guard mismatch")
            parent_hash = str(block.get("parentHash", "")).lower()
            if len(parent_hash) != 66:
                raise RuntimeError("parent hash unavailable")

            events = []
            for log in receipt.get("logs", []):
                if normalize_address(log.get("address")) != pool:
                    continue
                topics = [str(item).lower() for item in log.get("topics", [])]
                if topics and topics[0] == topic0:
                    events.append(decode_liquidation(log, topic0))
            events.sort(key=lambda item: int(item["log_index"], 16))

            observation.update({
                "rpc_ok": True,
                "chain_id": chain_id,
                "transaction_hash": tx_hash,
                "receipt_status": status,
                "block_number": block_number,
                "block_hash": block_hash,
                "parent_hash": parent_hash,
                "block_timestamp": int(block["timestamp"], 16),
                "transaction_index": int(receipt.get("transactionIndex", "0x0"), 16),
                "liquidation_log_count": len(events),
                "liquidation_events": events,
            })
        except Exception as exc:
            observation["error"] = str(exc)
        observations.append(observation)

    provider_path = OUT / "providers" / f"{case_id}.json"
    provider_path.write_text(json.dumps(observations, indent=2, sort_keys=True) + "\n")
    valid = [item for item in observations if item["rpc_ok"]]
    if len(valid) < min_providers:
        summaries.append({
            "case_id": case_id,
            "transaction_hash": tx_hash,
            "status": "REJECTED_INSUFFICIENT_PROVIDER_CONSENSUS",
            "valid_providers": len(valid),
        })
        continue

    keys = []
    for item in valid:
        events_key = json.dumps(
            item["liquidation_events"], sort_keys=True, separators=(",", ":")
        )
        keys.append((
            item["block_number"],
            item["block_hash"],
            item["parent_hash"],
            item["receipt_status"],
            item["transaction_index"],
            events_key,
        ))
    consensus_key, consensus_count = Counter(keys).most_common(1)[0]
    if consensus_count < min_providers or consensus_count != len(valid):
        summaries.append({
            "case_id": case_id,
            "transaction_hash": tx_hash,
            "status": "REJECTED_PROVIDER_DISSENT",
            "valid_providers": len(valid),
            "consensus_providers": consensus_count,
        })
        continue

    block_number, block_hash, parent_hash, status, tx_index, events_key = consensus_key
    events = json.loads(events_key)
    if len(events) != required_logs:
        summaries.append({
            "case_id": case_id,
            "transaction_hash": tx_hash,
            "status": "REJECTED_LIQUIDATION_LOG_COUNT",
            "liquidation_log_count": len(events),
            "block_number": block_number,
        })
        continue

    provider_identity = {
        "block_hash": block_hash,
        "consensus_providers": sorted(item["provider_id"] for item in valid),
    }
    provider_identity_text = json.dumps(
        provider_identity, sort_keys=True, separators=(",", ":")
    )
    fixture = {
        "schema_version": 1,
        "case_id": case_id,
        "strategy_family": "liquidation",
        "class_tags": candidate["class_tags"],
        "chain_id": 1,
        "block_number": block_number,
        "block_hash": block_hash,
        "parent_hash": parent_hash,
        "source_commit": checkpoint,
        "provider": {
            "kind": "archive_rpc",
            "identity": provider_identity_text,
            "identity_sha256": sha256_text(provider_identity_text),
            "historical_state_served": True,
        },
        "protocol": {
            "aave_pool": pool,
            "liquidation_call_topic0": topic0,
        },
        "account": {
            "total_liquidation_log_count": 1,
            "observed_liquidations": events,
        },
        "expected": {
            "receipt_status": "0x1",
            "liquidation_log_count": 1,
        },
        "provenance": {
            "transaction_hash": tx_hash,
            "transaction_index": tx_index,
            "discovery_source_sha": SOURCE_SHA,
            "discovery_only": True,
            "fixture_admitted": False,
            "evidence_source": "cross-provider-consensus-default-close-probe",
        },
        "result": {
            "status": "NOT_TESTED",
            "evidence_sha256": None,
            "failure_artifact": None,
        },
    }
    fixture_path = OUT / "candidates" / f"{case_id}.json"
    fixture_path.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n")
    accepted += 1
    summaries.append({
        "case_id": case_id,
        "transaction_hash": tx_hash,
        "status": "CONSENSUS_SINGLE_LIQUIDATION_CANDIDATE",
        "block_number": block_number,
        "block_hash": block_hash,
        "parent_hash": parent_hash,
        "transaction_index": tx_index,
        "consensus_providers": consensus_count,
        "candidate_fixture_sha256": hashlib.sha256(
            fixture_path.read_bytes()
        ).hexdigest(),
        "provider_observations_sha256": hashlib.sha256(
            provider_path.read_bytes()
        ).hexdigest(),
    })

summary = {
    "schema_version": 1,
    "gate": "AAVE_DEFAULT_CLOSE_CAP_CANDIDATE_DISCOVERY",
    "source_sha": SOURCE_SHA,
    "recovered_source_checkpoint": checkpoint,
    "candidate_count": len(config.get("candidates", [])),
    "accepted_single_liquidation_candidates": accepted,
    "candidates": summaries,
    "fixture_admission": "NONE",
    "protocol_fork_truth": "NOT_CLOSED",
}
(OUT / "discovery-summary.json").write_text(
    json.dumps(summary, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(summary, sort_keys=True))
if accepted == 0:
    fail("no candidate reached cross-provider single-liquidation consensus")

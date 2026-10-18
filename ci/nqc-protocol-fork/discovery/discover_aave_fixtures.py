#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "ci" / "nqc-protocol-fork" / "discovery" / "aave_candidates.json"
OUT = Path(os.environ.get("NQC_PFT_DISCOVERY_OUT", "/tmp/nqc-pft-discovery"))
USER_AGENT = "nqc-protocol-fork-truth/1"
REQUEST_TIMEOUT = 20
SOURCE_SHA = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
if len(SOURCE_SHA) != 40 or any(ch not in "0123456789abcdef" for ch in SOURCE_SHA):
    raise SystemExit("checked-out source SHA is not a full lowercase 40-hex commit")


def fail(message: str) -> None:
    raise SystemExit(message)


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        fail(f"{path}: {exc}")


def rpc(url: str, method: str, params: list, request_id: int):
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
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
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
                raw = response.read()
            body = json.loads(raw)
            if "error" in body:
                raise RuntimeError(f"rpc error: {body['error']}")
            if "result" not in body:
                raise RuntimeError("missing result")
            return body["result"]
        except Exception as exc:
            last = exc
            if attempt != 2:
                time.sleep(1 + attempt)
    raise RuntimeError(str(last))


def normalize_address(value: str | None) -> str | None:
    return value.lower() if isinstance(value, str) else value


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def exact_state_rpc(
    url: str,
    method: str,
    leading_params: list,
    block_hash: str,
    block_number_hex: str,
    request_id: int,
):
    # Prefer EIP-1898 exact block-hash state addressing. Some public providers
    # expose historical state but reject EIP-1898 for eth_call. In that case,
    # use the exact block number only while guarding it with the expected
    # canonical hash both immediately before and after the state request.
    try:
        result = rpc(
            url,
            method,
            leading_params + [{"blockHash": block_hash, "requireCanonical": True}],
            request_id,
        )
        return result, "EIP1898_BLOCK_HASH"
    except Exception as hash_error:
        pre = rpc(url, "eth_getBlockByNumber", [block_number_hex, False], request_id + 1)
        if not pre or pre.get("hash", "").lower() != block_hash.lower():
            raise RuntimeError(
                f"number guard pre-state mismatch after EIP-1898 failure: {hash_error}"
            )
        result = rpc(
            url,
            method,
            leading_params + [block_number_hex],
            request_id + 2,
        )
        post = rpc(url, "eth_getBlockByNumber", [block_number_hex, False], request_id + 3)
        if not post or post.get("hash", "").lower() != block_hash.lower():
            raise RuntimeError("number guard post-state mismatch")
        return result, "BLOCK_NUMBER_WITH_PRE_POST_HASH_GUARD"


def decode_abi_address(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("0x") or len(value) < 66:
        raise RuntimeError(f"{label}: invalid ABI address return")
    address = "0x" + value[-40:].lower()
    if address == "0x" + "0" * 40:
        raise RuntimeError(f"{label}: zero address")
    return address


def decode_abi_uint(value: str, label: str) -> int:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise RuntimeError(f"{label}: invalid ABI integer return")
    return int(value, 16)


config = load_json(CONFIG)
if config.get("schema_version") != 1:
    fail("candidate config schema_version must be 1")
if config.get("chain_id") != 1:
    fail("this discovery tranche is Ethereum mainnet only")

protocol = config["protocol"]
pool = protocol["pool"].lower()
topic0 = protocol["liquidation_call_topic0"].lower()
selectors = protocol.get("selectors", {})
expected_selectors = {
    "ADDRESSES_PROVIDER": "0x0542975c",
    "getPriceOracle": "0xfca513a8",
    "FLASHLOAN_PREMIUM_TOTAL": "0x074b2e43",
    "getReservesCount": "0x72218d04",
}
if selectors != expected_selectors:
    fail("Aave selector lock does not match the reviewed canonical ABI selector set")
addresses_provider_selector = selectors["ADDRESSES_PROVIDER"]
price_oracle_selector = selectors["getPriceOracle"]
premium_selector = selectors["FLASHLOAN_PREMIUM_TOTAL"]
reserves_count_selector = selectors["getReservesCount"]
policy = config["discovery_policy"]
min_anchor = int(policy["minimum_anchor_consensus_providers"])
min_state = int(policy["minimum_exact_state_providers"])
if min_anchor < 2 or min_state < 2:
    fail("cross-provider discovery thresholds must both be >= 2")
if policy.get("fixture_admission") != "FORBIDDEN_BY_THIS_DISCOVERY_GATE":
    fail("discovery gate must not admit fixtures")

providers = config.get("providers", [])
if len(providers) < min_anchor:
    fail("insufficient configured providers")

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "candidates").mkdir(exist_ok=True)
(OUT / "providers").mkdir(exist_ok=True)

provider_health = {}
case_summaries = []

for candidate in config.get("candidates", []):
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
            "exact_state_probe": False,
            "protocol_identity_probe": False,
        }
        try:
            chain_id_hex = rpc(url, "eth_chainId", [], provider_index * 100 + 1)
            chain_id = int(chain_id_hex, 16)
            if chain_id != 1:
                raise RuntimeError(f"wrong chain id {chain_id}")

            receipt = rpc(url, "eth_getTransactionReceipt", [tx_hash], provider_index * 100 + 2)
            if not receipt:
                raise RuntimeError("transaction receipt unavailable")

            block_hash = receipt.get("blockHash")
            block_number_hex = receipt.get("blockNumber")
            receipt_status = receipt.get("status")
            if not block_hash or not block_number_hex or receipt_status is None:
                raise RuntimeError("receipt lacks canonical identity fields")
            block_number = int(block_number_hex, 16)

            block = rpc(url, "eth_getBlockByHash", [block_hash, False], provider_index * 100 + 3)
            if not block:
                raise RuntimeError("block by hash unavailable")
            if block.get("hash", "").lower() != block_hash.lower():
                raise RuntimeError("block hash mismatch")
            if int(block.get("number", "0x0"), 16) != block_number:
                raise RuntimeError("block number mismatch")

            by_number = rpc(url, "eth_getBlockByNumber", [block_number_hex, False], provider_index * 100 + 4)
            if not by_number or by_number.get("hash", "").lower() != block_hash.lower():
                raise RuntimeError("block number no longer resolves to receipt block hash")

            parent_hash = block.get("parentHash")
            if not parent_hash:
                raise RuntimeError("block parent hash unavailable")

            pool_logs = [
                {
                    "log_index": log.get("logIndex"),
                    "transaction_index": log.get("transactionIndex"),
                    "topics": [topic.lower() for topic in log.get("topics", [])],
                    "data": log.get("data"),
                }
                for log in receipt.get("logs", [])
                if normalize_address(log.get("address")) == pool
            ]
            liquidation_logs = [
                log for log in pool_logs
                if log["topics"] and log["topics"][0] == topic0
            ]

            if receipt_status.lower() != expected_status:
                raise RuntimeError(
                    f"receipt status {receipt_status} != expected {expected_status}"
                )
            if candidate.get("expected_pool_liquidation_log") and not liquidation_logs:
                raise RuntimeError("expected Aave LiquidationCall log not found")
            if (
                candidate.get("expected_direct_to_pool")
                and normalize_address(receipt.get("to")) != pool
            ):
                raise RuntimeError("expected failed transaction direct to Aave pool")

            # EIP-1898 exact-block-hash state probe. A provider only counts as
            # exact-state-capable if it serves contract code using the exact
            # canonical block hash, not a moving tag or nearby block number.
            try:
                code = rpc(
                    url,
                    "eth_getCode",
                    [pool, {"blockHash": block_hash, "requireCanonical": True}],
                    provider_index * 100 + 5,
                )
                if isinstance(code, str) and code not in ("0x", "0x0", ""):
                    observation["exact_state_probe"] = True
                    observation["pool_code_sha256"] = sha256_text(code.lower())
                    observation["pool_code_bytes"] = (len(code) - 2) // 2
                else:
                    observation["exact_state_probe_error"] = "empty pool code"
            except Exception as exc:
                observation["exact_state_probe_error"] = str(exc)

            try:
                addresses_provider_raw, access_mode_1 = exact_state_rpc(
                    url,
                    "eth_call",
                    [{"to": pool, "data": addresses_provider_selector}],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 20,
                )
                addresses_provider = decode_abi_address(
                    addresses_provider_raw, "ADDRESSES_PROVIDER"
                )
                price_oracle_raw, access_mode_2 = exact_state_rpc(
                    url,
                    "eth_call",
                    [{"to": addresses_provider, "data": price_oracle_selector}],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 30,
                )
                price_oracle = decode_abi_address(price_oracle_raw, "getPriceOracle")
                premium_raw, access_mode_3 = exact_state_rpc(
                    url,
                    "eth_call",
                    [{"to": pool, "data": premium_selector}],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 40,
                )
                reserves_count_raw, access_mode_4 = exact_state_rpc(
                    url,
                    "eth_call",
                    [{"to": pool, "data": reserves_count_selector}],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 50,
                )
                flash_loan_premium_bps = decode_abi_uint(
                    premium_raw, "FLASHLOAN_PREMIUM_TOTAL"
                )
                reserves_count = decode_abi_uint(
                    reserves_count_raw, "getReservesCount"
                )
                if flash_loan_premium_bps > 10_000:
                    raise RuntimeError("flash loan premium is outside basis-point domain")
                if not 1 <= reserves_count <= 128:
                    raise RuntimeError("reserve count outside expected Aave V3 domain")

                provider_code, access_mode_5 = exact_state_rpc(
                    url,
                    "eth_getCode",
                    [addresses_provider],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 60,
                )
                oracle_code, access_mode_6 = exact_state_rpc(
                    url,
                    "eth_getCode",
                    [price_oracle],
                    block_hash,
                    block_number_hex,
                    provider_index * 100 + 70,
                )
                if provider_code in ("0x", "0x0", "") or oracle_code in ("0x", "0x0", ""):
                    raise RuntimeError("protocol identity contract code unavailable")

                access_modes = sorted(
                    {
                        access_mode_1,
                        access_mode_2,
                        access_mode_3,
                        access_mode_4,
                        access_mode_5,
                        access_mode_6,
                    }
                )
                observation.update(
                    {
                        "protocol_identity_probe": True,
                        "protocol_state_access_modes": access_modes,
                        "addresses_provider": addresses_provider,
                        "price_oracle": price_oracle,
                        "flash_loan_premium_bps": flash_loan_premium_bps,
                        "reserves_count": reserves_count,
                        "addresses_provider_selector": addresses_provider_selector,
                        "price_oracle_selector": price_oracle_selector,
                        "premium_selector": premium_selector,
                        "reserves_count_selector": reserves_count_selector,
                        "addresses_provider_code_sha256": sha256_text(provider_code.lower()),
                        "price_oracle_code_sha256": sha256_text(oracle_code.lower()),
                    }
                )
            except Exception as exc:
                observation["protocol_identity_probe_error"] = str(exc)

            observation.update(
                {
                    "rpc_ok": True,
                    "chain_id": chain_id,
                    "transaction_hash": tx_hash,
                    "receipt_status": receipt_status.lower(),
                    "block_number": block_number,
                    "block_hash": block_hash.lower(),
                    "parent_hash": parent_hash.lower(),
                    "timestamp": int(block["timestamp"], 16),
                    "gas_used": int(receipt.get("gasUsed", "0x0"), 16),
                    "effective_gas_price": int(receipt.get("effectiveGasPrice", "0x0"), 16),
                    "transaction_to": normalize_address(receipt.get("to")),
                    "pool_log_count": len(pool_logs),
                    "liquidation_log_count": len(liquidation_logs),
                    "liquidation_logs": liquidation_logs,
                }
            )
        except Exception as exc:
            observation["error"] = str(exc)

        observations.append(observation)
        provider_health.setdefault(
            provider_id,
            {
                "provider_url_sha256": sha256_text(url),
                "rpc_successes": 0,
                "exact_state_successes": 0,
                "errors": [],
            },
        )
        if observation["rpc_ok"]:
            provider_health[provider_id]["rpc_successes"] += 1
        if observation["exact_state_probe"]:
            provider_health[provider_id]["exact_state_successes"] += 1
        if observation["protocol_identity_probe"]:
            provider_health[provider_id].setdefault("protocol_identity_successes", 0)
            provider_health[provider_id]["protocol_identity_successes"] += 1
        if "error" in observation:
            provider_health[provider_id]["errors"].append(
                {"case_id": case_id, "error": observation["error"]}
            )

    valid = [item for item in observations if item["rpc_ok"]]
    if len(valid) < min_anchor:
        fail(
            f"{case_id}: only {len(valid)} providers resolved the candidate; "
            f"{min_anchor} required"
        )

    keys = [
        (
            item["block_number"],
            item["block_hash"],
            item["parent_hash"],
            item["receipt_status"],
        )
        for item in valid
    ]
    consensus_key, consensus_count = Counter(keys).most_common(1)[0]
    if consensus_count < min_anchor:
        fail(
            f"{case_id}: canonical anchor consensus {consensus_count} < {min_anchor}"
        )
    dissent = [item["provider_id"] for item, key in zip(valid, keys) if key != consensus_key]
    if dissent:
        fail(f"{case_id}: provider anchor dissent: {dissent}")

    consensus_observations = [
        item
        for item in valid
        if (
            item["block_number"],
            item["block_hash"],
            item["parent_hash"],
            item["receipt_status"],
        )
        == consensus_key
    ]
    exact_state = [item for item in consensus_observations if item["exact_state_probe"]]
    if len(exact_state) < min_state:
        errors = {
            item["provider_id"]: item.get("exact_state_probe_error")
            for item in consensus_observations
            if not item["exact_state_probe"]
        }
        fail(
            f"{case_id}: exact block-hash state providers {len(exact_state)} < "
            f"{min_state}; errors={errors}"
        )

    protocol_identity = [
        item for item in consensus_observations if item["protocol_identity_probe"]
    ]
    if len(protocol_identity) < min_state:
        errors = {
            item["provider_id"]: item.get("protocol_identity_probe_error")
            for item in consensus_observations
            if not item["protocol_identity_probe"]
        }
        fail(
            f"{case_id}: exact protocol identity providers {len(protocol_identity)} < "
            f"{min_state}; errors={errors}"
        )

    identity_keys = [
        (
            item["addresses_provider"],
            item["price_oracle"],
            item["flash_loan_premium_bps"],
            item["reserves_count"],
        )
        for item in protocol_identity
    ]
    protocol_key, protocol_count = Counter(identity_keys).most_common(1)[0]
    if protocol_count < min_state or protocol_count != len(protocol_identity):
        fail(f"{case_id}: protocol identity provider dissent")
    addresses_provider, price_oracle, flash_loan_premium_bps, reserves_count = protocol_key

    block_number, block_hash, parent_hash, receipt_status = consensus_key
    provider_identity = {
        "consensus_providers": sorted(item["provider_id"] for item in consensus_observations),
        "exact_state_providers": sorted(item["provider_id"] for item in exact_state),
        "protocol_identity_providers": sorted(item["provider_id"] for item in protocol_identity),
        "block_hash": block_hash,
    }
    provider_identity_text = json.dumps(
        provider_identity, sort_keys=True, separators=(",", ":")
    )

    fixture_candidate = {
        "schema_version": 1,
        "case_id": case_id,
        "strategy_family": "liquidation",
        "class_tags": candidate["class_tags"],
        "chain_id": 1,
        "block_number": block_number,
        "block_hash": block_hash,
        "parent_hash": parent_hash,
        "source_commit": SOURCE_SHA,
        "provider": {
            "kind": "archive_rpc",
            "identity": provider_identity_text,
            "identity_sha256": sha256_text(provider_identity_text),
            "historical_state_served": True,
        },
        "protocol": {
            "aave_pool": pool,
            "addresses_provider": addresses_provider,
            "price_oracle": price_oracle,
            "flash_loan_premium_bps": flash_loan_premium_bps,
            "reserves_count": reserves_count,
            "liquidation_call_topic0": topic0,
            "selectors": selectors,
        },
        "provenance": {
            "transaction_hash": tx_hash,
            "receipt_status": receipt_status,
            "discovery_only": True,
            "fixture_admitted": False,
        },
        "result": {
            "status": "NOT_TESTED",
            "evidence_sha256": None,
            "failure_artifact": None,
        },
    }

    observation_path = OUT / "providers" / f"{case_id}.json"
    observation_path.write_text(
        json.dumps(observations, indent=2, sort_keys=True) + "\n"
    )
    candidate_path = OUT / "candidates" / f"{case_id}.json"
    candidate_path.write_text(
        json.dumps(fixture_candidate, indent=2, sort_keys=True) + "\n"
    )

    case_summaries.append(
        {
            "case_id": case_id,
            "transaction_hash": tx_hash,
            "receipt_status": receipt_status,
            "block_number": block_number,
            "block_hash": block_hash,
            "parent_hash": parent_hash,
            "anchor_consensus_providers": consensus_count,
            "exact_state_providers": len(exact_state),
            "protocol_identity_providers": len(protocol_identity),
            "addresses_provider": addresses_provider,
            "price_oracle": price_oracle,
            "flash_loan_premium_bps": flash_loan_premium_bps,
            "reserves_count": reserves_count,
            "liquidation_log_count": max(
                item["liquidation_log_count"] for item in consensus_observations
            ),
            "candidate_fixture_sha256": hashlib.sha256(
                candidate_path.read_bytes()
            ).hexdigest(),
            "provider_observations_sha256": hashlib.sha256(
                observation_path.read_bytes()
            ).hexdigest(),
            "admission": "DISCOVERED_NOT_ADMITTED",
            "parity_status": "NOT_TESTED",
        }
    )

summary = {
    "schema_version": 1,
    "tranche": "T39_PROTOCOL_FORK_TRUTH_55_TO_62",
    "gate": "AAVE_HISTORICAL_FIXTURE_DISCOVERY",
    "source_sha": SOURCE_SHA,
    "chain_id": 1,
    "pool": pool,
    "minimum_anchor_consensus_providers": min_anchor,
    "minimum_exact_state_providers": min_state,
    "candidate_count": len(case_summaries),
    "candidates": case_summaries,
    "provider_health": provider_health,
    "fixture_admission": "NONE",
    "aave_state_parity": "NOT_TESTED",
    "aave_math_parity": "NOT_TESTED",
    "revm_fork_parity": "NOT_TESTED",
    "protocol_fork_truth": "NOT_CLOSED",
    "real_market_census": "NOT_TESTED",
    "live_pnl_evidence": False,
    "production_certification": "NOT_CERTIFIED",
}
(OUT / "discovery-summary.json").write_text(
    json.dumps(summary, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(summary, sort_keys=True))

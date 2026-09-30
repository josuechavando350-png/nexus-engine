#!/usr/bin/env python3
"""Collect exact, pre-anchor gas-price evidence for RMC-013.

No floating-point arithmetic is used. Reward percentiles are transport
parameters to eth_feeHistory; every monetary computation is integer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

WAD = 10**18
SCHEMA = "nqc-rmc-013-gas-provider-evidence-v1"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rpc_call(url: str, method: str, params: list[object]) -> object:
    body = canonical({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.loads(response.read())
    if not isinstance(payload, dict) or payload.get("error") is not None:
        raise RuntimeError(f"{method} RPC error: {payload!r}")
    if "result" not in payload:
        raise RuntimeError(f"{method} RPC response has no result")
    return payload["result"]


def hex_quantity(value: object, field: str) -> int:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError(f"{field} must be an RPC hex quantity")
    parsed = int(value, 16)
    if parsed < 0:
        raise ValueError(f"{field} is negative")
    return parsed


def address(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an address")
    lowered = value.lower()
    if len(lowered) != 42 or not lowered.startswith("0x"):
        raise ValueError(f"{field} has invalid address length")
    int(lowered[2:], 16)
    return lowered


def hash32(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a hash")
    lowered = value.lower()
    if len(lowered) != 66 or not lowered.startswith("0x"):
        raise ValueError(f"{field} has invalid hash length")
    int(lowered[2:], 16)
    return lowered


def decimal(value: object, field: str) -> int:
    if not isinstance(value, str) or not value.isdigit():
        raise ValueError(f"{field} must be an unsigned decimal string")
    return int(value)


def nearest_rank(values: list[int], percentile: int) -> int:
    if not values:
        raise ValueError("percentile sample is empty")
    if percentile < 1 or percentile > 100:
        raise ValueError("percentile outside [1,100]")
    ordered = sorted(values)
    rank = (percentile * len(ordered) + 99) // 100
    return ordered[rank - 1]


def load_anchor(path: Path) -> dict:
    root = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(root, dict):
        raise ValueError("anchor source is not an object")
    anchor = root.get("anchor")
    if not isinstance(anchor, dict):
        raise ValueError("D12 summary has no anchor")
    return {
        "chain_id": int(anchor["chain_id"]),
        "block_number": int(anchor["block_number"]),
        "block_hash": hash32(anchor["block_hash"], "anchor.block_hash"),
        "parent_hash": hash32(anchor["parent_hash"], "anchor.parent_hash"),
        "timestamp": int(anchor["timestamp"]),
        "state_root": hash32(anchor["state_root"], "anchor.state_root"),
    }


def native_price(oracle_path: Path, wrapped_native: str) -> dict:
    target = address(wrapped_native, "wrapped_native")
    matches = []
    with oracle_path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"oracle row {number} is not an object")
            if str(row.get("asset", "")).lower() == target:
                matches.append(row)
    if len(matches) != 1:
        raise ValueError(f"expected exactly one wrapped-native oracle row, got {len(matches)}")
    row = matches[0]
    price = decimal(row.get("price"), "oracle.price")
    base = decimal(row.get("base_currency_unit"), "oracle.base_currency_unit")
    if price <= 0 or base <= 0:
        raise ValueError("wrapped-native oracle price/base unit must be positive")
    if row.get("price_path") not in {"SOURCE_LATEST_ANSWER", "BASE_CURRENCY_UNIT"}:
        raise ValueError(f"wrapped-native oracle price path is not authoritative: {row.get('price_path')!r}")
    usd_wad = price * WAD // base
    if usd_wad <= 0:
        raise ValueError("wrapped-native USD-WAD price rounded to zero")
    return {
        "wrapped_native_asset": target,
        "raw_price": str(price),
        "base_currency_unit": str(base),
        "native_usd_wad": str(usd_wad),
        "price_path": row["price_path"],
        "oracle_row_sha256": sha256_bytes(canonical(row)),
        "oracle_manifest_sha256": sha256_file(oracle_path),
    }


def verify_anchor(block: object, chain_id: int, expected: dict) -> dict:
    if not isinstance(block, dict):
        raise ValueError("anchor block unavailable")
    observed = {
        "chain_id": chain_id,
        "block_number": hex_quantity(block.get("number"), "block.number"),
        "block_hash": hash32(block.get("hash"), "block.hash"),
        "parent_hash": hash32(block.get("parentHash"), "block.parentHash"),
        "timestamp": hex_quantity(block.get("timestamp"), "block.timestamp"),
        "state_root": hash32(block.get("stateRoot"), "block.stateRoot"),
    }
    if observed != expected:
        raise ValueError(f"provider anchor mismatch: observed={observed} expected={expected}")
    return observed


def parse_fee_history(value: object, block_count: int, reward_percentiles: list[int]) -> dict:
    if not isinstance(value, dict):
        raise ValueError("eth_feeHistory result is not an object")
    base = value.get("baseFeePerGas")
    rewards = value.get("reward")
    if not isinstance(base, list) or len(base) != block_count + 1:
        raise ValueError("fee-history baseFeePerGas length mismatch")
    if not isinstance(rewards, list) or len(rewards) != block_count:
        raise ValueError("fee-history reward length mismatch")
    parsed_rewards: list[list[int]] = []
    for row in rewards:
        if not isinstance(row, list) or len(row) != len(reward_percentiles):
            raise ValueError("fee-history reward row width mismatch")
        parsed_rewards.append([hex_quantity(item, "feeHistory.reward") for item in row])
    return {
        "oldest_block": hex_quantity(value.get("oldestBlock"), "feeHistory.oldestBlock"),
        "base_fees": [hex_quantity(item, "feeHistory.baseFeePerGas") for item in base],
        "rewards": parsed_rewards,
    }


def collect(
    rpc_url: str,
    provider_id: str,
    anchor: dict,
    oracle_path: Path,
    wrapped_native: str,
    history_blocks: int,
    reward_percentiles: list[int],
    admission_percentile: int,
) -> dict:
    if history_blocks < 8:
        raise ValueError("history_blocks must be at least 8")
    if reward_percentiles != sorted(set(reward_percentiles)):
        raise ValueError("reward_percentiles must be sorted and unique")
    if admission_percentile not in reward_percentiles:
        raise ValueError("admission percentile must be requested from the provider")

    chain_id = hex_quantity(rpc_call(rpc_url, "eth_chainId", []), "eth_chainId")
    block = rpc_call(rpc_url, "eth_getBlockByNumber", [hex(anchor["block_number"]), False])
    observed_anchor = verify_anchor(block, chain_id, anchor)
    anchor_base_fee = hex_quantity(block.get("baseFeePerGas"), "block.baseFeePerGas")
    if anchor_base_fee <= 0:
        raise ValueError("anchor base fee is zero")

    history = rpc_call(
        rpc_url,
        "eth_feeHistory",
        [hex(history_blocks), hex(anchor["block_number"]), reward_percentiles],
    )
    parsed = parse_fee_history(history, history_blocks, reward_percentiles)
    expected_oldest = anchor["block_number"] - history_blocks + 1
    if parsed["oldest_block"] != expected_oldest:
        raise ValueError(
            f"fee-history oldest block mismatch: {parsed['oldest_block']} != {expected_oldest}"
        )
    if parsed["base_fees"][-2] != anchor_base_fee:
        raise ValueError("fee-history anchor base fee differs from block header")

    reward_summary = {}
    for column, requested in enumerate(reward_percentiles):
        series = [row[column] for row in parsed["rewards"]]
        reward_summary[str(requested)] = {
            "sample_count": len(series),
            "min_wei": str(min(series)),
            "median_wei": str(nearest_rank(series, 50)),
            "p90_wei": str(nearest_rank(series, 90)),
            "p99_wei": str(nearest_rank(series, 99)),
            "max_wei": str(max(series)),
        }

    admission = int(reward_summary[str(admission_percentile)]["p99_wei"])
    next_base_upper = (anchor_base_fee * 9 + 7) // 8
    effective_budget = next_base_upper + admission
    price = native_price(oracle_path, wrapped_native)

    raw_evidence = {
        "anchor_block": {
            "number": block["number"],
            "hash": block["hash"],
            "parentHash": block["parentHash"],
            "stateRoot": block["stateRoot"],
            "timestamp": block["timestamp"],
            "baseFeePerGas": block["baseFeePerGas"],
        },
        "fee_history": history,
    }
    return {
        "schema": SCHEMA,
        "provider_id": provider_id,
        "anchor": observed_anchor,
        "history_blocks": history_blocks,
        "reward_percentiles": reward_percentiles,
        "admission_priority_percentile": admission_percentile,
        "reward_summary": reward_summary,
        "anchor_base_fee_wei": str(anchor_base_fee),
        "next_block_base_fee_upper_bound_wei": str(next_base_upper),
        "admission_priority_fee_wei": str(admission),
        "effective_gas_price_budget_wei": str(effective_budget),
        "native_price": price,
        "raw_rpc_evidence_sha256": sha256_bytes(canonical(raw_evidence)),
        "lookahead_used": False,
        "base_fee_policy": "NEXT_BLOCK_MAX_EIP1559_CEIL_9_OVER_8",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument("--provider-id", required=True)
    parser.add_argument("--anchor-summary", type=Path, required=True)
    parser.add_argument("--oracle-manifest", type=Path, required=True)
    parser.add_argument("--wrapped-native", required=True)
    parser.add_argument("--history-blocks", type=int, required=True)
    parser.add_argument("--reward-percentiles", required=True)
    parser.add_argument("--admission-priority-percentile", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    percentiles = [int(value) for value in args.reward_percentiles.split(",") if value]
    evidence = collect(
        args.rpc_url,
        args.provider_id,
        load_anchor(args.anchor_summary),
        args.oracle_manifest,
        args.wrapped_native,
        args.history_blocks,
        percentiles,
        args.admission_priority_percentile,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(evidence))
    print(
        "RMC013_GAS_PROVIDER_EVIDENCE_PASS",
        f"provider={args.provider_id}",
        f"budget_wei={evidence['effective_gas_price_budget_wei']}",
    )


if __name__ == "__main__":
    main()

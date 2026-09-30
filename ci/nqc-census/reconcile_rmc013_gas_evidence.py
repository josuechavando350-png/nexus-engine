#!/usr/bin/env python3
"""Reconcile independent RMC-013 gas evidence conservatively."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

SCHEMA = "nqc-rmc-013-gas-price-evidence-v1"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not an object")
    return value


def reconcile(paths: list[Path]) -> dict:
    if len(paths) < 2:
        raise ValueError("at least two provider evidence files are required")
    rows = [load(path) for path in paths]
    ids = [row.get("provider_id") for row in rows]
    if len(ids) != len(set(ids)) or any(not isinstance(item, str) or not item for item in ids):
        raise ValueError("provider ids are missing or duplicated")

    first = rows[0]
    for row in rows[1:]:
        if row.get("anchor") != first.get("anchor"):
            raise ValueError("provider anchors disagree")
        if row.get("native_price") != first.get("native_price"):
            raise ValueError("provider native-price authority differs")
        if row.get("history_blocks") != first.get("history_blocks"):
            raise ValueError("provider history windows differ")
        if row.get("reward_percentiles") != first.get("reward_percentiles"):
            raise ValueError("provider reward percentile policies differ")
        if row.get("admission_priority_percentile") != first.get("admission_priority_percentile"):
            raise ValueError("provider admission percentiles differ")
        if row.get("anchor_base_fee_wei") != first.get("anchor_base_fee_wei"):
            raise ValueError("provider anchor base fees disagree")
        if row.get("next_block_base_fee_upper_bound_wei") != first.get("next_block_base_fee_upper_bound_wei"):
            raise ValueError("provider next-block base-fee bounds disagree")
        if row.get("lookahead_used") is not False:
            raise ValueError("gas evidence used lookahead")

    chosen_priority = max(int(row["admission_priority_fee_wei"]) for row in rows)
    next_base = int(first["next_block_base_fee_upper_bound_wei"])
    provider_commitments = [
        {
            "provider_id": row["provider_id"],
            "sha256": sha256_bytes(canonical(row)),
            "admission_priority_fee_wei": row["admission_priority_fee_wei"],
        }
        for row in sorted(rows, key=lambda item: item["provider_id"])
    ]
    return {
        "schema": SCHEMA,
        "status": "RMC_013_GAS_PRICE_EVIDENCE_PASS",
        "anchor": first["anchor"],
        "history_blocks": first["history_blocks"],
        "reward_percentiles": first["reward_percentiles"],
        "admission_priority_percentile": first["admission_priority_percentile"],
        "anchor_base_fee_wei": first["anchor_base_fee_wei"],
        "next_block_base_fee_upper_bound_wei": str(next_base),
        "admission_priority_fee_wei": str(chosen_priority),
        "effective_gas_price_budget_wei": str(next_base + chosen_priority),
        "native_price": first["native_price"],
        "provider_evidence": provider_commitments,
        "provider_reconciliation": "MAX_ADMISSION_PRIORITY_FEE_REQUIRE_EXACT_ANCHOR_AND_NATIVE_PRICE",
        "lookahead_used": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider-evidence", type=Path, action="append", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = reconcile(args.provider_evidence)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(result))
    print(
        "RMC013_GAS_PRICE_RECONCILIATION_PASS",
        f"providers={len(result['provider_evidence'])}",
        f"budget_wei={result['effective_gas_price_budget_wei']}",
    )


if __name__ == "__main__":
    main()

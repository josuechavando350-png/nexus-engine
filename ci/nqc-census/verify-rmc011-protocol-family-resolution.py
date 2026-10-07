#!/usr/bin/env python3
"""Derive terminal evidence rows for the four protocol-native RMC-011 families."""

from __future__ import annotations

import json
import sys
from pathlib import Path

FAMILY_CLASS = {
    "AAVE_V3_FLASH_LOAN": "PROTOCOL_NATIVE_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP": "FLASH_SWAP",
}
NATIVE_FAMILIES = {"BALANCER_V2_FLASH_LOAN", "UNISWAP_V3_FLASH"}
ALL_FAMILIES = set(FAMILY_CLASS) | NATIVE_FAMILIES


class ResolutionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ResolutionError(message)


def nonnegative(value: object, label: str) -> int:
    require(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0,
        f"{label} must be a nonnegative integer",
    )
    return value


def validate_documents(
    summary: dict,
    lock: dict,
    balancer: dict,
    uniswap_v3: dict,
    expanded: dict,
) -> dict:
    sources_by_class = summary.get("sources_by_class")
    require(isinstance(sources_by_class, dict), "capital summary lacks sources_by_class")

    legacy_counts = {
        family: nonnegative(sources_by_class.get(class_name, 0), family)
        for family, class_name in FAMILY_CLASS.items()
    }

    require(
        balancer.get("status") == "RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED",
        "Balancer reconciliation is not PASS",
    )
    require(
        uniswap_v3.get("status") == "RMC011_UNISWAP_V3_DUAL_PROVIDER_RECONCILED",
        "Uniswap V3 reconciliation is not PASS",
    )
    balancer_count = nonnegative(balancer.get("source_count"), "Balancer source_count")
    uniswap_v3_count = nonnegative(uniswap_v3.get("source_count"), "Uniswap V3 source_count")

    require(
        expanded.get("status") == "RMC011_EXPANDED_LEDGER_REPLAY_PASS",
        "expanded ledger replay is not PASS",
    )
    legacy_source_count = nonnegative(expanded.get("legacy_source_count"), "legacy_source_count")
    d08_source_count = nonnegative(expanded.get("d08_source_count"), "d08_source_count")
    d11_native_source_count = nonnegative(
        expanded.get("d11_native_source_count"), "d11_native_source_count"
    )
    expanded_source_count = nonnegative(
        expanded.get("expanded_source_count"), "expanded_source_count"
    )
    require(d08_source_count == legacy_source_count, "D08/legacy source count differs")
    require(
        d11_native_source_count == balancer_count + uniswap_v3_count,
        "D11 native source count differs from reconciled venues",
    )
    require(
        expanded_source_count == legacy_source_count + d11_native_source_count,
        "expanded source conservation failed",
    )

    stages = lock.get("stages")
    require(isinstance(stages, list), "authority lock lacks stages")
    d08_rows = [
        row for row in stages
        if isinstance(row, dict) and row.get("stage") == "RMC-008"
    ]
    require(len(d08_rows) == 1, "authority lock must contain exactly one RMC-008 row")
    d08_sha = d08_rows[0].get("artifact_sha256")
    require(isinstance(d08_sha, str) and d08_sha.strip(), "RMC-008 artifact digest missing")

    counts = {
        **legacy_counts,
        "BALANCER_V2_FLASH_LOAN": balancer_count,
        "UNISWAP_V3_FLASH": uniswap_v3_count,
    }
    require(set(counts) == ALL_FAMILIES, "protocol-family set differs")

    rows = []
    for family in sorted(ALL_FAMILIES):
        count = counts[family]
        rows.append({
            "family": family,
            "outcome": (
                "AUTHENTICATED_REAL_SOURCE"
                if count > 0
                else "EXHAUSTIVE_REJECTION"
            ),
            "source_count": count,
            "scope": "RMC011_EXACT_PROTOCOL_NATIVE_CAPITAL_SOURCE_UNIVERSE_AT_THIS_HEAD",
            "basis": (
                ["D08_AUTHENTICATED_REAL_SOURCE_IMPORT", "D08_EXACT_SOURCE_REPLAY"]
                if family in FAMILY_CLASS
                else [
                    "D11_DUAL_PROVIDER_LIVE_ACQUISITION",
                    "D11_RUST_RECONCILIATION",
                    "D11_EXPANDED_LEDGER_REPLAY",
                ]
            ),
        })

    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "RMC011_PROTOCOL_FAMILY_RESOLUTION_READY",
        "claim_scope": "RMC011_EXACT_PROTOCOL_NATIVE_CAPITAL_SOURCE_UNIVERSE_AT_THIS_HEAD",
        "family_count": 4,
        "families": rows,
        "d08_authority_artifact_sha256": d08_sha,
        "legacy_source_count": legacy_source_count,
        "d11_native_source_count": d11_native_source_count,
        "expanded_source_count": expanded_source_count,
        "expanded_capital_commitment": expanded.get("expanded_capital_commitment"),
        "global_capital_source_completeness_claimed": False,
        "terminal_d11_closed": False,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(
            "usage: verify-rmc011-protocol-family-resolution.py "
            "<summary.json> <authority-lock.json> <balancer.json> "
            "<uniswap-v3.json> <expanded.json> <out.json>",
            file=sys.stderr,
        )
        return 2
    try:
        docs = [
            json.loads(Path(path).read_text(encoding="utf-8"))
            for path in argv[1:6]
        ]
        result = validate_documents(*docs)
    except (OSError, json.JSONDecodeError, ResolutionError, ValueError) as exc:
        print(f"RMC011_PROTOCOL_FAMILY_RESOLUTION_INVALID {exc}", file=sys.stderr)
        return 1

    out = Path(argv[6])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        "RMC011_PROTOCOL_FAMILY_RESOLUTION_READY "
        + " ".join(
            f"{row['family']}={row['outcome']}:{row['source_count']}"
            for row in result["families"]
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

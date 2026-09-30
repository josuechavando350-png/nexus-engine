#!/usr/bin/env python3
"""Validate the declared exhaustive discovery surfaces for RMC-011."""

from __future__ import annotations

import json
import sys
from pathlib import Path

EXPECTED_FAMILIES = {
    "AAVE_V3_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN",
    "UNISWAP_V3_FLASH",
    "EXTERNAL_GAS_CREDIT",
    "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT",
    "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}

EXPECTED_NON_CLAIMS = {
    "DISCOVERY_PLAN_IS_NOT_DISCOVERY_EVIDENCE",
    "MODEL_OR_IMPLEMENTATION_IS_NOT_SOURCE_AVAILABILITY",
    "HISTORICAL_T36_BALANCER_PARITY_IS_NOT_CURRENT_D11_SOURCE_EVIDENCE",
    "PUBLIC_WEB_SEARCH_IS_NOT_CAPITAL_SOURCE_AUTHORITY",
}


class DiscoveryError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DiscoveryError(message)


def text(row: dict, key: str, label: str) -> str:
    value = row.get(key)
    require(isinstance(value, str) and value.strip(), f"{label}: {key} must be non-empty text")
    return value


def validate_document(doc: dict, universe: dict | None = None) -> dict:
    require(doc.get("schema_version") == 1, "schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_CAPITAL_FAMILY_DISCOVERY_V1",
        "unexpected discovery contract",
    )
    require(
        doc.get("completeness_rule")
        == "EVERY_REQUIRED_FAMILY_HAS_ONE_EXHAUSTIVE_DISCOVERY_SURFACE_AND_EVERY_SURFACE_IS_AUTHENTICATED_AT_OR_FOR_THE_CERTIFIED_ANCHOR",
        "unexpected completeness rule",
    )
    text(doc, "observation_scope", "document")

    rows = doc.get("families")
    require(isinstance(rows, list), "families must be an array")
    require(len(rows) == len(EXPECTED_FAMILIES), "family count differs")

    seen: set[str] = set()
    for row in rows:
        require(isinstance(row, dict), "family row must be an object")
        family_id = text(row, "id", "family")
        require(family_id in EXPECTED_FAMILIES, f"unknown family id: {family_id}")
        require(family_id not in seen, f"duplicate family id: {family_id}")
        seen.add(family_id)
        text(row, "surface", family_id)
        text(row, "authority", family_id)
        text(row, "anchor_mode", family_id)
        text(row, "completeness", family_id)
        text(row, "negative_proof", family_id)
        text(row, "implementation", family_id)

    require(seen == EXPECTED_FAMILIES, "required family set differs")

    by_id = {row["id"]: row for row in rows}
    require(
        by_id["BALANCER_V2_FLASH_LOAN"]["authority"] == "D11_DUAL_PROVIDER_RPC_ACQUISITION",
        "Balancer V2 must use current D11 dual-provider acquisition",
    )
    require(
        by_id["UNISWAP_V3_FLASH"]["authority"] == "D11_DUAL_PROVIDER_RPC_ACQUISITION",
        "Uniswap V3 must use current D11 dual-provider acquisition",
    )
    for family_id in {
        "EXTERNAL_GAS_CREDIT",
        "EXTERNAL_GAS_SPONSOR",
        "TRANSIENT_EXTERNAL_CREDIT",
    }:
        require(
            "PROVIDER_REGISTRY" in by_id[family_id]["surface"],
            f"{family_id}: external source family must be registry-enumerated",
        )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "non_claims must be an array")
    require(len(non_claims) == len(set(non_claims)), "non_claims contains duplicates")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "non-claim set differs")

    if universe is not None:
        universe_rows = universe.get("families")
        require(isinstance(universe_rows, list), "source-universe families must be an array")
        universe_ids = {row.get("id") for row in universe_rows}
        require(universe_ids == seen, "discovery and source-universe family sets differ")

    return {
        "family_count": len(rows),
        "families": sorted(seen),
        "cross_checked_universe": universe is not None,
    }


def main(argv: list[str]) -> int:
    discovery_path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-capital-family-discovery.json"
    )
    universe_path = Path(argv[2]) if len(argv) > 2 else Path(
        "ci/nqc-census/rmc011-capital-source-universe.json"
    )
    try:
        discovery = json.loads(discovery_path.read_text(encoding="utf-8"))
        universe = json.loads(universe_path.read_text(encoding="utf-8"))
        result = validate_document(discovery, universe)
    except (OSError, json.JSONDecodeError, DiscoveryError) as exc:
        print(f"RMC011_CAPITAL_FAMILY_DISCOVERY_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_CAPITAL_FAMILY_DISCOVERY_PASS "
        f"families={result['family_count']} "
        f"cross_checked_universe={str(result['cross_checked_universe']).lower()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

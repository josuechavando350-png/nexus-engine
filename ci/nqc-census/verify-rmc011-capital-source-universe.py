#!/usr/bin/env python3
"""Fail-closed verifier for the RMC-011 capital-source universe contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REQUIRED_FAMILIES = {
    "AAVE_V3_FLASH_LOAN": "PROTOCOL_NATIVE_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP": "FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN": "ATOMIC_FLASH_LIQUIDITY",
    "UNISWAP_V3_FLASH": "ATOMIC_FLASH_LIQUIDITY",
    "EXTERNAL_GAS_CREDIT": "GAS_FUNDING",
    "EXTERNAL_GAS_SPONSOR": "GAS_FUNDING",
    "TRANSIENT_EXTERNAL_CREDIT": "TRANSIENT_CREDIT",
    "COLLATERALIZED_BORROWING": "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT": "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT": "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE": "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT": "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK": "INTRA_BLOCK_TEMPORARY_LOCK",
}

RESOLVED_STATUSES = {
    "AUTHENTICATED_REAL_SOURCE",
    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE",
}
UNRESOLVED_STATUSES = {
    "SEMANTIC_ADMISSION_IMPLEMENTED",
    "SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED",
    "MODEL_ONLY",
}
ALLOWED_STATUSES = RESOLVED_STATUSES | UNRESOLVED_STATUSES

REQUIRED_INVARIANTS = {
    "UNKNOWN_FAMILY_COUNT_EQ_0",
    "EVERY_REQUIRED_FAMILY_TERMINALLY_RESOLVED",
    "TERMINALLY_RESOLVED_REQUIRES_AUTHENTICATED_REAL_SOURCE_OR_EXHAUSTIVE_REJECTION",
    "SOURCE_FAMILY_UNIVERSE_DISCOVERY_AUTHENTICATED_COMPLETE",
    "GLOBAL_CAPITAL_SOURCE_COMPLETENESS_CLAIMED_ONLY_IF_ALL_REQUIRED_FAMILIES_RESOLVED",
    "REAL_SOURCE_PACKAGE_PASS_IS_NOT_D11_TERMINAL_CLOSED",
    "ZERO_OWN_CAPITAL_IS_NEVER_INFERRED_FROM_ABSENCE_OF_OPERATOR_ALLOCATIONS",
    "EXTERNAL_GAS_REQUIRES_AUTHENTICATED_REAL_SOURCE_EVIDENCE",
}


class UniverseError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise UniverseError(message)


def digest64(value: Any, context: str) -> str:
    require(isinstance(value, str), f"{context}: digest must be text")
    normalized = value[2:] if value.startswith("0x") else value
    require(
        len(normalized) == 64
        and normalized != "0" * 64
        and all(ch in "0123456789abcdefABCDEF" for ch in normalized),
        f"{context}: expected nonzero 32-byte hex digest",
    )
    return normalized.lower()


def validate_resolution_evidence(row: dict[str, Any]) -> None:
    family_id = row["id"]
    evidence = row.get("resolution_evidence")
    if not row["terminally_resolved"]:
        require(
            evidence is None,
            f"{family_id}: unresolved family cannot carry terminal resolution evidence",
        )
        return

    require(isinstance(evidence, dict), f"{family_id}: terminal resolution evidence missing")
    require(
        evidence.get("kind") == row["status"],
        f"{family_id}: resolution evidence kind differs from status",
    )
    digest64(evidence.get("sha256"), f"{family_id}.resolution_evidence.sha256")
    require(
        isinstance(evidence.get("authority_ref"), str) and evidence["authority_ref"],
        f"{family_id}: terminal resolution authority_ref missing",
    )


def validate_scope(scope: dict[str, Any], doc: dict[str, Any]) -> None:
    require(scope.get("schema_version") == 2, "scope schema_version must equal 2")
    require(scope.get("stage") == "RMC-011", "scope stage must equal RMC-011")
    required_ids = scope.get("required_source_families")
    require(isinstance(required_ids, list), "scope required_source_families missing")
    require(len(required_ids) == len(set(required_ids)), "scope required_source_families repeats IDs")
    require(set(required_ids) == set(REQUIRED_FAMILIES), "scope required source-family set differs")

    required_classes = scope.get("required_classes")
    require(isinstance(required_classes, list), "scope required_classes missing")
    require(
        set(required_classes) == set(REQUIRED_FAMILIES.values()),
        "scope required capital-class set differs",
    )
    require(
        scope.get("source_family_universe_discovery_required") is True,
        "scope must require source-family-universe discovery",
    )
    require(
        scope.get("source_universe_contract")
        == "ci/nqc-census/rmc011-capital-source-universe.json",
        "scope source-universe contract path differs",
    )

    family_ids = {row["id"] for row in doc["families"]}
    require(family_ids == set(required_ids), "document family set differs from scope")


def validate_document(doc: dict[str, Any]) -> dict[str, Any]:
    require(doc.get("schema_version") == 2, "schema_version must equal 2")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_CAPITAL_SOURCE_UNIVERSE_V1",
        "unexpected source-universe contract",
    )
    require(doc.get("unknown_family_count") == 0, "unknown_family_count must be zero")
    require(
        doc.get("observation_scope") == "ETHEREUM_ANCHOR_BOUND_WHERE_APPLICABLE",
        "unexpected observation_scope",
    )

    families = doc.get("families")
    require(isinstance(families, list), "families must be an array")
    require(len(families) == len(REQUIRED_FAMILIES), "required family count differs")

    seen: set[str] = set()
    unresolved: list[str] = []
    resolved: list[str] = []

    for row in families:
        require(isinstance(row, dict), "family row must be an object")
        family_id = row.get("id")
        require(isinstance(family_id, str) and family_id, "family id must be non-empty text")
        require(family_id not in seen, f"duplicate family id: {family_id}")
        seen.add(family_id)
        require(family_id in REQUIRED_FAMILIES, f"unknown family id: {family_id}")
        require(
            row.get("capital_class") == REQUIRED_FAMILIES[family_id],
            f"{family_id}: capital_class mismatch",
        )

        status = row.get("status")
        require(status in ALLOWED_STATUSES, f"{family_id}: unsupported status {status!r}")
        expected_resolved = status in RESOLVED_STATUSES
        require(
            row.get("terminally_resolved") is expected_resolved,
            f"{family_id}: terminally_resolved disagrees with authenticated status",
        )

        real_source_path = row.get("real_source_path")
        if status in {
            "SEMANTIC_ADMISSION_IMPLEMENTED",
            "SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED",
            "AUTHENTICATED_REAL_SOURCE",
            "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE",
        }:
            require(
                isinstance(real_source_path, str) and real_source_path,
                f"{family_id}: status requires an evidence/admission path",
            )
        if status == "MODEL_ONLY":
            require(
                real_source_path is None,
                f"{family_id}: MODEL_ONLY cannot claim a real_source_path",
            )

        validate_resolution_evidence(row)
        (resolved if expected_resolved else unresolved).append(family_id)

    require(seen == set(REQUIRED_FAMILIES), "required family set differs")

    invariants = doc.get("terminal_invariants")
    require(isinstance(invariants, list), "terminal_invariants must be an array")
    require(len(invariants) == len(set(invariants)), "terminal_invariants contains duplicates")
    require(set(invariants) == REQUIRED_INVARIANTS, "terminal invariant set differs")

    discovery = doc.get("family_universe_discovery")
    require(isinstance(discovery, dict), "family_universe_discovery missing")
    require(
        discovery.get("terminal_requirement") == "AUTHENTICATED_COMPLETE",
        "family-universe terminal requirement differs",
    )
    discovery_status = discovery.get("status")
    require(
        discovery_status in {"NOT_CERTIFIED", "AUTHENTICATED_COMPLETE"},
        "unsupported family-universe discovery status",
    )
    if discovery_status == "AUTHENTICATED_COMPLETE":
        evidence = discovery.get("evidence")
        require(isinstance(evidence, dict), "authenticated family-universe evidence missing")
        digest64(evidence.get("sha256"), "family_universe_discovery.evidence.sha256")
        require(
            isinstance(evidence.get("authority_ref"), str) and evidence["authority_ref"],
            "family-universe discovery authority_ref missing",
        )
    else:
        require(
            discovery.get("evidence") is None,
            "uncertified family-universe discovery cannot carry terminal evidence",
        )

    all_resolved = not unresolved
    discovery_complete = discovery_status == "AUTHENTICATED_COMPLETE"
    terminal_ready = all_resolved and discovery_complete

    expected_status = "D11_TERMINAL_CLOSED" if terminal_ready else "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
    require(doc.get("status") == expected_status, "status disagrees with terminal readiness")
    require(
        doc.get("terminal_claim_allowed") is terminal_ready,
        "terminal_claim_allowed disagrees with terminal readiness",
    )

    return {
        "family_count": len(families),
        "resolved_count": len(resolved),
        "unresolved_count": len(unresolved),
        "resolved": sorted(resolved),
        "unresolved": sorted(unresolved),
        "family_universe_discovery": discovery_status,
        "terminal_claim_allowed": terminal_ready,
        "status": expected_status,
    }


def main(argv: list[str]) -> int:
    universe_path = (
        Path(argv[1])
        if len(argv) > 1
        else Path("ci/nqc-census/rmc011-capital-source-universe.json")
    )
    scope_path = (
        Path(argv[2])
        if len(argv) > 2
        else Path("ci/nqc-census/capital-census-scope.json")
    )
    try:
        doc = json.loads(universe_path.read_text(encoding="utf-8"))
        scope = json.loads(scope_path.read_text(encoding="utf-8"))
        result = validate_document(doc)
        validate_scope(scope, doc)
    except (OSError, json.JSONDecodeError, UniverseError) as exc:
        print(f"RMC011_CAPITAL_SOURCE_UNIVERSE_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_CAPITAL_SOURCE_UNIVERSE_PASS "
        f"families={result['family_count']} "
        f"resolved={result['resolved_count']} "
        f"unresolved={result['unresolved_count']} "
        f"family_universe_discovery={result['family_universe_discovery']} "
        f"terminal_claim_allowed={str(result['terminal_claim_allowed']).lower()} "
        f"status={result['status']}"
    )
    if result["unresolved"]:
        print("RMC011_UNRESOLVED_FAMILIES=" + ",".join(result["unresolved"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

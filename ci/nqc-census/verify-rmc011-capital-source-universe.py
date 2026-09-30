#!/usr/bin/env python3
"""Fail-closed verifier for the RMC-011 capital-source universe contract.

This contract certifies source-universe readiness only. It can never emit or
authorize D11 terminal closure by itself.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

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

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class UniverseError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise UniverseError(message)


def validate_evidence(value: object, expected_kind: str, label: str) -> None:
    require(isinstance(value, dict), f"{label}: resolution evidence must be an object")
    require(value.get("kind") == expected_kind, f"{label}: unexpected evidence kind")
    locator = value.get("locator")
    require(isinstance(locator, str) and locator, f"{label}: evidence locator is required")
    sha256 = value.get("sha256")
    require(
        isinstance(sha256, str) and SHA256_RE.fullmatch(sha256) is not None,
        f"{label}: evidence sha256 must be 64 lowercase hex",
    )


def validate_document(doc: dict) -> dict:
    require(doc.get("schema_version") == 2, "schema_version must equal 2")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_CAPITAL_SOURCE_UNIVERSE_V1",
        "unexpected source-universe contract",
    )
    require(
        doc.get("claim_scope") == "SOURCE_UNIVERSE_READINESS_ONLY",
        "source-universe claim_scope must remain readiness-only",
    )
    require(doc.get("d11_terminal_closed") is False, "source-universe contract cannot close D11")
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
            f"{family_id}: terminally_resolved disagrees with status",
        )

        real_source_path = row.get("real_source_path")
        resolution_evidence = row.get("resolution_evidence")
        if status in {
            "SEMANTIC_ADMISSION_IMPLEMENTED",
            "SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED",
            "AUTHENTICATED_REAL_SOURCE",
        }:
            require(
                isinstance(real_source_path, str) and real_source_path,
                f"{family_id}: admission status requires real_source_path",
            )
        if status == "MODEL_ONLY":
            require(real_source_path is None, f"{family_id}: MODEL_ONLY cannot claim real_source_path")

        if status == "AUTHENTICATED_REAL_SOURCE":
            validate_evidence(resolution_evidence, "AUTHENTICATED_REAL_SOURCE", family_id)
        elif status == "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE":
            require(
                real_source_path is None,
                f"{family_id}: exhaustive rejection cannot claim a real source path",
            )
            validate_evidence(resolution_evidence, "EXHAUSTIVE_REJECTION", family_id)
        else:
            require(
                resolution_evidence is None,
                f"{family_id}: unresolved family cannot carry terminal resolution evidence",
            )

        (resolved if expected_resolved else unresolved).append(family_id)

    require(seen == set(REQUIRED_FAMILIES), "required family set differs")

    invariants = doc.get("terminal_invariants")
    require(isinstance(invariants, list), "terminal_invariants must be an array")
    require(len(invariants) == len(set(invariants)), "terminal_invariants contains duplicates")
    require(set(invariants) == REQUIRED_INVARIANTS, "terminal invariant set differs")

    discovery = doc.get("family_universe_discovery")
    require(isinstance(discovery, dict), "family_universe_discovery must be an object")
    require(
        discovery.get("terminal_requirement") == "AUTHENTICATED_COMPLETE",
        "unexpected family-universe discovery terminal requirement",
    )
    discovery_status = discovery.get("status")
    require(
        discovery_status in {"NOT_CERTIFIED", "AUTHENTICATED_COMPLETE"},
        "unsupported family-universe discovery status",
    )
    if discovery_status == "AUTHENTICATED_COMPLETE":
        validate_evidence(
            discovery.get("evidence"),
            "AUTHENTICATED_DISCOVERY",
            "family_universe_discovery",
        )
    else:
        require(
            discovery.get("evidence") is None,
            "uncertified family-universe discovery cannot carry terminal evidence",
        )

    all_families_resolved = not unresolved
    discovery_complete = discovery_status == "AUTHENTICATED_COMPLETE"
    universe_complete = all_families_resolved and discovery_complete
    expected_status = (
        "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        if universe_complete
        else "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
    )

    require(doc.get("status") == expected_status, "status disagrees with source-universe readiness")
    require(
        doc.get("terminal_claim_allowed") is universe_complete,
        "terminal_claim_allowed disagrees with source-universe readiness",
    )
    require(doc.get("status") != "D11_TERMINAL_CLOSED", "source-universe file cannot close D11")

    return {
        "family_count": len(families),
        "resolved_count": len(resolved),
        "unresolved_count": len(unresolved),
        "resolved": sorted(resolved),
        "unresolved": sorted(unresolved),
        "family_universe_discovery_complete": discovery_complete,
        "terminal_claim_allowed": universe_complete,
        "status": expected_status,
        "d11_terminal_closed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-capital-source-universe.json"
    )
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, UniverseError) as exc:
        print(f"RMC011_CAPITAL_SOURCE_UNIVERSE_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_CAPITAL_SOURCE_UNIVERSE_PASS "
        f"families={result['family_count']} "
        f"resolved={result['resolved_count']} "
        f"unresolved={result['unresolved_count']} "
        f"discovery_complete={str(result['family_universe_discovery_complete']).lower()} "
        f"terminal_claim_allowed={str(result['terminal_claim_allowed']).lower()} "
        f"status={result['status']} "
        "d11_terminal_closed=false"
    )
    if result["unresolved"]:
        print("RMC011_UNRESOLVED_FAMILIES=" + ",".join(result["unresolved"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

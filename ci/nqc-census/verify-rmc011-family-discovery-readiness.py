#!/usr/bin/env python3
"""Derive readiness for authenticated RMC-011 family-universe discovery evidence.

This verifier validates local contract coherence and determines whether all
thirteen required source families have terminal evidence metadata ready for
transport authentication. It does not authenticate GitHub runs or artifacts;
the dedicated workflow owns that boundary.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path("ci/nqc-census")
DISCOVERY_PATH = ROOT / "rmc011-capital-family-discovery.json"
UNIVERSE_PATH = ROOT / "rmc011-capital-source-universe.json"
DISCOVERY_VERIFIER = ROOT / "verify-rmc011-capital-family-discovery.py"
UNIVERSE_VERIFIER = ROOT / "verify-rmc011-capital-source-universe.py"

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
TERMINAL_STATUSES = {
    "AUTHENTICATED_REAL_SOURCE": "AUTHENTICATED_REAL_SOURCE",
    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE": "EXHAUSTIVE_REJECTION",
}


class ReadinessError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReadinessError(message)


def load_verifier(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"cannot load verifier {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_documents(discovery: dict, universe: dict) -> dict:
    discovery_mod = load_verifier(DISCOVERY_VERIFIER, "rmc011_family_discovery")
    universe_mod = load_verifier(UNIVERSE_VERIFIER, "rmc011_source_universe")

    # Reuse the canonical validators first; readiness is an additional boundary.
    discovery_mod.validate_document(
        discovery,
        universe,
        json.loads((ROOT / "rmc011-uniswap-v3-deployment.json").read_text(encoding="utf-8")),
    )
    universe_mod.validate_document(universe)

    discovery_rows = discovery.get("families")
    universe_rows = universe.get("families")
    require(isinstance(discovery_rows, list), "discovery families must be an array")
    require(isinstance(universe_rows, list), "source-universe families must be an array")

    discovery_ids = {row.get("id") for row in discovery_rows if isinstance(row, dict)}
    by_id = {row.get("id"): row for row in universe_rows if isinstance(row, dict)}
    require(discovery_ids == EXPECTED_FAMILIES, "discovery family set differs")
    require(set(by_id) == EXPECTED_FAMILIES, "source-universe family set differs")

    ready_rows = []
    unresolved = []
    for family in sorted(EXPECTED_FAMILIES):
        row = by_id[family]
        status = row.get("status")
        if status not in TERMINAL_STATUSES:
            require(row.get("terminally_resolved") is False, f"{family}: unresolved family has terminal flag")
            require(row.get("resolution_evidence") is None, f"{family}: unresolved family carries terminal evidence")
            unresolved.append(family)
            continue

        expected_kind = TERMINAL_STATUSES[status]
        require(row.get("terminally_resolved") is True, f"{family}: terminal family lacks terminal flag")
        evidence = row.get("resolution_evidence")
        require(isinstance(evidence, dict), f"{family}: terminal evidence is missing")
        require(evidence.get("kind") == expected_kind, f"{family}: terminal evidence kind differs")

        ready_rows.append({
            "family": family,
            "status": status,
            "kind": expected_kind,
            "repository": evidence["repository"],
            "workflow_name": evidence["workflow_name"],
            "run_id": evidence["run_id"],
            "head_sha": evidence["head_sha"],
            "artifact_id": evidence["artifact_id"],
            "artifact_name": evidence["artifact_name"],
            "artifact_digest": evidence["artifact_digest"],
            "file": evidence["file"],
            "sha256": evidence["sha256"],
        })

    require(
        len(ready_rows) + len(unresolved) == len(EXPECTED_FAMILIES),
        "family readiness conservation failed",
    )

    already_complete = universe.get("family_universe_discovery", {}).get("status") == "AUTHENTICATED_COMPLETE"
    if already_complete:
        require(not unresolved, "authenticated discovery cannot coexist with unresolved families")

    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": (
            "RMC011_FAMILY_DISCOVERY_ALREADY_AUTHENTICATED"
            if already_complete
            else (
                "RMC011_FAMILY_DISCOVERY_TRANSPORT_READY"
                if not unresolved
                else "RMC011_FAMILY_DISCOVERY_BLOCKED"
            )
        ),
        "ready": not unresolved and not already_complete,
        "already_authenticated": already_complete,
        "family_count": len(EXPECTED_FAMILIES),
        "resolved_count": len(ready_rows),
        "unresolved_count": len(unresolved),
        "unresolved_families": unresolved,
        "family_evidence": ready_rows,
        "authenticated_complete_claimed": already_complete,
        "d11_terminal_closed": False,
    }


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else None
    try:
        discovery = json.loads(DISCOVERY_PATH.read_text(encoding="utf-8"))
        universe = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
        result = validate_documents(discovery, universe)
    except (OSError, json.JSONDecodeError, ReadinessError, ValueError) as exc:
        print(f"RMC011_FAMILY_DISCOVERY_READINESS_INVALID {exc}", file=sys.stderr)
        return 1

    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(encoded, encoding="utf-8")

    print(
        "RMC011_FAMILY_DISCOVERY_READINESS "
        f"status={result['status']} "
        f"resolved={result['resolved_count']}/{result['family_count']} "
        f"unresolved={result['unresolved_count']} "
        f"ready={str(result['ready']).lower()} "
        f"already_authenticated={str(result['already_authenticated']).lower()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

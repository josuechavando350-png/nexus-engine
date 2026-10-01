#!/usr/bin/env python3
"""Derive bounded RMC-011 exhaustive rejections from authenticated-scope catalogs.

This does not claim global provider/facility nonexistence. It only proves that,
for the exact repository head being evaluated, NQC has no registered/authorized
external provider, no declared permissionless debt facility and no supported
execution plan requiring the bounded requirement families.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path("ci/nqc-census")
PROVIDER_PATH = ROOT / "rmc011-external-capital-provider-registry.json"
PLAN_PATH = ROOT / "rmc011-execution-plan-requirement-catalog.json"

PROVIDER_VERIFIER = ROOT / "verify-rmc011-external-capital-provider-registry.py"
PLAN_VERIFIER = ROOT / "verify-rmc011-execution-plan-requirement-catalog.py"

EXTERNAL_ONLY = {
    "EXTERNAL_GAS_CREDIT",
    "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT",
}
PLAN_REQUIREMENTS = {
    "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
EXPECTED = EXTERNAL_ONLY | PLAN_REQUIREMENTS


class RejectionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RejectionError(message)


def load_verifier(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"cannot load verifier {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_documents(provider: dict, plan: dict) -> dict:
    provider_mod = load_verifier(PROVIDER_VERIFIER, "rmc011_provider_registry")
    plan_mod = load_verifier(PLAN_VERIFIER, "rmc011_plan_catalog")

    provider_result = provider_mod.validate_document(provider)
    plan_result = plan_mod.validate_document(plan)

    require(provider_result["provider_count"] == 0, "external provider registry is not empty")
    require(
        provider_result["status"] == "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE",
        "external provider registry empty status differs",
    )
    require(plan_result["plan_count"] == 0, "execution-plan requirement catalog is not empty")
    require(
        plan_result["status"] == "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE",
        "execution-plan catalog empty status differs",
    )
    provider_families = set(provider.get("provider_backed_families", []))
    require(EXPECTED <= provider_families, "provider registry family coverage is incomplete")

    plan_families = {
        row.get("family")
        for row in plan.get("requirement_families", [])
        if isinstance(row, dict)
    }
    require(
        PLAN_REQUIREMENTS == plan_families,
        "execution-plan catalog requirement family coverage differs",
    )

    rows = []
    for family in sorted(EXTERNAL_ONLY):
        rows.append({
            "family": family,
            "outcome": "EXHAUSTIVE_REJECTION",
            "scope": "NQC_EXECUTION_AUTHORIZED_EXTERNAL_PROVIDER_UNIVERSE_AT_THIS_HEAD",
            "basis": [
                "EXTERNAL_PROVIDER_REGISTRY_VALID",
                "EXTERNAL_PROVIDER_COUNT_EQ_0",
            ],
        })
    for family in sorted(PLAN_REQUIREMENTS):
        rows.append({
            "family": family,
            "outcome": "EXHAUSTIVE_REJECTION",
            "scope": "NQC_SUPPORTED_EXECUTION_PLAN_REQUIREMENT_UNIVERSE_AT_THIS_HEAD",
            "basis": [
                "EXTERNAL_PROVIDER_REGISTRY_VALID",
                "EXTERNAL_PROVIDER_COUNT_EQ_0",
                "EXECUTION_PLAN_REQUIREMENT_CATALOG_VALID",
                "SUPPORTED_PLAN_COUNT_EQ_0",
            ],
        })

    require({row["family"] for row in rows} == EXPECTED, "derived rejection family set differs")
    require(len(rows) == len(EXPECTED), "derived rejection family count differs")

    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "RMC011_BOUNDED_FAMILY_REJECTIONS_READY",
        "claim_scope": "NQC_EXECUTION_AUTHORIZED_EXTERNAL_AND_SUPPORTED_REQUIREMENT_UNIVERSE_AT_THIS_HEAD",
        "family_count": len(rows),
        "families": rows,
        "global_nonexistence_claimed": False,
        "source_availability_claimed": False,
        "d11_terminal_closed": False,
    }


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else None
    try:
        provider = json.loads(PROVIDER_PATH.read_text(encoding="utf-8"))
        plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
        result = validate_documents(provider, plan)
    except (OSError, json.JSONDecodeError, RejectionError, ValueError) as exc:
        print(f"RMC011_BOUNDED_FAMILY_REJECTIONS_INVALID {exc}", file=sys.stderr)
        return 1

    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(encoded, encoding="utf-8")

    print(
        "RMC011_BOUNDED_FAMILY_REJECTIONS_READY "
        f"families={result['family_count']} "
        "global_nonexistence_claimed=false "
        "d11_terminal_closed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

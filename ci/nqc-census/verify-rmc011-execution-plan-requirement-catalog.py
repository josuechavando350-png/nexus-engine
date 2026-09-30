#!/usr/bin/env python3
"""Validate the bounded RMC-011 execution-plan requirement catalog."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EXPECTED = {
    "INVENTORY_REQUIREMENT": ("INVENTORY", "INVENTORY_REQUIREMENT"),
    "BOND_OR_STAKE": ("BOND_OR_STAKE", "BOND_OR_STAKE"),
    "SOLVER_OR_BUILDER_DEPOSIT": (
        "BUILDER_OR_SOLVER_DEPOSIT",
        "SOLVER_OR_BUILDER_DEPOSIT",
    ),
    "INTRA_BLOCK_TEMPORARY_LOCK": (
        "TEMPORARY_LOCK",
        "INTRA_BLOCK_TEMPORARY_LOCK",
    ),
}
EXPECTED_NON_CLAIMS = {
    "EMPTY_CATALOG_IS_NOT_GLOBAL_REQUIREMENT_NONEXISTENCE",
    "EMPTY_CATALOG_IS_NOT_TERMINAL_REJECTION_BY_ITSELF",
    "D11_DOES_NOT_CERTIFY_EXECUTION_ACTIONABILITY",
    "D11_TERMINAL_NOT_CLOSED",
}
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class CatalogError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CatalogError(message)


def text(row: dict, key: str, label: str) -> str:
    value = row.get(key)
    require(
        isinstance(value, str) and value.strip(),
        f"{label}: {key} must be non-empty text",
    )
    return value


def validate_document(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_EXECUTION_PLAN_REQUIREMENT_CATALOG_V1",
        "unexpected catalog contract",
    )
    require(
        doc.get("catalog_scope") == "NQC_SUPPORTED_EXECUTION_PLANS_AT_THIS_HEAD",
        "unexpected catalog scope",
    )
    require(
        doc.get("completeness_basis")
        == "EVERY_EXECUTION_PLAN_ADMITTED_TO_NQC_CAPITAL_FEASIBILITY_MUST_BE_EXPLICITLY_REGISTERED_HERE_BEFORE_TERMINAL_D11",
        "unexpected completeness basis",
    )

    families = doc.get("requirement_families")
    require(isinstance(families, list), "requirement_families must be an array")
    require(len(families) == len(EXPECTED), "requirement family count differs")
    seen_families: set[str] = set()
    for row in families:
        require(isinstance(row, dict), "requirement family row must be an object")
        family = text(row, "family", "requirement family")
        require(family in EXPECTED, f"unknown requirement family: {family}")
        require(family not in seen_families, f"duplicate requirement family: {family}")
        seen_families.add(family)
        expected_kind, expected_class = EXPECTED[family]
        require(
            row.get("requirement_kind") == expected_kind,
            f"{family}: RequirementKind mapping differs",
        )
        require(
            row.get("required_allowed_class") == expected_class,
            f"{family}: CapitalClass mapping differs",
        )
    require(seen_families == set(EXPECTED), "requirement family set differs")

    plans = doc.get("plans")
    require(isinstance(plans, list), "plans must be an array")
    plan_count = doc.get("plan_count")
    require(
        isinstance(plan_count, int) and not isinstance(plan_count, bool) and plan_count >= 0,
        "plan_count must be a nonnegative integer",
    )
    require(plan_count == len(plans), "plan_count differs from plans length")
    expected_status = (
        "DECLARED_WITH_PLANS_NOT_TERMINAL_EVIDENCE"
        if plans
        else "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE"
    )
    require(doc.get("status") == expected_status, "catalog status differs from plan population")

    plan_ids: set[str] = set()
    plan_digests: set[str] = set()
    referenced_families: set[str] = set()
    for plan in plans:
        require(isinstance(plan, dict), "plan row must be an object")
        plan_id = text(plan, "plan_id", "plan")
        require(plan_id not in plan_ids, f"duplicate plan_id: {plan_id}")
        plan_ids.add(plan_id)

        digest = text(plan, "plan_sha256", plan_id)
        require(HEX64.fullmatch(digest) is not None, f"{plan_id}: plan_sha256 must be lowercase sha256")
        require(digest not in plan_digests, f"{plan_id}: duplicate plan_sha256")
        plan_digests.add(digest)

        require(
            plan.get("admission_status") in {"SUPPORTED", "REJECTED"},
            f"{plan_id}: admission_status must be SUPPORTED or REJECTED",
        )
        requirements = plan.get("requirements")
        require(
            isinstance(requirements, list) and requirements,
            f"{plan_id}: requirements must be a non-empty array",
        )

        seen_projection: set[tuple[str, str, str]] = set()
        for requirement in requirements:
            require(isinstance(requirement, dict), f"{plan_id}: requirement must be object")
            family = text(requirement, "family", plan_id)
            require(family in EXPECTED, f"{plan_id}: unknown requirement family {family}")
            expected_kind, expected_class = EXPECTED[family]
            require(
                requirement.get("requirement_kind") == expected_kind,
                f"{plan_id}/{family}: RequirementKind differs",
            )
            allowed = requirement.get("allowed_classes")
            require(
                isinstance(allowed, list) and allowed == [expected_class],
                f"{plan_id}/{family}: allowed_classes must be exactly [{expected_class}]",
            )
            asset_source = text(requirement, "asset_source", f"{plan_id}/{family}")
            amount_source = text(requirement, "amount_source", f"{plan_id}/{family}")
            projection = (family, asset_source, amount_source)
            require(
                projection not in seen_projection,
                f"{plan_id}: duplicate requirement projection {family}",
            )
            seen_projection.add(projection)
            referenced_families.add(family)

        evidence = plan.get("evidence")
        require(
            isinstance(evidence, list) and evidence,
            f"{plan_id}: evidence must be a non-empty array",
        )
        for item in evidence:
            require(isinstance(item, str) and item.strip(), f"{plan_id}: evidence item must be text")

    semantics = doc.get("terminal_semantics")
    require(isinstance(semantics, dict), "terminal_semantics must be an object")
    require(
        semantics.get("empty_catalog_means")
        == "NO_SUPPORTED_NQC_EXECUTION_PLAN_IN_THIS_HEAD_DECLARES_ONE_OF_THE_CATALOGED_REQUIREMENT_FAMILIES",
        "empty catalog meaning differs",
    )
    require(
        semantics.get("does_not_mean")
        == "THE_REQUIREMENT_FAMILY_CANNOT_EXIST_IN_FUTURE_OR_EXTERNAL_EXECUTION_PLANS",
        "empty catalog must not claim global nonexistence",
    )
    require(
        semantics.get("terminal_rejection_requires_authenticated_workflow_artifact") is True,
        "terminal rejection must require authenticated workflow evidence",
    )
    require(
        semantics.get("new_execution_plan_must_update_catalog_before_admission") is True,
        "new plan admission must require catalog update",
    )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "non_claims must be an array")
    require(len(non_claims) == len(set(non_claims)), "non_claims contains duplicates")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "catalog non-claim set differs")

    return {
        "status": expected_status,
        "plan_count": plan_count,
        "referenced_families": sorted(referenced_families),
        "terminal_evidence": False,
        "actionability_claimed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-execution-plan-requirement-catalog.json"
    )
    out = Path(argv[2]) if len(argv) > 2 else None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, CatalogError) as exc:
        print(f"RMC011_EXECUTION_PLAN_REQUIREMENT_CATALOG_INVALID {exc}", file=sys.stderr)
        return 1

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "stage": "RMC-011",
                    "status": "RMC011_EXECUTION_PLAN_REQUIREMENT_CATALOG_PASS",
                    **result,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        "RMC011_EXECUTION_PLAN_REQUIREMENT_CATALOG_PASS "
        f"status={result['status']} plans={result['plan_count']} "
        "terminal_evidence=false actionability_claimed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

#!/usr/bin/env python3
"""Fail-closed verifier for the RMC-011 permissionless debt facility catalog."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EXPECTED_FAMILIES = {
    "COLLATERALIZED_BORROWING": "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT": "PERSISTENT_DEBT",
}
EXPECTED_RISK_FIELDS = {
    "interest_model_hash",
    "liquidation_model_hash",
    "solvency_model_hash",
    "oracle_risk_hash",
    "liquidity_withdrawal_risk_hash",
    "facility_disappearance_risk_hash",
}
EXPECTED_NON_CLAIMS = {
    "EMPTY_CATALOG_IS_NOT_GLOBAL_FACILITY_NONEXISTENCE",
    "EMPTY_CATALOG_IS_NOT_TERMINAL_REJECTION_BY_ITSELF",
    "CATALOG_MEMBERSHIP_IS_NOT_LIVE_CAPACITY",
    "MODEL_SUPPORT_IS_NOT_FACILITY_AVAILABILITY",
    "D11_TERMINAL_NOT_CLOSED",
}
ADDRESS_RE = re.compile(r"^0x[0-9a-f]{40}$")
HASH32_RE = re.compile(r"^0x[0-9a-f]{64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


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


def validate_asset(value: object, label: str) -> str:
    require(isinstance(value, str), f"{label}: asset must be text")
    if value == "NATIVE_GAS":
        return value
    require(value.startswith("TOKEN:"), f"{label}: asset must be NATIVE_GAS or TOKEN:<address>")
    address = value.removeprefix("TOKEN:")
    require(ADDRESS_RE.fullmatch(address) is not None, f"{label}: invalid token address")
    return value


def validate_document(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_PERMISSIONLESS_DEBT_FACILITY_CATALOG_V1",
        "unexpected catalog contract",
    )
    require(
        doc.get("catalog_scope")
        == "NQC_DECLARED_PERMISSIONLESS_COLLATERALIZED_AND_PERSISTENT_DEBT_FACILITIES",
        "unexpected catalog scope",
    )
    require(
        doc.get("completeness_basis")
        == "EVERY_PERMISSIONLESS_DEBT_FACILITY_ALLOWED_FOR_NQC_CAPITAL_FEASIBILITY_MUST_BE_EXPLICITLY_REGISTERED_BEFORE_D11_TERMINAL",
        "unexpected completeness basis",
    )

    families = doc.get("families")
    require(isinstance(families, list), "families must be an array")
    require(len(families) == len(EXPECTED_FAMILIES), "family count differs")
    seen_families: set[str] = set()
    for row in families:
        require(isinstance(row, dict), "family row must be an object")
        family = text(row, "family", "family")
        require(family in EXPECTED_FAMILIES, f"unknown family: {family}")
        require(family not in seen_families, f"duplicate family: {family}")
        seen_families.add(family)
        require(
            row.get("required_capital_class") == EXPECTED_FAMILIES[family],
            f"{family}: required_capital_class differs",
        )
        risk_fields = row.get("required_risk_fields")
        require(isinstance(risk_fields, list), f"{family}: required_risk_fields must be an array")
        require(len(risk_fields) == len(set(risk_fields)), f"{family}: duplicate risk field")
        require(set(risk_fields) == EXPECTED_RISK_FIELDS, f"{family}: risk field set differs")
    require(seen_families == set(EXPECTED_FAMILIES), "family set differs")

    facilities = doc.get("facilities")
    require(isinstance(facilities, list), "facilities must be an array")
    facility_count = doc.get("facility_count")
    require(
        isinstance(facility_count, int)
        and not isinstance(facility_count, bool)
        and facility_count >= 0,
        "facility_count must be a nonnegative integer",
    )
    require(facility_count == len(facilities), "facility_count differs from facilities length")
    expected_status = (
        "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        if facilities
        else "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE"
    )
    require(doc.get("status") == expected_status, "catalog status differs from facility population")

    identities: set[tuple[int, str, str]] = set()
    declarations: set[str] = set()
    family_counts = {family: 0 for family in EXPECTED_FAMILIES}
    for row in facilities:
        require(isinstance(row, dict), "facility row must be an object")
        family = text(row, "family", "facility")
        require(family in EXPECTED_FAMILIES, f"facility has unknown family: {family}")
        family_counts[family] += 1

        chain_id = row.get("chain_id")
        require(
            isinstance(chain_id, int) and not isinstance(chain_id, bool) and chain_id > 0,
            f"{family}: chain_id must be a positive integer",
        )
        address = text(row, "facility_address", family)
        require(ADDRESS_RE.fullmatch(address) is not None, f"{family}: invalid facility address")
        principal_asset = validate_asset(row.get("principal_asset"), f"{family}/principal")
        collateral_asset = validate_asset(row.get("collateral_asset"), f"{family}/collateral")
        require(principal_asset != collateral_asset, f"{family}: principal and collateral assets must differ")

        identity = (chain_id, address, family)
        require(identity not in identities, f"duplicate facility identity: {identity}")
        identities.add(identity)

        runtime_hash = text(row, "runtime_code_hash", family)
        require(HASH32_RE.fullmatch(runtime_hash) is not None, f"{family}: invalid runtime_code_hash")

        provenance = row.get("deployment_provenance")
        require(isinstance(provenance, dict), f"{family}: deployment_provenance must be an object")
        provenance_kind = text(provenance, "kind", f"{family}/provenance")
        require(
            provenance_kind in {"ONCHAIN_FACTORY_EVENT", "OFFICIAL_UPSTREAM_DEPLOYMENT", "GOVERNANCE_DEPLOYMENT"},
            f"{family}: unsupported deployment provenance kind",
        )
        text(provenance, "source", f"{family}/provenance")
        provenance_sha = text(provenance, "sha256", f"{family}/provenance")
        require(SHA256_RE.fullmatch(provenance_sha) is not None, f"{family}: invalid provenance sha256")

        for key in EXPECTED_RISK_FIELDS:
            value = text(row, key, family)
            require(HASH32_RE.fullmatch(value) is not None, f"{family}: invalid {key}")

        declaration_sha = text(row, "declaration_sha256", family)
        require(SHA256_RE.fullmatch(declaration_sha) is not None, f"{family}: invalid declaration_sha256")
        require(declaration_sha not in declarations, f"duplicate declaration_sha256: {declaration_sha}")
        declarations.add(declaration_sha)

        require(
            row.get("admission_status") in {"DECLARED_NOT_AUTHENTICATED", "REJECTED_NOT_TERMINAL"},
            f"{family}: unsupported admission_status",
        )

    semantics = doc.get("terminal_semantics")
    require(isinstance(semantics, dict), "terminal_semantics must be an object")
    require(
        semantics.get("empty_catalog_means")
        == "NO_PERMISSIONLESS_DEBT_FACILITY_IS_DECLARED_OR_AUTHORIZED_FOR_NQC_EXECUTION_IN_THIS_HEAD",
        "empty catalog meaning differs",
    )
    require(
        semantics.get("does_not_mean")
        == "NO_PERMISSIONLESS_COLLATERALIZED_OR_PERSISTENT_DEBT_FACILITY_EXISTS_EXTERNALLY",
        "empty catalog must not claim global nonexistence",
    )
    require(
        semantics.get("terminal_rejection_requires_authenticated_workflow_artifact") is True,
        "terminal rejection must require authenticated workflow evidence",
    )
    require(
        semantics.get("terminal_availability_requires_block_pinned_dual_provider_evidence") is True,
        "terminal availability must require block-pinned dual-provider evidence",
    )
    require(
        semantics.get("new_permissionless_facility_must_update_catalog_before_admission") is True,
        "new facility admission must require catalog update",
    )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "non_claims must be an array")
    require(len(non_claims) == len(set(non_claims)), "non_claims contains duplicates")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "catalog non-claim set differs")

    return {
        "status": expected_status,
        "facility_count": facility_count,
        "families": family_counts,
        "terminal_evidence": False,
        "availability_claimed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json"
    )
    out = Path(argv[2]) if len(argv) > 2 else None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, CatalogError) as exc:
        print(f"RMC011_PERMISSIONLESS_DEBT_FACILITY_CATALOG_INVALID {exc}", file=sys.stderr)
        return 1

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "stage": "RMC-011",
                    "status": "RMC011_PERMISSIONLESS_DEBT_FACILITY_CATALOG_PASS",
                    **result,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        "RMC011_PERMISSIONLESS_DEBT_FACILITY_CATALOG_PASS "
        f"status={result['status']} facilities={result['facility_count']} "
        "terminal_evidence=false availability_claimed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

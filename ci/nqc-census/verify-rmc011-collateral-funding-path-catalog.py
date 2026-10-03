#!/usr/bin/env python3
"""Fail-closed verifier for the RMC-011 zero-own-capital collateral path catalog."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EXPECTED_FAMILIES = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
EXPECTED_NON_CLAIMS = {
    "EMPTY_CATALOG_IS_NOT_GLOBAL_COLLATERAL_NONEXISTENCE",
    "MODEL_SUPPORT_IS_NOT_COLLATERAL_AVAILABILITY",
    "AAVE_RESERVE_LIQUIDITY_IS_NOT_NQC_BORROWING_CAPACITY",
    "STRATEGY_OUTPUT_IS_NOT_PRE_EXECUTION_COLLATERAL_AUTHORITY",
    "D11_TERMINAL_NOT_CLOSED",
}
ASSET_RE = re.compile(r"^TOKEN:0x[0-9a-f]{40}$")
HASH_RE = re.compile(r"^(?:0x)?[0-9a-f]{64}$")
AMOUNT_RE = re.compile(r"^0x[0-9a-f]{64}$")
ALLOWED_PERSISTENCE = {"PERSISTENT_UNTIL_DEBT_CLOSED", "DEADLINE_BLOCKS"}


class CatalogError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CatalogError(message)


def text(row: dict, key: str, label: str) -> str:
    value = row.get(key)
    require(isinstance(value, str) and value.strip(), f"{label}: {key} must be non-empty text")
    return value


def validate_document(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_COLLATERAL_FUNDING_PATH_CATALOG_V1",
        "unexpected collateral-path contract",
    )
    require(
        doc.get("catalog_scope") == "NQC_AUTHORIZED_ZERO_OWN_CAPITAL_COLLATERAL_PATHS",
        "unexpected collateral-path scope",
    )
    require(
        doc.get("completeness_basis")
        == "AAVE_DEBT_AND_OTHER_COLLATERALIZED_CAPITAL_MAY_USE_ONLY_EXPLICITLY_REGISTERED_NON_OPERATOR_COLLATERAL_PATHS",
        "unexpected collateral-path completeness basis",
    )

    families = doc.get("supported_families")
    require(isinstance(families, list), "supported_families must be an array")
    require(len(families) == len(set(families)), "supported_families contains duplicates")
    require(set(families) == EXPECTED_FAMILIES, "supported family set differs")

    paths = doc.get("paths")
    require(isinstance(paths, list), "paths must be an array")
    count = doc.get("path_count")
    require(isinstance(count, int) and not isinstance(count, bool) and count >= 0, "path_count invalid")
    require(count == len(paths), "path_count differs from paths length")
    expected_status = (
        "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        if paths
        else "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE"
    )
    require(doc.get("status") == expected_status, "catalog status differs from path population")

    ids: set[str] = set()
    commitments: set[str] = set()
    for row in paths:
        require(isinstance(row, dict), "collateral path row must be an object")
        path_id = text(row, "path_id", "collateral path")
        require(path_id not in ids, f"duplicate collateral path_id: {path_id}")
        ids.add(path_id)

        row_families = row.get("families")
        require(isinstance(row_families, list) and row_families, f"{path_id}: families must be non-empty")
        require(len(row_families) == len(set(row_families)), f"{path_id}: duplicate family")
        require(set(row_families) <= EXPECTED_FAMILIES, f"{path_id}: unsupported family")

        asset = text(row, "collateral_asset", path_id)
        require(ASSET_RE.fullmatch(asset) is not None, f"{path_id}: collateral_asset invalid")
        amount = text(row, "maximum_collateral", path_id)
        require(AMOUNT_RE.fullmatch(amount) is not None, f"{path_id}: maximum_collateral invalid")
        require(int(amount[2:], 16) > 0, f"{path_id}: maximum_collateral must be positive")

        require(row.get("operator_owned") is False, f"{path_id}: operator-owned collateral is forbidden")
        require(
            row.get("requires_strategy_output") is False,
            f"{path_id}: strategy-output-dependent collateral is not source-side funding",
        )
        persistence = text(row, "persistence_semantics", path_id)
        require(persistence in ALLOWED_PERSISTENCE, f"{path_id}: persistence semantics cannot support debt")
        if persistence == "DEADLINE_BLOCKS":
            blocks = row.get("deadline_blocks")
            require(
                isinstance(blocks, int) and not isinstance(blocks, bool) and blocks > 0,
                f"{path_id}: deadline_blocks must be positive",
            )
        else:
            require(row.get("deadline_blocks") is None, f"{path_id}: persistent path cannot declare deadline_blocks")

        provider_id = text(row, "provider_registry_id", path_id)
        require(provider_id != "OPERATOR_TREASURY", f"{path_id}: operator treasury cannot fund collateral")
        commitment = text(row, "terms_commitment", path_id)
        require(HASH_RE.fullmatch(commitment) is not None, f"{path_id}: terms_commitment invalid")
        require(commitment not in commitments, f"{path_id}: duplicate terms_commitment")
        commitments.add(commitment)

        evidence = row.get("evidence")
        require(isinstance(evidence, list) and len(evidence) >= 2, f"{path_id}: two evidence views required")
        require(all(isinstance(item, str) and item.strip() for item in evidence), f"{path_id}: evidence item invalid")
        require(len(evidence) == len(set(evidence)), f"{path_id}: duplicate evidence view")

    semantics = doc.get("terminal_semantics")
    require(isinstance(semantics, dict), "terminal_semantics must be an object")
    require(
        semantics.get("empty_catalog_means")
        == "NO_ZERO_OWN_CAPITAL_COLLATERAL_PATH_IS_AUTHORIZED_FOR_NQC_EXECUTION_IN_THIS_HEAD",
        "empty catalog meaning differs",
    )
    require(
        semantics.get("does_not_mean")
        == "NO_COLLATERAL_LIQUIDITY_OR_CREDIT_PATH_EXISTS_OUTSIDE_NQC",
        "empty catalog cannot claim global collateral nonexistence",
    )
    require(semantics.get("operator_owned_collateral_forbidden") is True, "operator collateral must remain forbidden")
    require(
        semantics.get("strategy_output_dependent_collateral_forbidden") is True,
        "strategy output cannot be collateral authority",
    )
    require(
        semantics.get("terminal_rejection_requires_authenticated_workflow_artifact") is True,
        "terminal rejection must require authenticated workflow evidence",
    )
    require(
        semantics.get("live_path_requires_authenticated_terms_and_availability") is True,
        "live path must require authenticated terms and availability",
    )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "non_claims must be an array")
    require(len(non_claims) == len(set(non_claims)), "non_claims contains duplicates")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "non-claim set differs")

    return {
        "status": expected_status,
        "path_count": count,
        "zero_own_capital_paths_available": count > 0,
        "terminal_evidence": False,
        "global_nonexistence_claimed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-collateral-funding-path-catalog.json"
    )
    out = Path(argv[2]) if len(argv) > 2 else None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, CatalogError) as exc:
        print(f"RMC011_COLLATERAL_FUNDING_PATH_CATALOG_INVALID {exc}", file=sys.stderr)
        return 1

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "stage": "RMC-011",
                    "status": "RMC011_COLLATERAL_FUNDING_PATH_CATALOG_PASS",
                    **result,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
    print(
        "RMC011_COLLATERAL_FUNDING_PATH_CATALOG_PASS "
        f"status={result['status']} paths={result['path_count']} "
        "terminal_evidence=false global_nonexistence_claimed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

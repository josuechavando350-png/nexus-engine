#!/usr/bin/env python3
"""Validate the bounded NQC external-capital provider registry.

The registry is an execution authorization boundary, not a claim about every
provider that may exist in the world. An empty registry proves only that no
external provider is configured/authorized for this exact NQC head. Terminal
family rejection still requires an authenticated workflow artifact.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

EXPECTED_FAMILIES = {
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
    "EMPTY_REGISTRY_IS_NOT_GLOBAL_PROVIDER_NONEXISTENCE",
    "EMPTY_REGISTRY_IS_NOT_TERMINAL_REJECTION_BY_ITSELF",
    "MODEL_SUPPORT_IS_NOT_PROVIDER_AVAILABILITY",
    "NO_EXTERNAL_GAS_SOURCE_IS_CLAIMED_AVAILABLE",
    "D11_TERMINAL_NOT_CLOSED",
}

ALLOWED_AUTHORITY_MODES = {
    "SIGNED_PROVIDER_TRANSCRIPT",
    "CONTENT_ADDRESSED_PROVIDER_TRANSCRIPT",
    "SIGNED_AND_CONTENT_ADDRESSED_PROVIDER_TRANSCRIPT",
}


class RegistryError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RegistryError(message)


def nonempty_text(row: dict, key: str, label: str) -> str:
    value = row.get(key)
    require(isinstance(value, str) and value.strip(), f"{label}: {key} must be non-empty text")
    return value


def validate_document(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "stage must equal RMC-011")
    require(
        doc.get("contract") == "NQC_RMC011_EXTERNAL_CAPITAL_PROVIDER_REGISTRY_V1",
        "unexpected registry contract",
    )
    require(
        doc.get("registry_scope") == "NQC_EXECUTION_AUTHORIZED_EXTERNAL_CAPITAL_PROVIDERS",
        "unexpected registry scope",
    )
    require(
        doc.get("completeness_basis")
        == "NQC_EXECUTION_MAY_USE_ONLY_EXPLICITLY_REGISTERED_AND_AUTHORIZED_EXTERNAL_PROVIDERS",
        "unexpected registry completeness basis",
    )

    families = doc.get("provider_backed_families")
    require(isinstance(families, list), "provider_backed_families must be an array")
    require(len(families) == len(set(families)), "provider_backed_families contains duplicates")
    require(set(families) == EXPECTED_FAMILIES, "provider-backed family set differs")

    providers = doc.get("providers")
    require(isinstance(providers, list), "providers must be an array")
    provider_count = doc.get("provider_count")
    require(
        isinstance(provider_count, int) and not isinstance(provider_count, bool) and provider_count >= 0,
        "provider_count must be a nonnegative integer",
    )
    require(provider_count == len(providers), "provider_count differs from providers length")

    status = doc.get("status")
    if providers:
        require(status == "DECLARED_WITH_PROVIDERS_NOT_TERMINAL_EVIDENCE", "nonempty registry status differs")
    else:
        require(status == "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE", "empty registry status differs")

    seen_ids: set[str] = set()
    for row in providers:
        require(isinstance(row, dict), "provider row must be an object")
        provider_id = nonempty_text(row, "provider_id", "provider")
        require(provider_id not in seen_ids, f"duplicate provider_id: {provider_id}")
        seen_ids.add(provider_id)

        row_families = row.get("families")
        require(isinstance(row_families, list) and row_families, f"{provider_id}: families required")
        require(len(row_families) == len(set(row_families)), f"{provider_id}: duplicate family")
        require(set(row_families) <= EXPECTED_FAMILIES, f"{provider_id}: unknown family")

        authority_mode = nonempty_text(row, "authority_mode", provider_id)
        require(authority_mode in ALLOWED_AUTHORITY_MODES, f"{provider_id}: unsupported authority_mode")
        nonempty_text(row, "terms_locator", provider_id)
        nonempty_text(row, "provider_identity_commitment", provider_id)

        requirements = row.get("evidence_requirements")
        require(isinstance(requirements, dict), f"{provider_id}: evidence_requirements required")
        require(
            requirements.get("independent_provider_views") == 2,
            f"{provider_id}: exactly two independent provider views required",
        )
        require(
            requirements.get("terms_valid_at_observation") is True,
            f"{provider_id}: terms must be valid at observation",
        )
        require(
            requirements.get("availability_observed") is True,
            f"{provider_id}: availability observation required",
        )

        forbidden = {"secret", "password", "token", "api_key", "private_key"}
        require(
            not (forbidden & set(row)),
            f"{provider_id}: registry must not contain credentials or secrets",
        )

    semantics = doc.get("terminal_semantics")
    require(isinstance(semantics, dict), "terminal_semantics must be an object")
    require(
        semantics.get("empty_registry_means")
        == "NO_EXTERNAL_PROVIDER_IS_AUTHORIZED_OR_CONFIGURED_FOR_NQC_EXECUTION_IN_THIS_HEAD",
        "empty-registry meaning differs",
    )
    require(
        semantics.get("does_not_mean") == "NO_SUCH_PROVIDER_EXISTS_OUTSIDE_NQC",
        "empty registry must not claim global nonexistence",
    )
    require(
        semantics.get("terminal_rejection_requires_authenticated_workflow_artifact") is True,
        "terminal rejection must require authenticated workflow evidence",
    )
    require(
        semantics.get("terminal_availability_requires_authenticated_provider_evidence") is True,
        "terminal availability must require authenticated provider evidence",
    )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "non_claims must be an array")
    require(len(non_claims) == len(set(non_claims)), "non_claims contains duplicates")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "registry non-claim set differs")

    return {
        "status": status,
        "provider_count": provider_count,
        "provider_ids": sorted(seen_ids),
        "families": sorted(EXPECTED_FAMILIES),
        "terminal_evidence": False,
        "global_nonexistence_claimed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-external-capital-provider-registry.json"
    )
    out = Path(argv[2]) if len(argv) > 2 else None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, RegistryError) as exc:
        print(f"RMC011_EXTERNAL_PROVIDER_REGISTRY_INVALID {exc}", file=sys.stderr)
        return 1

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "stage": "RMC-011",
                    "status": "RMC011_EXTERNAL_PROVIDER_REGISTRY_PASS",
                    **result,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        "RMC011_EXTERNAL_PROVIDER_REGISTRY_PASS "
        f"status={result['status']} providers={result['provider_count']} "
        "terminal_evidence=false global_nonexistence_claimed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

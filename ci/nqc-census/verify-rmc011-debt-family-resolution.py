#!/usr/bin/env python3
"""Resolve the RMC-011 debt families under the OWN_CAPITAL=0 source boundary.

This verifier does not claim that Aave or external debt facilities do not exist.
It may derive an exhaustive rejection only for the capital universe NQC can
actually execute at this exact head when:
- exact D08-backed Aave debt discovery is complete but emits zero NQC sources;
- no authorized external debt provider is registered;
- no additional permissionless debt facility is declared; and
- no non-operator collateral funding path is authorized.

Any non-empty source/path surface blocks rejection and requires exact downstream
portfolio/oracle/eMode resolution instead.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path("ci/nqc-census")
PROVIDER_PATH = ROOT / "rmc011-external-capital-provider-registry.json"
PERMISSIONLESS_PATH = ROOT / "rmc011-permissionless-debt-facility-catalog.json"
COLLATERAL_PATH = ROOT / "rmc011-collateral-funding-path-catalog.json"

PROVIDER_VERIFIER = ROOT / "verify-rmc011-external-capital-provider-registry.py"
PERMISSIONLESS_VERIFIER = ROOT / "verify-rmc011-permissionless-debt-facility-catalog.py"
COLLATERAL_VERIFIER = ROOT / "verify-rmc011-collateral-funding-path-catalog.py"

DEBT_FAMILIES = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
EXPECTED_NON_CLAIMS = {
    "AAVE_RESERVE_LIQUIDITY_IS_NOT_NQC_BORROWING_CAPACITY",
    "PORTFOLIO_COLLATERAL_FEASIBILITY_NOT_CERTIFIED",
    "ORACLE_BORROWING_FEASIBILITY_NOT_CERTIFIED",
    "EMODE_BORROWING_FEASIBILITY_NOT_CERTIFIED",
    "ZERO_OWN_CAPITAL_COLLATERAL_PATH_NOT_CERTIFIED",
    "TERMINAL_D11_NOT_CERTIFIED",
}


class ResolutionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ResolutionError(message)


def load_verifier(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"cannot load verifier {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def surface_commitment(
    aave_result: dict,
    provider: dict,
    permissionless: dict,
    collateral: dict,
) -> dict:
    surfaces = {
        "external_provider_registry_sha256": sha256_bytes(canonical_bytes(provider)),
        "permissionless_debt_catalog_sha256": sha256_bytes(canonical_bytes(permissionless)),
        "collateral_funding_path_catalog_sha256": sha256_bytes(canonical_bytes(collateral)),
        "d08_authority_artifact_sha256": aave_result["d08_authority_artifact_sha256"],
        "aave_coverage_commitment": aave_result["coverage_commitment"],
    }
    commitment = sha256_bytes(canonical_bytes(surfaces))
    return {"surfaces": surfaces, "commitment": commitment}


def nonnegative_int(value: object, label: str) -> int:
    require(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0,
        f"{label} must be a nonnegative integer",
    )
    return value


def validate_aave_discovery(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "Aave debt discovery schema must equal 1")
    require(doc.get("stage") == "RMC-011", "Aave debt discovery stage differs")
    require(
        doc.get("status") == "RMC011_AAVE_DEBT_DISCOVERY_PASS",
        "Aave debt discovery is not PASS",
    )
    require(
        doc.get("claim_scope") == "PROTOCOL_SIDE_DEBT_FACILITY_DISCOVERY_ONLY",
        "Aave debt discovery claim scope differs",
    )
    candidate_count = nonnegative_int(doc.get("candidate_count"), "candidate_count")
    facility_count = nonnegative_int(doc.get("facility_count"), "facility_count")
    rejected_count = nonnegative_int(doc.get("rejected_count"), "rejected_count")
    require(
        candidate_count == facility_count + rejected_count,
        "Aave debt discovery count conservation failed",
    )
    require(doc.get("capital_source_count") == 0, "Aave discovery fabricated NQC capital sources")
    require(
        doc.get("nqc_borrowing_capacity_claimed") is False,
        "Aave discovery claims NQC borrowing capacity",
    )
    require(
        doc.get("zero_own_capital_collateral_path_claimed") is False,
        "Aave discovery claims a zero-own-capital collateral path",
    )

    facilities = doc.get("facilities")
    rejections = doc.get("rejections")
    require(isinstance(facilities, list), "Aave facilities must be an array")
    require(isinstance(rejections, list), "Aave rejections must be an array")
    require(len(facilities) == facility_count, "Aave facility count differs")
    require(len(rejections) == rejected_count, "Aave rejection count differs")

    for row in facilities:
        require(isinstance(row, dict), "Aave facility row must be an object")
        require(
            row.get("portfolio_collateral_resolution_required") is True,
            "Aave facility lost portfolio collateral blocker",
        )
        require(
            row.get("oracle_resolution_required") is True,
            "Aave facility lost oracle blocker",
        )
        require(
            row.get("emode_resolution_required") is True,
            "Aave facility lost eMode blocker",
        )

    non_claims = doc.get("non_claims")
    require(isinstance(non_claims, list), "Aave discovery non_claims must be an array")
    require(set(non_claims) == EXPECTED_NON_CLAIMS, "Aave debt non-claim set differs")

    authority = doc.get("d08_authority_artifact_sha256")
    require(isinstance(authority, str) and authority.strip(), "D08 authority digest missing")
    coverage = doc.get("coverage_commitment")
    require(isinstance(coverage, str) and coverage.strip(), "Aave debt coverage commitment missing")

    return {
        "candidate_count": candidate_count,
        "facility_count": facility_count,
        "rejected_count": rejected_count,
        "d08_authority_artifact_sha256": authority,
        "coverage_commitment": coverage,
    }


def validate_documents(
    aave: dict,
    provider: dict,
    permissionless: dict,
    collateral: dict,
) -> dict:
    aave_result = validate_aave_discovery(aave)

    provider_mod = load_verifier(PROVIDER_VERIFIER, "rmc011_provider_registry")
    permissionless_mod = load_verifier(
        PERMISSIONLESS_VERIFIER, "rmc011_permissionless_debt_catalog"
    )
    collateral_mod = load_verifier(COLLATERAL_VERIFIER, "rmc011_collateral_path_catalog")

    provider_result = provider_mod.validate_document(provider)
    permissionless_result = permissionless_mod.validate_document(permissionless)
    collateral_result = collateral_mod.validate_document(collateral)

    provider_count = provider_result["provider_count"]
    facility_count = permissionless_result["facility_count"]
    collateral_path_count = collateral_result["path_count"]
    boundary = surface_commitment(
        aave_result,
        provider,
        permissionless,
        collateral,
    )

    blocked_reasons = []
    if provider_count != 0:
        blocked_reasons.append("AUTHORIZED_EXTERNAL_PROVIDER_PRESENT")
    if facility_count != 0:
        blocked_reasons.append("DECLARED_PERMISSIONLESS_DEBT_FACILITY_PRESENT")
    if collateral_path_count != 0:
        blocked_reasons.append("ZERO_OWN_CAPITAL_COLLATERAL_PATH_PRESENT")

    if blocked_reasons:
        return {
            "schema_version": 1,
            "stage": "RMC-011",
            "status": "RMC011_DEBT_FAMILY_RESOLUTION_BLOCKED",
            "claim_scope": "NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD",
            "family_count": 2,
            "families": sorted(DEBT_FAMILIES),
            "blocked_reasons": blocked_reasons,
            "aave_candidate_count": aave_result["candidate_count"],
            "aave_facility_count": aave_result["facility_count"],
            "aave_rejected_count": aave_result["rejected_count"],
            "d08_authority_artifact_sha256": aave_result["d08_authority_artifact_sha256"],
            "aave_coverage_commitment": aave_result["coverage_commitment"],
            "source_boundary": boundary["surfaces"],
            "source_boundary_commitment": boundary["commitment"],
            "global_nonexistence_claimed": False,
            "nqc_borrowing_capacity_claimed": False,
            "terminal_d11_closed": False,
        }

    rows = [
        {
            "family": family,
            "outcome": "EXHAUSTIVE_REJECTION",
            "scope": "NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD",
            "basis": [
                "D08_AUTHENTICATED_AAVE_DEBT_DISCOVERY_COMPLETE",
                "AAVE_PROTOCOL_LIQUIDITY_NOT_NQC_CAPITAL_SOURCE",
                "AAVE_NQC_CAPITAL_SOURCE_COUNT_EQ_0",
                "AUTHORIZED_EXTERNAL_PROVIDER_COUNT_EQ_0",
                "DECLARED_PERMISSIONLESS_DEBT_FACILITY_COUNT_EQ_0",
                "ZERO_OWN_CAPITAL_COLLATERAL_PATH_COUNT_EQ_0",
            ],
        }
        for family in sorted(DEBT_FAMILIES)
    ]
    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "RMC011_DEBT_FAMILY_EXHAUSTIVE_REJECTION_READY",
        "claim_scope": "NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD",
        "family_count": len(rows),
        "families": rows,
        "blocked_reasons": [],
        "aave_candidate_count": aave_result["candidate_count"],
        "aave_facility_count": aave_result["facility_count"],
        "aave_rejected_count": aave_result["rejected_count"],
        "d08_authority_artifact_sha256": aave_result["d08_authority_artifact_sha256"],
        "aave_coverage_commitment": aave_result["coverage_commitment"],
        "source_boundary": boundary["surfaces"],
        "source_boundary_commitment": boundary["commitment"],
        "external_provider_count": provider_count,
        "permissionless_debt_facility_count": facility_count,
        "zero_own_capital_collateral_path_count": collateral_path_count,
        "global_nonexistence_claimed": False,
        "nqc_borrowing_capacity_claimed": False,
        "terminal_d11_closed": False,
    }


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 3}:
        print(
            "usage: verify-rmc011-debt-family-resolution.py <aave-discovery.json> [out.json]",
            file=sys.stderr,
        )
        return 2
    aave_path = Path(argv[1])
    out = Path(argv[2]) if len(argv) == 3 else None
    try:
        aave = json.loads(aave_path.read_text(encoding="utf-8"))
        provider = json.loads(PROVIDER_PATH.read_text(encoding="utf-8"))
        permissionless = json.loads(PERMISSIONLESS_PATH.read_text(encoding="utf-8"))
        collateral = json.loads(COLLATERAL_PATH.read_text(encoding="utf-8"))
        result = validate_documents(aave, provider, permissionless, collateral)
    except (OSError, json.JSONDecodeError, ResolutionError, ValueError) as exc:
        print(f"RMC011_DEBT_FAMILY_RESOLUTION_INVALID {exc}", file=sys.stderr)
        return 1

    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(encoded, encoding="utf-8")

    print(
        "RMC011_DEBT_FAMILY_RESOLUTION "
        f"status={result['status']} families={result['family_count']} "
        f"aave_facilities={result['aave_facility_count']} "
        "global_nonexistence_claimed=false nqc_borrowing_capacity_claimed=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

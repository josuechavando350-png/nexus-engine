from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-debt-family-resolution.py")
SPEC = importlib.util.spec_from_file_location("rmc011_debt_resolution", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

PROVIDER = json.loads(
    Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_text()
)
PERMISSIONLESS = json.loads(
    Path("ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json").read_text()
)
COLLATERAL = json.loads(
    Path("ci/nqc-census/rmc011-collateral-funding-path-catalog.json").read_text()
)


def aave_report() -> dict:
    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "RMC011_AAVE_DEBT_DISCOVERY_PASS",
        "claim_scope": "PROTOCOL_SIDE_DEBT_FACILITY_DISCOVERY_ONLY",
        "candidate_count": 1,
        "facility_count": 1,
        "rejected_count": 0,
        "capital_source_count": 0,
        "nqc_borrowing_capacity_claimed": False,
        "zero_own_capital_collateral_path_claimed": False,
        "d08_authority_artifact_sha256": "0x" + "11" * 32,
        "coverage_commitment": "0x" + "22" * 32,
        "facilities": [{
            "portfolio_collateral_resolution_required": True,
            "oracle_resolution_required": True,
            "emode_resolution_required": True,
        }],
        "rejections": [],
        "non_claims": sorted(mod.EXPECTED_NON_CLAIMS),
    }


def collateral_path() -> dict:
    return {
        "path_id": "external-collateral-a",
        "families": ["COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"],
        "collateral_asset": "TOKEN:0x" + "11" * 20,
        "maximum_collateral": "0x" + "00" * 31 + "01",
        "operator_owned": False,
        "requires_strategy_output": False,
        "persistence_semantics": "PERSISTENT_UNTIL_DEBT_CLOSED",
        "deadline_blocks": None,
        "provider_registry_id": "provider-a",
        "terms_commitment": "22" * 32,
        "evidence": ["provider-view-a", "provider-view-b"],
    }


class DebtFamilyResolutionTests(unittest.TestCase):
    def test_empty_authorized_surfaces_yield_two_bounded_debt_rejections(self) -> None:
        result = mod.validate_documents(
            aave_report(),
            copy.deepcopy(PROVIDER),
            copy.deepcopy(PERMISSIONLESS),
            copy.deepcopy(COLLATERAL),
        )
        self.assertEqual(
            result["status"],
            "RMC011_DEBT_FAMILY_EXHAUSTIVE_REJECTION_READY",
        )
        self.assertEqual(result["family_count"], 2)
        self.assertEqual(
            {row["family"] for row in result["families"]},
            mod.DEBT_FAMILIES,
        )
        self.assertFalse(result["global_nonexistence_claimed"])
        self.assertFalse(result["nqc_borrowing_capacity_claimed"])
        self.assertRegex(result["source_boundary_commitment"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            set(result["source_boundary"]),
            {
                "external_provider_registry_sha256",
                "permissionless_debt_catalog_sha256",
                "collateral_funding_path_catalog_sha256",
                "d08_authority_artifact_sha256",
                "aave_coverage_commitment",
            },
        )
        for value in (
            result["source_boundary"]["external_provider_registry_sha256"],
            result["source_boundary"]["permissionless_debt_catalog_sha256"],
            result["source_boundary"]["collateral_funding_path_catalog_sha256"],
        ):
            self.assertRegex(value, r"^[0-9a-f]{64}$")

    def test_source_boundary_commitment_detects_catalog_substitution(self) -> None:
        aave = mod.validate_aave_discovery(aave_report())
        provider = copy.deepcopy(PROVIDER)
        permissionless = copy.deepcopy(PERMISSIONLESS)
        collateral = copy.deepcopy(COLLATERAL)
        first = mod.surface_commitment(aave, provider, permissionless, collateral)
        permissionless["catalog_scope"] += "_SUBSTITUTED"
        second = mod.surface_commitment(aave, provider, permissionless, collateral)
        self.assertNotEqual(first["commitment"], second["commitment"])
        self.assertNotEqual(
            first["surfaces"]["permissionless_debt_catalog_sha256"],
            second["surfaces"]["permissionless_debt_catalog_sha256"],
        )

    def test_aave_liquidity_cannot_be_relabelled_nqc_capacity(self) -> None:
        aave = aave_report()
        aave["capital_source_count"] = 1
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(
                aave,
                copy.deepcopy(PROVIDER),
                copy.deepcopy(PERMISSIONLESS),
                copy.deepcopy(COLLATERAL),
            )

    def test_aave_discovery_must_keep_portfolio_oracle_emode_blockers(self) -> None:
        for key in (
            "portfolio_collateral_resolution_required",
            "oracle_resolution_required",
            "emode_resolution_required",
        ):
            aave = aave_report()
            aave["facilities"][0][key] = False
            with self.assertRaises(mod.ResolutionError):
                mod.validate_documents(
                    aave,
                    copy.deepcopy(PROVIDER),
                    copy.deepcopy(PERMISSIONLESS),
                    copy.deepcopy(COLLATERAL),
                )

    def test_authorized_collateral_path_blocks_exhaustive_rejection(self) -> None:
        collateral = copy.deepcopy(COLLATERAL)
        collateral["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        collateral["path_count"] = 1
        collateral["paths"] = [collateral_path()]
        result = mod.validate_documents(
            aave_report(),
            copy.deepcopy(PROVIDER),
            copy.deepcopy(PERMISSIONLESS),
            collateral,
        )
        self.assertEqual(result["status"], "RMC011_DEBT_FAMILY_RESOLUTION_BLOCKED")
        self.assertIn(
            "ZERO_OWN_CAPITAL_COLLATERAL_PATH_PRESENT",
            result["blocked_reasons"],
        )

    def test_candidate_conservation_is_required(self) -> None:
        aave = aave_report()
        aave["candidate_count"] = 2
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(
                aave,
                copy.deepcopy(PROVIDER),
                copy.deepcopy(PERMISSIONLESS),
                copy.deepcopy(COLLATERAL),
            )

    def test_global_nonexistence_nonclaim_is_required(self) -> None:
        aave = aave_report()
        aave["non_claims"].remove("AAVE_RESERVE_LIQUIDITY_IS_NOT_NQC_BORROWING_CAPACITY")
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(
                aave,
                copy.deepcopy(PROVIDER),
                copy.deepcopy(PERMISSIONLESS),
                copy.deepcopy(COLLATERAL),
            )


if __name__ == "__main__":
    unittest.main()

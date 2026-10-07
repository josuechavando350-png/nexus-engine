from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-permissionless-debt-facility-catalog.py")
SPEC = importlib.util.spec_from_file_location("rmc011_debt_catalog", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

CATALOG = json.loads(
    Path("ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json").read_text()
)


def sample_facility() -> dict:
    return {
        "family": "PERSISTENT_DEBT",
        "chain_id": 1,
        "facility_address": "0x" + "11" * 20,
        "principal_asset": "TOKEN:0x" + "22" * 20,
        "collateral_asset": "TOKEN:0x" + "33" * 20,
        "runtime_code_hash": "0x" + "44" * 32,
        "deployment_provenance": {
            "kind": "OFFICIAL_UPSTREAM_DEPLOYMENT",
            "source": "fixture://persistent-debt",
            "sha256": "55" * 32,
        },
        "interest_model_hash": "0x" + "61" * 32,
        "liquidation_model_hash": "0x" + "62" * 32,
        "solvency_model_hash": "0x" + "63" * 32,
        "oracle_risk_hash": "0x" + "64" * 32,
        "liquidity_withdrawal_risk_hash": "0x" + "65" * 32,
        "facility_disappearance_risk_hash": "0x" + "66" * 32,
        "declaration_sha256": "77" * 32,
        "admission_status": "DECLARED_NOT_AUTHENTICATED",
    }


class PermissionlessDebtFacilityCatalogTests(unittest.TestCase):
    def test_current_empty_catalog_is_valid_but_nonterminal(self) -> None:
        result = mod.validate_document(copy.deepcopy(CATALOG))
        self.assertEqual(result["facility_count"], 0)
        self.assertFalse(result["terminal_evidence"])
        self.assertFalse(result["availability_claimed"])
        self.assertEqual(result["status"], "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE")

    def test_empty_catalog_cannot_disable_terminal_artifact_requirement(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["terminal_semantics"]["terminal_rejection_requires_authenticated_workflow_artifact"] = False
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_declared_facility_with_complete_risk_surface_passes(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [sample_facility()]
        doc["facility_count"] = 1
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        result = mod.validate_document(doc)
        self.assertEqual(result["facility_count"], 1)
        self.assertEqual(result["families"]["PERSISTENT_DEBT"], 1)

    def test_duplicate_facility_identity_fails(self) -> None:
        facility = sample_facility()
        duplicate = copy.deepcopy(facility)
        duplicate["declaration_sha256"] = "88" * 32
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [facility, duplicate]
        doc["facility_count"] = 2
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_missing_risk_hash_fails(self) -> None:
        facility = sample_facility()
        facility.pop("oracle_risk_hash")
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [facility]
        doc["facility_count"] = 1
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_invalid_runtime_hash_fails(self) -> None:
        facility = sample_facility()
        facility["runtime_code_hash"] = "0x1234"
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [facility]
        doc["facility_count"] = 1
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_invalid_facility_address_fails(self) -> None:
        facility = sample_facility()
        facility["facility_address"] = "0x1234"
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [facility]
        doc["facility_count"] = 1
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_principal_and_collateral_must_differ(self) -> None:
        facility = sample_facility()
        facility["collateral_asset"] = facility["principal_asset"]
        doc = copy.deepcopy(CATALOG)
        doc["facilities"] = [facility]
        doc["facility_count"] = 1
        doc["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_model_support_cannot_be_relabelled_availability(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["non_claims"].remove("MODEL_SUPPORT_IS_NOT_FACILITY_AVAILABILITY")
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

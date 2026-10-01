from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-collateral-funding-path-catalog.py")
SPEC = importlib.util.spec_from_file_location("rmc011_collateral_paths", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

CATALOG = json.loads(
    Path("ci/nqc-census/rmc011-collateral-funding-path-catalog.json").read_text()
)


def sample_path() -> dict:
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


class CollateralFundingPathCatalogTests(unittest.TestCase):
    def test_current_empty_catalog_is_valid_but_nonterminal(self) -> None:
        result = mod.validate_document(copy.deepcopy(CATALOG))
        self.assertEqual(result["path_count"], 0)
        self.assertFalse(result["zero_own_capital_paths_available"])
        self.assertFalse(result["terminal_evidence"])
        self.assertFalse(result["global_nonexistence_claimed"])

    def test_live_external_path_with_persistent_collateral_passes(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [sample_path()]
        result = mod.validate_document(doc)
        self.assertTrue(result["zero_own_capital_paths_available"])

    def test_operator_owned_collateral_fails(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["operator_owned"] = True
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_strategy_output_dependent_collateral_fails(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["requires_strategy_output"] = True
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_same_transaction_collateral_cannot_back_persistent_debt(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["persistence_semantics"] = "SAME_TRANSACTION"
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_deadline_path_requires_positive_deadline(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["persistence_semantics"] = "DEADLINE_BLOCKS"
        row["deadline_blocks"] = 0
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_empty_catalog_cannot_claim_global_nonexistence(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["terminal_semantics"]["does_not_mean"] = "NO_COLLATERAL_EXISTS_ANYWHERE"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_path_count_must_match(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["path_count"] = 1
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)


    def test_operator_treasury_provider_id_fails(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["provider_registry_id"] = "OPERATOR_TREASURY"
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_duplicate_evidence_views_do_not_count_as_independent_authority(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = sample_path()
        row["evidence"] = ["same-view", "same-view"]
        doc["status"] = "DECLARED_WITH_PATHS_NOT_TERMINAL_EVIDENCE"
        doc["path_count"] = 1
        doc["paths"] = [row]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

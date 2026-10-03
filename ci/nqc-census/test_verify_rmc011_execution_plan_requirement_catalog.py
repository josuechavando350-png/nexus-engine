#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-execution-plan-requirement-catalog.py")
SPEC = importlib.util.spec_from_file_location("rmc011_plan_catalog", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

CATALOG = json.loads(
    Path("ci/nqc-census/rmc011-execution-plan-requirement-catalog.json").read_text()
)


class RequirementCatalogTests(unittest.TestCase):
    def test_current_empty_catalog_is_nonterminal(self) -> None:
        result = mod.validate_document(copy.deepcopy(CATALOG))
        self.assertEqual(result["plan_count"], 0)
        self.assertFalse(result["terminal_evidence"])
        self.assertFalse(result["actionability_claimed"])

    def test_bond_mapping_cannot_be_collateral(self) -> None:
        doc = copy.deepcopy(CATALOG)
        row = next(row for row in doc["requirement_families"] if row["family"] == "BOND_OR_STAKE")
        row["requirement_kind"] = "COLLATERAL"
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_empty_catalog_cannot_claim_terminal_rejection(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["terminal_semantics"]["terminal_rejection_requires_authenticated_workflow_artifact"] = False
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_plan_count_must_match(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["plan_count"] = 1
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_supported_plan_requires_exact_class_mapping(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["status"] = "DECLARED_WITH_PLANS_NOT_TERMINAL_EVIDENCE"
        doc["plan_count"] = 1
        doc["plans"] = [{
            "plan_id": "plan-a",
            "plan_sha256": "1" * 64,
            "admission_status": "SUPPORTED",
            "requirements": [{
                "family": "INVENTORY_REQUIREMENT",
                "requirement_kind": "INVENTORY",
                "allowed_classes": ["FLASH_SWAP"],
                "asset_source": "plan.asset",
                "amount_source": "plan.amount",
            }],
            "evidence": ["content-addressed:plan-a"],
        }]
        with self.assertRaises(mod.CatalogError):
            mod.validate_document(doc)

    def test_supported_plan_with_exact_projection_passes(self) -> None:
        doc = copy.deepcopy(CATALOG)
        doc["status"] = "DECLARED_WITH_PLANS_NOT_TERMINAL_EVIDENCE"
        doc["plan_count"] = 1
        doc["plans"] = [{
            "plan_id": "plan-a",
            "plan_sha256": "1" * 64,
            "admission_status": "SUPPORTED",
            "requirements": [{
                "family": "BOND_OR_STAKE",
                "requirement_kind": "BOND_OR_STAKE",
                "allowed_classes": ["BOND_OR_STAKE"],
                "asset_source": "plan.bond_asset",
                "amount_source": "plan.bond_amount",
            }],
            "evidence": ["content-addressed:plan-a"],
        }]
        result = mod.validate_document(doc)
        self.assertEqual(result["referenced_families"], ["BOND_OR_STAKE"])


if __name__ == "__main__":
    unittest.main()

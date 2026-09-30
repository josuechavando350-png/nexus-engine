#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-capital-family-discovery.py")
SPEC = importlib.util.spec_from_file_location("rmc011_discovery", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

DISCOVERY = json.loads(Path("ci/nqc-census/rmc011-capital-family-discovery.json").read_text())
UNIVERSE = json.loads(Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text())


class DiscoveryContractTests(unittest.TestCase):
    def test_current_contract_covers_exact_universe(self) -> None:
        result = mod.validate_document(copy.deepcopy(DISCOVERY), copy.deepcopy(UNIVERSE))
        self.assertEqual(result["family_count"], 13)
        self.assertTrue(result["cross_checked_universe"])

    def test_missing_family_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"].pop()
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(doc, copy.deepcopy(UNIVERSE))

    def test_unknown_family_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"][0]["id"] = "UNKNOWN_CAPITAL_FAMILY"
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(doc, copy.deepcopy(UNIVERSE))

    def test_blank_completeness_rule_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"][0]["completeness"] = ""
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(doc, copy.deepcopy(UNIVERSE))

    def test_historical_t36_cannot_be_balancer_d11_authority(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(row for row in doc["families"] if row["id"] == "BALANCER_V2_FLASH_LOAN")
        row["authority"] = "T36_HISTORICAL_FORK"
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(doc, copy.deepcopy(UNIVERSE))

    def test_external_credit_cannot_drop_registry_enumeration(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(row for row in doc["families"] if row["id"] == "EXTERNAL_GAS_CREDIT")
        row["surface"] = "AD_HOC_PROVIDER"
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(doc, copy.deepcopy(UNIVERSE))

    def test_universe_family_set_mismatch_fails(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        universe["families"].pop()
        with self.assertRaises(mod.DiscoveryError):
            mod.validate_document(copy.deepcopy(DISCOVERY), universe)


if __name__ == "__main__":
    unittest.main()

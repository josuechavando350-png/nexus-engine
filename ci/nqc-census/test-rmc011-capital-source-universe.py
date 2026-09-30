#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "ci/nqc-census/verify-rmc011-capital-source-universe.py"
UNIVERSE_PATH = ROOT / "ci/nqc-census/rmc011-capital-source-universe.json"

spec = importlib.util.spec_from_file_location("rmc011_universe", MODULE_PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CapitalSourceUniverseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.base = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))

    def test_current_contract_is_fail_closed_and_coherent(self) -> None:
        result = module.validate_document(copy.deepcopy(self.base))
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 2)
        self.assertEqual(result["unresolved_count"], 11)
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertEqual(result["status"], "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE")

    def test_cannot_claim_terminal_with_unresolved_family(self) -> None:
        doc = copy.deepcopy(self.base)
        doc["terminal_claim_allowed"] = True
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_status_cannot_claim_complete_with_unresolved_family(self) -> None:
        doc = copy.deepcopy(self.base)
        doc["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_duplicate_family_fails(self) -> None:
        doc = copy.deepcopy(self.base)
        doc["families"][-1] = copy.deepcopy(doc["families"][0])
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_unknown_family_fails_even_when_unknown_count_is_zero(self) -> None:
        doc = copy.deepcopy(self.base)
        doc["families"][0]["id"] = "UNDECLARED_PROVIDER"
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_model_only_cannot_smuggle_real_source_path(self) -> None:
        doc = copy.deepcopy(self.base)
        row = next(row for row in doc["families"] if row["status"] == "MODEL_ONLY")
        row["real_source_path"] = "fake/live/path"
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_resolved_flag_must_follow_status(self) -> None:
        doc = copy.deepcopy(self.base)
        row = next(row for row in doc["families"] if row["status"] == "MODEL_ONLY")
        row["terminally_resolved"] = True
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_all_resolved_allows_terminal_only_with_coherent_status(self) -> None:
        doc = copy.deepcopy(self.base)
        for row in doc["families"]:
            row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
            row["terminally_resolved"] = True
            if row["real_source_path"] is None:
                row["real_source_path"] = "authenticated/evidence/path"
        doc["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        doc["terminal_claim_allowed"] = True
        result = module.validate_document(doc)
        self.assertTrue(result["terminal_claim_allowed"])
        self.assertEqual(result["unresolved_count"], 0)


if __name__ == "__main__":
    unittest.main()

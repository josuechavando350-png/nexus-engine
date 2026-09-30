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
SCOPE_PATH = ROOT / "ci/nqc-census/capital-census-scope.json"

spec = importlib.util.spec_from_file_location("rmc011_universe", MODULE_PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def terminalize(doc: dict) -> None:
    for index, row in enumerate(doc["families"], start=1):
        row["status"] = (
            "AUTHENTICATED_REAL_SOURCE"
            if row["real_source_path"] is not None
            else "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
        )
        if row["real_source_path"] is None:
            row["real_source_path"] = f"evidence/rejection/{row['id']}.json"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = {
            "kind": row["status"],
            "sha256": f"{index:064x}",
            "authority_ref": f"TEST_AUTHORITY_{index}",
        }
    doc["family_universe_discovery"] = {
        "status": "AUTHENTICATED_COMPLETE",
        "evidence": {
            "sha256": "ab" * 32,
            "authority_ref": "TEST_FAMILY_UNIVERSE_AUTHORITY",
        },
        "terminal_requirement": "AUTHENTICATED_COMPLETE",
    }
    doc["status"] = "D11_TERMINAL_CLOSED"
    doc["terminal_claim_allowed"] = True


class CapitalSourceUniverseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.base = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
        cls.scope = json.loads(SCOPE_PATH.read_text(encoding="utf-8"))

    def test_current_contract_is_blocked_and_coherent(self) -> None:
        result = module.validate_document(copy.deepcopy(self.base))
        module.validate_scope(copy.deepcopy(self.scope), copy.deepcopy(self.base))
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 0)
        self.assertEqual(result["unresolved_count"], 13)
        self.assertEqual(result["family_universe_discovery"], "NOT_CERTIFIED")
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertEqual(result["status"], "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE")

    def test_semantic_admission_cannot_be_terminal_resolution(self) -> None:
        doc = copy.deepcopy(self.base)
        row = doc["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = True
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_resolved_family_requires_resolution_evidence(self) -> None:
        doc = copy.deepcopy(self.base)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = None
        with self.assertRaises(module.UniverseError):
            module.validate_document(doc)

    def test_all_families_resolved_still_requires_family_universe_discovery(self) -> None:
        doc = copy.deepcopy(self.base)
        terminalize(doc)
        doc["family_universe_discovery"] = {
            "status": "NOT_CERTIFIED",
            "evidence": None,
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        doc["status"] = "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
        doc["terminal_claim_allowed"] = False
        result = module.validate_document(doc)
        self.assertFalse(result["terminal_claim_allowed"])

    def test_complete_authenticated_state_can_close(self) -> None:
        doc = copy.deepcopy(self.base)
        terminalize(doc)
        result = module.validate_document(doc)
        self.assertTrue(result["terminal_claim_allowed"])
        self.assertEqual(result["unresolved_count"], 0)
        self.assertEqual(result["status"], "D11_TERMINAL_CLOSED")

    def test_scope_cannot_omit_required_family(self) -> None:
        scope = copy.deepcopy(self.scope)
        scope["required_source_families"].pop()
        with self.assertRaises(module.UniverseError):
            module.validate_scope(scope, copy.deepcopy(self.base))

    def test_duplicate_or_unknown_family_fails(self) -> None:
        duplicate = copy.deepcopy(self.base)
        duplicate["families"][-1] = copy.deepcopy(duplicate["families"][0])
        with self.assertRaises(module.UniverseError):
            module.validate_document(duplicate)

        unknown = copy.deepcopy(self.base)
        unknown["families"][0]["id"] = "UNDECLARED_PROVIDER"
        with self.assertRaises(module.UniverseError):
            module.validate_document(unknown)


if __name__ == "__main__":
    unittest.main()

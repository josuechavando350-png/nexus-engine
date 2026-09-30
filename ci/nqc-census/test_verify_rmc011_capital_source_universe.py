#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-capital-source-universe.py")
SPEC = importlib.util.spec_from_file_location("rmc011_universe", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

BASE = json.loads(Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text())
SCOPE = json.loads(Path("ci/nqc-census/capital-census-scope.json").read_text())


def terminalize(doc: dict) -> None:
    for index, row in enumerate(doc["families"], start=1):
        if row["real_source_path"] is None:
            row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            row["real_source_path"] = f"evidence/rejection/{row['id']}.json"
        else:
            row["status"] = "AUTHENTICATED_REAL_SOURCE"
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


class SourceUniverseTests(unittest.TestCase):
    def test_current_blocked_contract_is_valid(self) -> None:
        doc = copy.deepcopy(BASE)
        result = mod.validate_document(doc)
        mod.validate_scope(copy.deepcopy(SCOPE), doc)
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 0)
        self.assertEqual(result["unresolved_count"], 13)
        self.assertEqual(result["family_universe_discovery"], "NOT_CERTIFIED")
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertEqual(result["status"], "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE")

    def test_implemented_parser_is_not_terminal_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_only_authenticated_or_exhaustively_rejected_can_close(self) -> None:
        doc = copy.deepcopy(BASE)
        terminalize(doc)
        result = mod.validate_document(doc)
        self.assertTrue(result["terminal_claim_allowed"])
        self.assertEqual(result["resolved_count"], 13)
        self.assertEqual(result["unresolved_count"], 0)
        self.assertEqual(result["status"], "D11_TERMINAL_CLOSED")

    def test_resolved_family_requires_nonzero_resolution_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = {
            "kind": "AUTHENTICATED_REAL_SOURCE",
            "sha256": "0" * 64,
            "authority_ref": "fake",
        }
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_all_families_resolved_still_requires_family_universe_discovery(self) -> None:
        doc = copy.deepcopy(BASE)
        terminalize(doc)
        doc["family_universe_discovery"] = {
            "status": "NOT_CERTIFIED",
            "evidence": None,
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        doc["status"] = "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
        doc["terminal_claim_allowed"] = False
        result = mod.validate_document(doc)
        self.assertFalse(result["terminal_claim_allowed"])

    def test_family_universe_complete_requires_nonzero_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["family_universe_discovery"] = {
            "status": "AUTHENTICATED_COMPLETE",
            "evidence": {
                "sha256": "0" * 64,
                "authority_ref": "fake",
            },
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_unknown_family_fails(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["families"][0]["id"] = "UNKNOWN_CAPITAL_FAMILY"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_terminal_claim_cannot_be_forced_while_unresolved(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["terminal_claim_allowed"] = True
        doc["status"] = "D11_TERMINAL_CLOSED"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_model_only_cannot_smuggle_real_source_path(self) -> None:
        doc = copy.deepcopy(BASE)
        row = next(row for row in doc["families"] if row["status"] == "MODEL_ONLY")
        row["real_source_path"] = "fake/path"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_scope_cannot_omit_required_family(self) -> None:
        scope = copy.deepcopy(SCOPE)
        scope["required_source_families"].pop()
        with self.assertRaises(mod.UniverseError):
            mod.validate_scope(scope, copy.deepcopy(BASE))


if __name__ == "__main__":
    unittest.main()

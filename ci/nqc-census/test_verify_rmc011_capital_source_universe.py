#!/usr/bin/env python3
import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-capital-source-universe.py")
SPEC = importlib.util.spec_from_file_location("rmc011_universe", MODULE_PATH)
mod = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mod)

BASE = json.loads(Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text())
SCOPE = json.loads(Path("ci/nqc-census/capital-census-scope.json").read_text())


class SourceUniverseVerifierTests(unittest.TestCase):
    def test_current_blocked_contract_is_valid(self):
        result = mod.validate_document(copy.deepcopy(BASE))
        mod.validate_scope(copy.deepcopy(SCOPE), copy.deepcopy(BASE))
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertEqual(result["resolved_count"], 0)
        self.assertEqual(result["unresolved_count"], 13)

    def test_implemented_parser_is_not_terminal_evidence(self):
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_terminal_resolution_requires_nonzero_evidence_digest(self):
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

    def test_terminal_claim_cannot_be_forced_while_unresolved(self):
        doc = copy.deepcopy(BASE)
        doc["terminal_claim_allowed"] = True
        doc["status"] = "D11_TERMINAL_CLOSED"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_family_universe_discovery_evidence_is_required_for_close(self):
        doc = copy.deepcopy(BASE)
        doc["family_universe_discovery"]["status"] = "AUTHENTICATED_COMPLETE"
        doc["family_universe_discovery"]["evidence"] = None
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

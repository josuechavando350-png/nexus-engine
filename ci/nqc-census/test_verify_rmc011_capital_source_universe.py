#!/usr/bin/env python3
import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH=Path("ci/nqc-census/verify-rmc011-capital-source-universe.py")
SPEC=importlib.util.spec_from_file_location("rmc011_universe", MODULE_PATH)
mod=importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mod)

BASE=json.loads(Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text())

class SourceUniverseTests(unittest.TestCase):
    def test_current_blocked_contract_is_valid(self):
        result=mod.validate_document(copy.deepcopy(BASE))
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertGreater(result["unresolved_count"],0)

    def test_implemented_parser_is_not_terminal_evidence(self):
        doc=copy.deepcopy(BASE)
        row=doc["families"][0]
        row["status"]="SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"]=True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_only_authenticated_or_exhaustively_rejected_can_close(self):
        doc=copy.deepcopy(BASE)
        for row in doc["families"]:
            if row["real_source_path"] is None:
                row["status"]="EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            else:
                row["status"]="AUTHENTICATED_REAL_SOURCE"
            row["terminally_resolved"]=True
        doc["status"]="CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        doc["terminal_claim_allowed"]=True
        result=mod.validate_document(doc)
        self.assertTrue(result["terminal_claim_allowed"])
        self.assertEqual(result["unresolved_count"],0)

    def test_unknown_family_fails(self):
        doc=copy.deepcopy(BASE)
        doc["families"][0]["id"]="UNKNOWN_CAPITAL_FAMILY"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_terminal_claim_cannot_be_forced_while_unresolved(self):
        doc=copy.deepcopy(BASE)
        doc["terminal_claim_allowed"]=True
        doc["status"]="CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

if __name__=="__main__":
    unittest.main()

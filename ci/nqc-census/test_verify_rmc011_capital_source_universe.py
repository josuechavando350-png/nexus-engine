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


def evidence(kind: str, byte: str) -> dict:
    head = byte * 40
    return {
        "kind": kind,
        "repository": "josuechavando350-png/nexus-engine",
        "workflow_name": "NQC RMC-011 Family Evidence",
        "run_id": int(byte, 16) + 1,
        "head_sha": head,
        "artifact_id": int(byte, 16) + 101,
        "artifact_name": f"rmc011-family-evidence-{head}",
        "artifact_digest": "sha256:" + byte * 64,
        "file": f"family-{byte}/evidence.json",
        "sha256": byte * 64,
    }


def resolve_all_families(doc: dict) -> None:
    for index, row in enumerate(doc["families"], start=1):
        digit = format((index % 15) + 1, "x")
        if row["real_source_path"] is None:
            row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            row["resolution_evidence"] = evidence("EXHAUSTIVE_REJECTION", digit)
        else:
            row["status"] = "AUTHENTICATED_REAL_SOURCE"
            row["resolution_evidence"] = evidence("AUTHENTICATED_REAL_SOURCE", digit)
        row["terminally_resolved"] = True


class SourceUniverseTests(unittest.TestCase):
    def test_current_blocked_contract_is_valid(self) -> None:
        result = mod.validate_document(copy.deepcopy(BASE))
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 0)
        self.assertEqual(result["unresolved_count"], 13)
        self.assertFalse(result["family_universe_discovery_complete"])
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertFalse(result["d11_terminal_closed"])
        self.assertEqual(result["status"], "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE")

    def test_schema_must_be_v2(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["schema_version"] = 1
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_implemented_parser_is_not_terminal_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_authenticated_family_requires_hash_bound_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = None
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_locator_and_sha_alone_cannot_authenticate_family(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = {
            "kind": "AUTHENTICATED_REAL_SOURCE",
            "locator": "looks/real.json",
            "sha256": "a" * 64,
        }
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_terminal_evidence_must_bind_artifact_to_exact_head(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = evidence("AUTHENTICATED_REAL_SOURCE", "a")
        row["resolution_evidence"]["artifact_name"] = "rmc011-family-evidence-wrong-head"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_terminal_evidence_file_cannot_escape_artifact(self) -> None:
        doc = copy.deepcopy(BASE)
        row = doc["families"][0]
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = evidence("AUTHENTICATED_REAL_SOURCE", "b")
        row["resolution_evidence"]["file"] = "../forged.json"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_exhaustive_rejection_requires_hash_bound_evidence(self) -> None:
        doc = copy.deepcopy(BASE)
        row = next(row for row in doc["families"] if row["real_source_path"] is None)
        row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
        row["terminally_resolved"] = True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_all_families_resolved_is_not_enough_without_discovery_authority(self) -> None:
        doc = copy.deepcopy(BASE)
        resolve_all_families(doc)
        result = mod.validate_document(doc)
        self.assertEqual(result["resolved_count"], 13)
        self.assertFalse(result["family_universe_discovery_complete"])
        self.assertFalse(result["terminal_claim_allowed"])
        self.assertEqual(result["status"], "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE")

    def test_authenticated_discovery_and_resolved_families_complete_universe_only(self) -> None:
        doc = copy.deepcopy(BASE)
        resolve_all_families(doc)
        doc["family_universe_discovery"] = {
            "status": "AUTHENTICATED_COMPLETE",
            "evidence": evidence("AUTHENTICATED_DISCOVERY", "a"),
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        doc["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        doc["terminal_claim_allowed"] = True
        result = mod.validate_document(doc)
        self.assertTrue(result["family_universe_discovery_complete"])
        self.assertTrue(result["terminal_claim_allowed"])
        self.assertFalse(result["d11_terminal_closed"])
        self.assertEqual(result["status"], "CAPITAL_SOURCE_UNIVERSE_COMPLETE")

    def test_source_universe_contract_can_never_emit_d11_terminal_closed(self) -> None:
        doc = copy.deepcopy(BASE)
        resolve_all_families(doc)
        doc["family_universe_discovery"] = {
            "status": "AUTHENTICATED_COMPLETE",
            "evidence": evidence("AUTHENTICATED_DISCOVERY", "b"),
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        doc["status"] = "D11_TERMINAL_CLOSED"
        doc["terminal_claim_allowed"] = True
        doc["d11_terminal_closed"] = True
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_unknown_family_fails(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["families"][0]["id"] = "UNKNOWN_CAPITAL_FAMILY"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_model_only_cannot_smuggle_real_source_path(self) -> None:
        doc = copy.deepcopy(BASE)
        row = next(row for row in doc["families"] if row["status"] == "MODEL_ONLY")
        row["real_source_path"] = "fake/path"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)


    def test_implemented_family_requires_canonical_existing_source_path(self) -> None:
        doc = copy.deepcopy(BASE)
        row = next(
            row
            for row in doc["families"]
            if row["id"] == "EXTERNAL_GAS_SPONSOR"
        )
        self.assertEqual(row["status"], "SEMANTIC_ADMISSION_IMPLEMENTED")
        row["real_source_path"] = "fake/path"
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)

    def test_implemented_family_cannot_point_at_another_real_importer(self) -> None:
        doc = copy.deepcopy(BASE)
        row = next(
            row
            for row in doc["families"]
            if row["id"] == "TRANSIENT_EXTERNAL_CREDIT"
        )
        self.assertEqual(row["status"], "SEMANTIC_ADMISSION_IMPLEMENTED")
        row["real_source_path"] = (
            "nqc-census/crates/nqc-census-capital/src/gas_sponsor.rs"
        )
        with self.assertRaises(mod.UniverseError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

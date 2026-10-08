from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-debt-family-promotion.py")
SPEC = importlib.util.spec_from_file_location("rmc011_debt_promotion", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

UNIVERSE = json.loads(
    Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text()
)


def reject_both(doc: dict) -> None:
    for index, family in enumerate(sorted(mod.DEBT_FAMILIES), start=1):
        row = next(row for row in doc["families"] if row["id"] == family)
        row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
        row["terminally_resolved"] = True
        row["real_source_path"] = None
        row["resolution_evidence"] = {
            "kind": "EXHAUSTIVE_REJECTION",
            "repository": mod.EXPECTED_REPOSITORY,
            "workflow_name": mod.EXPECTED_WORKFLOW,
            "run_id": 12345,
            "head_sha": "a" * 40,
            "artifact_id": 67890,
            "artifact_name": "rmc011-real-source-certification-" + "a" * 40,
            "artifact_digest": "sha256:" + "b" * 64,
            "file": f"debt-family-evidence/families/{family}/evidence.json",
            "sha256": f"{index:064x}",
        }


class DebtFamilyPromotionTests(unittest.TestCase):
    def test_current_universe_is_pending(self) -> None:
        result = mod.validate_document(copy.deepcopy(UNIVERSE))
        self.assertEqual(result["promotion_state"], "PENDING")

    def test_atomic_debt_rejection_promotion_passes(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        result = mod.validate_document(doc)
        self.assertEqual(
            result["promotion_state"],
            "EXHAUSTIVE_REJECTION_REFERENCES_DECLARED",
        )
        self.assertEqual(result["rejected_count"], 2)

    def test_partial_debt_rejection_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "PERSISTENT_DEBT"
        )
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = False
        row["real_source_path"] = "nqc-census/crates/nqc-census-capital/src/external_debt.rs"
        row["resolution_evidence"] = None
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_mixed_artifacts_fail(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "PERSISTENT_DEBT"
        )
        row["resolution_evidence"]["artifact_id"] = 99999
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_wrong_family_evidence_path_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "COLLATERALIZED_BORROWING"
        )
        row["resolution_evidence"]["file"] = (
            "debt-family-evidence/families/PERSISTENT_DEBT/evidence.json"
        )
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_duplicate_family_sha_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        rows = [
            row for row in doc["families"]
            if row["id"] in mod.DEBT_FAMILIES
        ]
        rows[1]["resolution_evidence"]["sha256"] = rows[0]["resolution_evidence"]["sha256"]
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)



def attest_both_synthetic(doc: dict) -> None:
    """Syntactically valid MOCK references, never certified on-chain funding."""
    for index, family in enumerate(sorted(mod.DEBT_FAMILIES), start=1):
        row = next(r for r in doc["families"] if r["id"] == family)
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["real_source_path"] = mod.EXPECTED_REAL_SOURCE_PATH
        row["resolution_evidence"] = {
            "kind": "AUTHENTICATED_REAL_SOURCE",
            "repository": mod.EXPECTED_REPOSITORY,
            "workflow_name": mod.EXPECTED_WORKFLOW,
            "run_id": 12345,
            "head_sha": "a" * 40,
            "artifact_id": 67890,
            "artifact_name": mod.EXPECTED_ARTIFACT_PREFIX + "a" * 40,
            "artifact_digest": "sha256:" + "b" * 64,
            "file": f"debt-family-evidence/families/{family}/evidence.json",
            "sha256": f"{index:064x}",
        }


class DebtAuthenticatedSourceAdversarialTests(unittest.TestCase):
    """Real-source statuses never bootstrap themselves to authentic capital."""

    def make(self) -> dict:
        doc = copy.deepcopy(UNIVERSE)
        attest_both_synthetic(doc)
        return doc

    def reject(self, doc: dict, text: str) -> None:
        with self.assertRaisesRegex(mod.PromotionError, text):
            mod.validate_document(doc)

    def test_both_synthetic_refs_are_only_unverified_declarations(self) -> None:
        result = mod.validate_document(self.make())
        self.assertEqual(result["promotion_state"],
                         "AUTHENTICATED_REAL_SOURCE_REFERENCES_DECLARED")
        self.assertEqual(result["authenticated_count"], 2)
        self.assertIs(result["independent_artifact_authentication_complete"], False)
        self.assertIs(result["d11_terminal_closed"], False)

    def test_forged_status_strings_without_any_witness_fail(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        for row in doc["families"]:
            if row["id"] in mod.DEBT_FAMILIES:
                row["status"] = "AUTHENTICATED_REAL_SOURCE"
        self.reject(doc, "terminal flag")

    def test_real_source_without_evidence_must_fail(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"] = None
        self.reject(doc, "evidence missing")

    def test_wrong_source_kind_fails(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["kind"] = "EXHAUSTIVE_REJECTION"
        self.reject(doc, "kind differs")

    def test_zero_or_missing_real_source_implementation_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["real_source_path"] = None
        self.reject(doc, "implementation missing")

    def test_missing_terminal_bool_fails(self) -> None:
        doc = self.make()
        doc["families"][7]["terminally_resolved"] = False
        self.reject(doc, "terminal flag")

    def test_boolean_run_id_fails(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["run_id"] = True
        self.reject(doc, "run ID")

    def test_wrong_workflow_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["workflow_name"] = "Fixture Simulator"
        self.reject(doc, "workflow differs")

    def test_wrong_repository_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["repository"] = "attacker/fork"
        self.reject(doc, "repository differs")

    def test_wrong_member_path_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["file"] = "other.json"
        self.reject(doc, "member path differs")

    def test_zero_sha256_artifact_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["artifact_digest"] = "sha256:" + "0" * 64
        self.reject(doc, "artifact SHA-256")

    def test_zero_sha256_member_rejected(self) -> None:
        doc = self.make()
        doc["families"][7]["resolution_evidence"]["sha256"] = "0" * 64
        self.reject(doc, "file SHA-256")

    def test_duplicate_sha256_member_rejected(self) -> None:
        doc = self.make()
        doc["families"][8]["resolution_evidence"]["sha256"] = (
            doc["families"][7]["resolution_evidence"]["sha256"]
        )
        self.reject(doc, "duplicated real-source file")

    def test_mixed_artifact_transport_rejected(self) -> None:
        doc = self.make()
        doc["families"][8]["resolution_evidence"]["run_id"] = 12346
        self.reject(doc, "mixes runs")

    def test_one_auth_source_other_rejected_disallowed_by_current_contract(self) -> None:
        doc = self.make()
        doc["families"][8]["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
        self.reject(doc, "cannot mix")

    def test_duplicate_universe_family_identity_rejected(self) -> None:
        doc = self.make()
        doc["families"].append(copy.deepcopy(doc["families"][7]))
        self.reject(doc, "duplicate")

    def test_mismatched_schema_rejected(self) -> None:
        doc = self.make()
        doc["schema_version"] = True
        self.reject(doc, "schema")

    def test_source_helper_cannot_claim_terminal_d11(self) -> None:
        doc = self.make()
        doc["d11_terminal_closed"] = True
        self.reject(doc, "cannot close terminal")

    def test_rejection_zero_file_sha256_rejected(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        doc["families"][7]["resolution_evidence"]["sha256"] = "0" * 64
        self.reject(doc, "zero file sha256")

    def test_rejection_zero_artifact_sha256_rejected(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        doc["families"][7]["resolution_evidence"]["artifact_digest"] = (
            "sha256:" + "0" * 64
        )
        self.reject(doc, "artifact_digest invalid")

    def test_rejection_result_remains_references_only(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        reject_both(doc)
        result = mod.validate_document(doc)
        self.assertIs(result["independent_artifact_authentication_complete"], False)
        self.assertIs(result["d11_terminal_closed"], False)


if __name__ == "__main__":
    unittest.main()

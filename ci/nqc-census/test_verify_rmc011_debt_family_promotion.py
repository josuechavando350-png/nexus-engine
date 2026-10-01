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


if __name__ == "__main__":
    unittest.main()

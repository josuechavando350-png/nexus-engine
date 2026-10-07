from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-bounded-family-promotion.py")
SPEC = importlib.util.spec_from_file_location("rmc011_bounded_promotion", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

UNIVERSE = json.loads(
    Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text()
)


def promote_all(doc: dict) -> None:
    for index, family in enumerate(sorted(mod.BOUNDED_FAMILIES), start=1):
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
            "artifact_name": (
                "rmc011-bounded-family-rejections-" + "a" * 40 + "-12345-1"
            ),
            "artifact_digest": "sha256:" + "b" * 64,
            "file": f"families/{family}/evidence.json",
            "sha256": f"{index:064x}",
        }


class BoundedFamilyPromotionTests(unittest.TestCase):
    def test_current_universe_is_valid_after_authenticated_promotion(self) -> None:
        result = mod.validate_document(copy.deepcopy(UNIVERSE))
        self.assertEqual(
            result["promotion_state"],
            "AUTHENTICATED_REFERENCES_DECLARED",
        )
        self.assertEqual(result["promoted_count"], 7)
        self.assertEqual(result["family_count"], 7)
        self.assertGreater(result["shared_run_id"], 0)
        self.assertGreater(result["shared_artifact_id"], 0)

    def test_atomic_seven_family_promotion_passes(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        result = mod.validate_document(doc)
        self.assertEqual(
            result["promotion_state"],
            "AUTHENTICATED_REFERENCES_DECLARED",
        )
        self.assertEqual(result["promoted_count"], 7)
        self.assertEqual(result["shared_run_id"], 12345)

    def test_partial_promotion_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "EXTERNAL_GAS_SPONSOR"
        )
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = False
        row["real_source_path"] = "nqc-census/crates/nqc-census-capital/src/gas_sponsor.rs"
        row["resolution_evidence"] = None
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_mixed_artifact_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "BOND_OR_STAKE"
        )
        row["resolution_evidence"]["artifact_id"] = 99999
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_wrong_family_file_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "BOND_OR_STAKE"
        )
        row["resolution_evidence"]["file"] = (
            "families/INVENTORY_REQUIREMENT/evidence.json"
        )
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_duplicate_family_file_sha_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        a = next(
            row for row in doc["families"]
            if row["id"] == "EXTERNAL_GAS_CREDIT"
        )
        b = next(
            row for row in doc["families"]
            if row["id"] == "EXTERNAL_GAS_SPONSOR"
        )
        b["resolution_evidence"]["sha256"] = a["resolution_evidence"]["sha256"]
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_wrong_workflow_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(
            row for row in doc["families"]
            if row["id"] == "TRANSIENT_EXTERNAL_CREDIT"
        )
        row["resolution_evidence"]["workflow_name"] = "NQC RMC-011 Fake Evidence"
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-protocol-family-promotion.py")
SPEC = importlib.util.spec_from_file_location("rmc011_protocol_promotion", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

UNIVERSE = json.loads(
    Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text()
)


def promote_all(doc: dict, rejected: set[str] | None = None) -> None:
    rejected = rejected or set()
    for index, family in enumerate(sorted(mod.FAMILIES), start=1):
        row = next(row for row in doc["families"] if row["id"] == family)
        is_rejected = family in rejected
        row["status"] = (
            "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            if is_rejected else "AUTHENTICATED_REAL_SOURCE"
        )
        row["terminally_resolved"] = True
        if is_rejected:
            row["real_source_path"] = None
        row["resolution_evidence"] = {
            "kind": "EXHAUSTIVE_REJECTION" if is_rejected else "AUTHENTICATED_REAL_SOURCE",
            "repository": mod.EXPECTED_REPOSITORY,
            "workflow_name": mod.EXPECTED_WORKFLOW,
            "run_id": 12345,
            "head_sha": "a" * 40,
            "artifact_id": 67890,
            "artifact_name": "rmc011-real-source-certification-" + "a" * 40 + "-12345-1",
            "artifact_digest": "sha256:" + "b" * 64,
            "file": f"protocol-family-evidence/families/{family}/evidence.json",
            "sha256": f"{index:064x}",
        }


class ProtocolFamilyPromotionTests(unittest.TestCase):
    def test_current_four_source_witnesses_are_declared_without_d11_close(self) -> None:
        result = mod.validate_document(copy.deepcopy(UNIVERSE))
        self.assertEqual(result["promotion_state"], "TERMINAL_PROTOCOL_REFERENCES_DECLARED")
        self.assertEqual(result["resolved_count"], 4)
        self.assertEqual(result["shared_run_id"], 37839794172)

    def test_mixed_terminal_outcomes_are_allowed_when_all_four_share_transport(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc, {"UNISWAP_V2_FLASH_SWAP"})
        result = mod.validate_document(doc)
        self.assertEqual(result["resolved_count"], 4)
        self.assertEqual(
            result["outcomes"]["UNISWAP_V2_FLASH_SWAP"],
            "EXHAUSTIVE_REJECTION",
        )

    def test_partial_protocol_promotion_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(row for row in doc["families"] if row["id"] == "UNISWAP_V3_FLASH")
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = False
        row["resolution_evidence"] = None
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_transport_mixing_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(row for row in doc["families"] if row["id"] == "BALANCER_V2_FLASH_LOAN")
        row["resolution_evidence"]["run_id"] = 99999
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)

    def test_original_native_workflow_evidence_matches_all_four(self) -> None:
        result = mod.validate_document(copy.deepcopy(UNIVERSE))
        self.assertEqual(result["resolved_count"], 4)
        self.assertTrue(all(x == "AUTHENTICATED_REAL_SOURCE"
                            for x in result["outcomes"].values()))

    def test_forged_native_workflow_is_rejected(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        row = next(x for x in doc["families"] if x["id"] == "UNISWAP_V3_FLASH")
        row["resolution_evidence"]["workflow_name"] = "Fabricated Data Publisher"
        with self.assertRaisesRegex(mod.PromotionError, "workflow differs"):
            mod.validate_document(doc)

    def test_real_source_artifact_name_must_embed_exact_run(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        row = next(x for x in doc["families"] if x["id"] == "UNISWAP_V2_FLASH_SWAP")
        row["resolution_evidence"]["artifact_name"] = (
            "rmc011-four-native-source-certification-"
            + row["resolution_evidence"]["head_sha"] + "-wrong-1"
        )
        with self.assertRaisesRegex(mod.PromotionError, "artifact name"):
            mod.validate_document(doc)

    def test_wrong_family_evidence_path_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        promote_all(doc)
        row = next(row for row in doc["families"] if row["id"] == "AAVE_V3_FLASH_LOAN")
        row["resolution_evidence"]["file"] = "wrong/evidence.json"
        with self.assertRaises(mod.PromotionError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()

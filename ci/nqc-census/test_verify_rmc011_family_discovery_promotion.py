from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-family-discovery-promotion.py")
SPEC = importlib.util.spec_from_file_location("rmc011_family_discovery_promotion", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

UNIVERSE = json.loads(
    Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text()
)
SCOPE_PATH = Path("ci/nqc-census/capital-census-scope.json")
ORIGINAL_READ_TEXT = Path.read_text


def validate_synthetic_complete_scope(doc: dict) -> dict:
    """Test an in-memory FUTURE complete scope; never edit the canonical file.

    The production scope truthfully claims incomplete D11. A simulated
    complete document must carry a simulated complete scope to test the
    real gate's downstream evidence conditions, without modifying the
    repository on disk or relaxing the verifier.
    """
    def scoped_read_text(path: Path, *args, **kwargs) -> str:
        original = ORIGINAL_READ_TEXT(path, *args, **kwargs)
        if path == SCOPE_PATH:
            scope = json.loads(original)
            assert scope["claims"]["capital_source_universe_complete"] is False
            scope["claims"]["capital_source_universe_complete"] = True
            return json.dumps(scope)
        return original

    with patch.object(Path, "read_text", new=scoped_read_text):
        return mod.validate_document(doc)


def family_evidence(kind: str, index: int) -> dict:
    digit = format((index % 15) + 1, "x")
    head = digit * 40
    return {
        "kind": kind,
        "repository": "josuechavando350-png/nexus-engine",
        "workflow_name": f"NQC RMC-011 Family Evidence {index}",
        "run_id": 10000 + index,
        "head_sha": head,
        "artifact_id": 20000 + index,
        "artifact_name": f"rmc011-family-evidence-{head}-{index}",
        "artifact_digest": "sha256:" + digit * 64,
        "file": f"families/{index}/evidence.json",
        "sha256": format(index + 1, "064x"),
    }


def resolve_all(doc: dict) -> None:
    for index, row in enumerate(doc["families"], start=1):
        if row["real_source_path"] is None:
            row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            kind = "EXHAUSTIVE_REJECTION"
        else:
            row["status"] = "AUTHENTICATED_REAL_SOURCE"
            kind = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = family_evidence(kind, index)


def promote_discovery(doc: dict) -> None:
    head = "a" * 40
    doc["family_universe_discovery"] = {
        "status": "AUTHENTICATED_COMPLETE",
        "terminal_requirement": "AUTHENTICATED_COMPLETE",
        "evidence": {
            "kind": "AUTHENTICATED_DISCOVERY",
            "repository": mod.EXPECTED_REPOSITORY,
            "workflow_name": mod.EXPECTED_WORKFLOW,
            "run_id": 55555,
            "head_sha": head,
            "artifact_id": 66666,
            "artifact_name": f"rmc011-family-discovery-{head}-55555-1",
            "artifact_digest": "sha256:" + "b" * 64,
            "file": "discovery-evidence.json",
            "sha256": "c" * 64,
        },
    }
    doc["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
    doc["terminal_claim_allowed"] = True


class FamilyDiscoveryPromotionTests(unittest.TestCase):
    def test_current_pending_discovery_reference_is_valid(self) -> None:
        result = mod.validate_document(copy.deepcopy(UNIVERSE))
        self.assertFalse(result["authenticated"])
        self.assertEqual(result["promotion_state"], "PENDING")

    def test_authenticated_discovery_reference_passes(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        result = validate_synthetic_complete_scope(doc)
        self.assertTrue(result["authenticated"])
        self.assertEqual(
            result["promotion_state"],
            "AUTHENTICATED_REFERENCE_DECLARED",
        )
        self.assertEqual(result["file"], "discovery-evidence.json")

    def test_authenticated_discovery_requires_all_families_resolved(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        row = doc["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED"
        row["terminally_resolved"] = False
        row["resolution_evidence"] = None
        doc["status"] = "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
        doc["terminal_claim_allowed"] = False
        with self.assertRaisesRegex(ValueError, "every family terminally resolved"):
            mod.validate_document(doc)

    def test_wrong_discovery_workflow_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        doc["family_universe_discovery"]["evidence"]["workflow_name"] = "Fake Workflow"
        with self.assertRaisesRegex(ValueError, "discovery evidence workflow differs"):
            validate_synthetic_complete_scope(doc)

    def test_wrong_discovery_evidence_file_fails(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        doc["family_universe_discovery"]["evidence"]["file"] = "other.json"
        with self.assertRaisesRegex(ValueError, "discovery evidence file must be"):
            validate_synthetic_complete_scope(doc)

    def test_artifact_name_must_bind_head(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        doc["family_universe_discovery"]["evidence"]["artifact_name"] = (
            "rmc011-family-discovery-wrong-head"
        )
        with self.assertRaisesRegex(ValueError, "artifact_name must bind the exact producing head"):
            validate_synthetic_complete_scope(doc)

    def test_real_incomplete_scope_cannot_claim_auth_complete(self) -> None:
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        with self.assertRaisesRegex(ValueError, "capital_source_universe_complete=true in scope"):
            mod.validate_document(doc)
        self.assertFalse(json.loads(SCOPE_PATH.read_text())["claims"]["capital_source_universe_complete"])

    def test_synthetic_completion_never_changes_source_scope_bytes(self) -> None:
        before = SCOPE_PATH.read_bytes()
        doc = copy.deepcopy(UNIVERSE)
        resolve_all(doc)
        promote_discovery(doc)
        validate_synthetic_complete_scope(doc)
        self.assertEqual(SCOPE_PATH.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

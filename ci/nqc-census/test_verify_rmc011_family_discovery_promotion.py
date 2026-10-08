from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

from rmc011_discovery_test_fixtures import (
    CANONICAL_PATHS,
    UNIVERSE_PATH,
    admitted_state,
    in_memory_scope,
    pending_state,
)

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-family-discovery-promotion.py")
SPEC = importlib.util.spec_from_file_location("rmc011_family_discovery_promotion", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

UNIVERSE, SCOPE = pending_state()


def validate_with_scope(doc: dict, scope: dict = SCOPE) -> dict:
    with in_memory_scope(scope):
        return mod.validate_document(doc)


def validate_synthetic_complete_scope(doc: dict) -> dict:
    _, scope = admitted_state()
    return validate_with_scope(doc, scope)


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
    admitted, _ = admitted_state()
    for key in ("family_universe_discovery", "status", "terminal_claim_allowed"):
        doc[key] = copy.deepcopy(admitted[key])


class FamilyDiscoveryPromotionTests(unittest.TestCase):
    def test_explicit_pending_discovery_reference_is_valid(self) -> None:
        result = validate_with_scope(copy.deepcopy(UNIVERSE))
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
            validate_with_scope(doc)

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

    def test_pending_scope_cannot_claim_authenticated_complete(self) -> None:
        doc, _ = admitted_state()
        _, scope = pending_state()
        with self.assertRaisesRegex(ValueError, "capital_source_universe_complete=true in scope"):
            validate_with_scope(doc, scope)

    def test_admitted_scope_cannot_claim_pending_discovery(self) -> None:
        doc, _ = pending_state()
        _, scope = admitted_state()
        with self.assertRaisesRegex(
            ValueError, "incomplete source universe cannot claim capital_source_universe_complete"
        ):
            validate_with_scope(doc, scope)

    def test_live_canonical_discovery_reference_is_admitted(self) -> None:
        doc = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
        result = mod.validate_document(doc)
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["promotion_state"], "AUTHENTICATED_REFERENCE_DECLARED")
        self.assertEqual(result["file"], "discovery-evidence.json")
        self.assertFalse(doc["d11_terminal_closed"])

    def test_both_state_fixtures_never_change_canonical_bytes(self) -> None:
        before = {path: path.read_bytes() for path in CANONICAL_PATHS}
        for factory in (pending_state, admitted_state):
            doc, scope = factory()
            snapshot = copy.deepcopy((doc, scope))
            validate_with_scope(doc, scope)
            self.assertEqual((doc, scope), snapshot)
        self.assertEqual({path: path.read_bytes() for path in CANONICAL_PATHS}, before)


if __name__ == "__main__":
    unittest.main()

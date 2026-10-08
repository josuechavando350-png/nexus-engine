from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

from rmc011_discovery_test_fixtures import (
    CANONICAL_PATHS,
    DISCOVERY_PATH,
    UNIVERSE_PATH,
    admitted_state,
    in_memory_scope,
    pending_state,
)

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-family-discovery-readiness.py")
SPEC = importlib.util.spec_from_file_location("rmc011_family_discovery_readiness", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

DISCOVERY = json.loads(DISCOVERY_PATH.read_text(encoding="utf-8"))
UNIVERSE, SCOPE = pending_state()


def evidence(kind: str, index: int) -> dict:
    digit = format((index % 15) + 1, "x")
    head = digit * 40
    return {
        "kind": kind,
        "repository": "josuechavando350-png/nexus-engine",
        "workflow_name": f"NQC RMC-011 Family Evidence {index}",
        "run_id": 10_000 + index,
        "head_sha": head,
        "artifact_id": 20_000 + index,
        "artifact_name": f"rmc011-family-evidence-{head}-{index}",
        "artifact_digest": "sha256:" + digit * 64,
        "file": f"families/family-{index}/evidence.json",
        "sha256": format(index + 1, "064x"),
    }


def resolve_all(universe: dict) -> None:
    for index, row in enumerate(universe["families"], start=1):
        if row["real_source_path"] is None:
            row["status"] = "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
            kind = "EXHAUSTIVE_REJECTION"
        else:
            row["status"] = "AUTHENTICATED_REAL_SOURCE"
            kind = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = evidence(kind, index)


def validate_with_scope(discovery: dict, universe: dict, scope: dict = SCOPE) -> dict:
    with in_memory_scope(scope):
        return mod.validate_documents(discovery, universe)


class FamilyDiscoveryReadinessTests(unittest.TestCase):
    def test_explicit_pending_state_is_transport_ready_but_not_authenticated(self) -> None:
        result = validate_with_scope(
            copy.deepcopy(DISCOVERY),
            copy.deepcopy(UNIVERSE),
        )
        self.assertTrue(result["ready"])
        self.assertFalse(result["already_authenticated"])
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 13)
        self.assertEqual(result["unresolved_count"], 0)
        self.assertEqual(result["status"], "RMC011_FAMILY_DISCOVERY_TRANSPORT_READY")

    def test_all_thirteen_terminal_families_are_transport_ready(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        resolve_all(universe)
        result = validate_with_scope(copy.deepcopy(DISCOVERY), universe)
        self.assertTrue(result["ready"])
        self.assertFalse(result["already_authenticated"])
        self.assertEqual(result["resolved_count"], 13)
        self.assertEqual(result["unresolved_count"], 0)
        self.assertEqual(
            result["status"],
            "RMC011_FAMILY_DISCOVERY_TRANSPORT_READY",
        )
        self.assertEqual(
            {row["family"] for row in result["family_evidence"]},
            mod.EXPECTED_FAMILIES,
        )

    def test_partial_terminal_resolution_remains_blocked(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        row = universe["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED"
        row["terminally_resolved"] = False
        row["resolution_evidence"] = None
        result = validate_with_scope(copy.deepcopy(DISCOVERY), universe)
        self.assertFalse(result["ready"])
        self.assertEqual(result["resolved_count"], 12)
        self.assertEqual(result["unresolved_count"], 1)

    def test_terminal_evidence_kind_mismatch_fails(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        resolve_all(universe)
        row = universe["families"][0]
        row["resolution_evidence"]["kind"] = "EXHAUSTIVE_REJECTION"
        with self.assertRaises(ValueError):
            validate_with_scope(copy.deepcopy(DISCOVERY), universe)

    def test_discovery_family_set_mismatch_fails(self) -> None:
        discovery = copy.deepcopy(DISCOVERY)
        discovery["families"].pop()
        with self.assertRaises(ValueError):
            validate_with_scope(discovery, copy.deepcopy(UNIVERSE))

    def test_already_authenticated_discovery_is_not_reissued(self) -> None:
        universe, scope = admitted_state()
        discovery = copy.deepcopy(DISCOVERY)
        before = copy.deepcopy((discovery, universe, scope))
        result = validate_with_scope(discovery, universe, scope)
        self.assertFalse(result["ready"])
        self.assertTrue(result["already_authenticated"])
        self.assertTrue(result["authenticated_complete_claimed"])
        self.assertEqual(result["resolved_count"], 13)
        self.assertEqual(result["unresolved_count"], 0)
        self.assertFalse(result["d11_terminal_closed"])
        self.assertEqual(
            result["status"],
            "RMC011_FAMILY_DISCOVERY_ALREADY_AUTHENTICATED",
        )
        self.assertEqual(validate_with_scope(discovery, universe, scope), result)
        self.assertEqual((discovery, universe, scope), before)

    def test_live_canonical_discovery_is_not_reissued(self) -> None:
        result = mod.validate_documents(
            json.loads(DISCOVERY_PATH.read_text(encoding="utf-8")),
            json.loads(UNIVERSE_PATH.read_text(encoding="utf-8")),
        )
        self.assertFalse(result["ready"])
        self.assertTrue(result["already_authenticated"])
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 13)
        self.assertEqual(result["unresolved_count"], 0)
        self.assertEqual(result["status"], "RMC011_FAMILY_DISCOVERY_ALREADY_AUTHENTICATED")
        self.assertFalse(result["d11_terminal_closed"])

    def test_admitted_universe_rejects_pending_scope(self) -> None:
        universe, _ = admitted_state()
        _, scope = pending_state()
        with self.assertRaisesRegex(ValueError, "capital_source_universe_complete=true in scope"):
            validate_with_scope(copy.deepcopy(DISCOVERY), universe, scope)

    def test_pending_universe_rejects_admitted_scope(self) -> None:
        universe, _ = pending_state()
        _, scope = admitted_state()
        with self.assertRaisesRegex(
            ValueError, "incomplete source universe cannot claim capital_source_universe_complete"
        ):
            validate_with_scope(copy.deepcopy(DISCOVERY), universe, scope)

    def test_both_state_fixtures_never_change_canonical_bytes(self) -> None:
        before = {path: path.read_bytes() for path in CANONICAL_PATHS}
        for factory in (pending_state, admitted_state):
            universe, scope = factory()
            validate_with_scope(copy.deepcopy(DISCOVERY), universe, scope)
        self.assertEqual({path: path.read_bytes() for path in CANONICAL_PATHS}, before)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-family-discovery-readiness.py")
SPEC = importlib.util.spec_from_file_location("rmc011_family_discovery_readiness", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

DISCOVERY = json.loads(
    Path("ci/nqc-census/rmc011-capital-family-discovery.json").read_text()
)
UNIVERSE = json.loads(
    Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text()
)


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


def validate_with_complete_scope(discovery: dict, universe: dict) -> dict:
    # Do not mutate the real canonical scope file to exercise hypothetical
    # future completeness: inject a temporary IN-MEMORY scope only.
    scope_path = Path("ci/nqc-census/capital-census-scope.json")
    original_read = Path.read_text

    def mocked_read(path: Path, *args, **kwargs) -> str:
        raw = original_read(path, *args, **kwargs)
        if path == scope_path:
            scope = json.loads(raw)
            assert scope["claims"]["capital_source_universe_complete"] is False
            scope["claims"]["capital_source_universe_complete"] = True
            return json.dumps(scope)
        return raw

    with patch.object(Path, "read_text", new=mocked_read):
        return mod.validate_documents(discovery, universe)


class FamilyDiscoveryReadinessTests(unittest.TestCase):
    def test_current_universe_is_blocked_without_terminal_family_evidence(self) -> None:
        result = mod.validate_documents(
            copy.deepcopy(DISCOVERY),
            copy.deepcopy(UNIVERSE),
        )
        self.assertFalse(result["ready"])
        self.assertFalse(result["already_authenticated"])
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["resolved_count"], 7)
        self.assertEqual(result["unresolved_count"], 6)
        self.assertEqual(result["status"], "RMC011_FAMILY_DISCOVERY_BLOCKED")

    def test_all_thirteen_terminal_families_are_transport_ready(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        resolve_all(universe)
        result = mod.validate_documents(copy.deepcopy(DISCOVERY), universe)
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
        row["status"] = "AUTHENTICATED_REAL_SOURCE"
        row["terminally_resolved"] = True
        row["resolution_evidence"] = evidence("AUTHENTICATED_REAL_SOURCE", 1)
        result = mod.validate_documents(copy.deepcopy(DISCOVERY), universe)
        self.assertFalse(result["ready"])
        self.assertEqual(result["resolved_count"], 8)
        self.assertEqual(result["unresolved_count"], 5)

    def test_terminal_evidence_kind_mismatch_fails(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        resolve_all(universe)
        row = universe["families"][0]
        row["resolution_evidence"]["kind"] = "EXHAUSTIVE_REJECTION"
        with self.assertRaises(ValueError):
            mod.validate_documents(copy.deepcopy(DISCOVERY), universe)

    def test_discovery_family_set_mismatch_fails(self) -> None:
        discovery = copy.deepcopy(DISCOVERY)
        discovery["families"].pop()
        with self.assertRaises(ValueError):
            mod.validate_documents(discovery, copy.deepcopy(UNIVERSE))

    def test_already_authenticated_discovery_is_not_reissued(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        resolve_all(universe)
        discovery_evidence = evidence("AUTHENTICATED_DISCOVERY", 99)
        universe["family_universe_discovery"] = {
            "status": "AUTHENTICATED_COMPLETE",
            "evidence": discovery_evidence,
            "terminal_requirement": "AUTHENTICATED_COMPLETE",
        }
        universe["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        universe["terminal_claim_allowed"] = True
        result = validate_with_complete_scope(copy.deepcopy(DISCOVERY), universe)
        self.assertFalse(result["ready"])
        self.assertTrue(result["already_authenticated"])
        self.assertEqual(
            result["status"],
            "RMC011_FAMILY_DISCOVERY_ALREADY_AUTHENTICATED",
        )


if __name__ == "__main__":
    unittest.main()

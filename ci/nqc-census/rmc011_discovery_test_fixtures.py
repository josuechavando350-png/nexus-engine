"""Isolated discovery states for local contract tests, never evidence authority.

Each factory chooses an explicit state independently of the current canonical
admission. Only reads are intercepted; canonical documents are never rewritten.
"""
from __future__ import annotations

import copy
import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path("ci/nqc-census")
UNIVERSE_PATH = ROOT / "rmc011-capital-source-universe.json"
SCOPE_PATH = ROOT / "capital-census-scope.json"
DISCOVERY_PATH = ROOT / "rmc011-capital-family-discovery.json"
CANONICAL_PATHS = (UNIVERSE_PATH, SCOPE_PATH, DISCOVERY_PATH)

# These independent expectations must not follow the claims under test.
READINESS_ONLY_NONCLAIMS = (
    "real_source_certification",
    "systemwide_zero_own_capital_capacity",
    "profitability",
    "shadow_execution",
    "canary",
    "real_pnl",
    "global_capital_source_completeness",
    "repayment_cashflow_sufficiency",
    "terminal_capital_census_closed",
    "actionability",
)

_UNIVERSE_TEMPLATE = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
_SCOPE_TEMPLATE = json.loads(SCOPE_PATH.read_text(encoding="utf-8"))
_ORIGINAL_READ_TEXT = Path.read_text


def pending_state() -> tuple[dict, dict]:
    universe = copy.deepcopy(_UNIVERSE_TEMPLATE)
    universe["family_universe_discovery"] = {
        "status": "NOT_CERTIFIED",
        "evidence": None,
        "terminal_requirement": "AUTHENTICATED_COMPLETE",
    }
    universe["status"] = "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
    universe["terminal_claim_allowed"] = False
    universe["d11_terminal_closed"] = False
    scope = copy.deepcopy(_SCOPE_TEMPLATE)
    scope["claims"]["capital_source_universe_complete"] = False
    for claim in READINESS_ONLY_NONCLAIMS:
        scope["claims"][claim] = False
    return universe, scope


def admitted_state() -> tuple[dict, dict]:
    universe, scope = pending_state()
    head = "a" * 40
    universe["family_universe_discovery"] = {
        "status": "AUTHENTICATED_COMPLETE",
        "terminal_requirement": "AUTHENTICATED_COMPLETE",
        "evidence": {
            "kind": "AUTHENTICATED_DISCOVERY",
            "repository": "josuechavando350-png/nexus-engine",
            "workflow_name": "NQC RMC-011 Family Discovery Evidence",
            "run_id": 55555,
            "head_sha": head,
            "artifact_id": 66666,
            "artifact_name": f"rmc011-family-discovery-{head}-55555-1",
            "artifact_digest": "sha256:" + "b" * 64,
            "file": "discovery-evidence.json",
            "sha256": "c" * 64,
        },
    }
    universe["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
    universe["terminal_claim_allowed"] = True
    scope["claims"]["capital_source_universe_complete"] = True
    return universe, scope


@contextmanager
def in_memory_scope(scope: dict):
    """Supply the chosen scope without deriving expectations from live bytes."""
    encoded = json.dumps(copy.deepcopy(scope))
    scope_path = SCOPE_PATH.resolve()

    def scoped_read_text(path: Path, *args, **kwargs) -> str:
        if path.resolve() == scope_path:
            return encoded
        return _ORIGINAL_READ_TEXT(path, *args, **kwargs)

    with patch.object(Path, "read_text", new=scoped_read_text):
        yield

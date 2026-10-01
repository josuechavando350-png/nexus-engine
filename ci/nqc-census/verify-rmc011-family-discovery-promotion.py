#!/usr/bin/env python3
"""Validate promotion wiring for RMC-011 authenticated family discovery evidence."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path("ci/nqc-census")
UNIVERSE_PATH = ROOT / "rmc011-capital-source-universe.json"
UNIVERSE_VERIFIER = ROOT / "verify-rmc011-capital-source-universe.py"

EXPECTED_REPOSITORY = "josuechavando350-png/nexus-engine"
EXPECTED_WORKFLOW = "NQC RMC-011 Family Discovery Evidence"
EXPECTED_ARTIFACT_PREFIX = "rmc011-family-discovery-"
EXPECTED_FILE = "discovery-evidence.json"
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class PromotionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PromotionError(message)


def load_universe_verifier():
    spec = importlib.util.spec_from_file_location(
        "rmc011_source_universe",
        UNIVERSE_VERIFIER,
    )
    require(spec is not None and spec.loader is not None, "cannot load source-universe verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_document(doc: dict) -> dict:
    universe_mod = load_universe_verifier()
    universe_mod.validate_document(doc)

    discovery = doc.get("family_universe_discovery")
    require(isinstance(discovery, dict), "family_universe_discovery must be an object")
    status = discovery.get("status")

    if status == "NOT_CERTIFIED":
        require(discovery.get("evidence") is None, "uncertified discovery cannot carry evidence")
        return {
            "promotion_state": "PENDING",
            "authenticated": False,
        }

    require(status == "AUTHENTICATED_COMPLETE", "unsupported family discovery status")
    rows = doc.get("families")
    require(isinstance(rows, list), "source-universe families must be an array")
    require(rows, "source-universe families cannot be empty")
    require(
        all(isinstance(row, dict) and row.get("terminally_resolved") is True for row in rows),
        "authenticated family discovery requires every family terminally resolved",
    )

    evidence = discovery.get("evidence")
    require(isinstance(evidence, dict), "authenticated family discovery evidence missing")
    require(evidence.get("kind") == "AUTHENTICATED_DISCOVERY", "discovery evidence kind differs")
    require(evidence.get("repository") == EXPECTED_REPOSITORY, "discovery evidence repository differs")
    require(evidence.get("workflow_name") == EXPECTED_WORKFLOW, "discovery evidence workflow differs")

    run_id = evidence.get("run_id")
    head_sha = evidence.get("head_sha")
    artifact_id = evidence.get("artifact_id")
    artifact_name = evidence.get("artifact_name")
    artifact_digest = evidence.get("artifact_digest")
    evidence_file = evidence.get("file")
    sha256 = evidence.get("sha256")

    require(isinstance(run_id, int) and not isinstance(run_id, bool) and run_id > 0, "discovery run_id invalid")
    require(isinstance(head_sha, str) and GIT_SHA_RE.fullmatch(head_sha) is not None, "discovery head_sha invalid")
    require(isinstance(artifact_id, int) and not isinstance(artifact_id, bool) and artifact_id > 0, "discovery artifact_id invalid")
    require(
        isinstance(artifact_name, str)
        and artifact_name.startswith(EXPECTED_ARTIFACT_PREFIX)
        and head_sha in artifact_name,
        "discovery artifact_name does not bind expected workflow/head",
    )
    require(
        isinstance(artifact_digest, str)
        and ARTIFACT_DIGEST_RE.fullmatch(artifact_digest) is not None,
        "discovery artifact_digest invalid",
    )
    require(evidence_file == EXPECTED_FILE, "discovery evidence file must be discovery-evidence.json")
    require(isinstance(sha256, str) and SHA256_RE.fullmatch(sha256) is not None, "discovery evidence sha256 invalid")

    return {
        "promotion_state": "AUTHENTICATED_REFERENCE_DECLARED",
        "authenticated": True,
        "run_id": run_id,
        "head_sha": head_sha,
        "artifact_id": artifact_id,
        "artifact_name": artifact_name,
        "artifact_digest": artifact_digest,
        "file": evidence_file,
        "sha256": sha256,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else UNIVERSE_PATH
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, PromotionError, ValueError) as exc:
        print(f"RMC011_FAMILY_DISCOVERY_PROMOTION_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_FAMILY_DISCOVERY_PROMOTION_PASS "
        f"state={result['promotion_state']} "
        f"authenticated={str(result['authenticated']).lower()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

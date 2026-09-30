#!/usr/bin/env python3
"""Validate promotion wiring for the nine bounded RMC-011 rejection families."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BOUNDED_FAMILIES = {
    "EXTERNAL_GAS_CREDIT",
    "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT",
    "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
EXPECTED_REPOSITORY = "josuechavando350-png/nexus-engine"
EXPECTED_WORKFLOW = "NQC RMC-011 Bounded Family Rejection Evidence"
EXPECTED_ARTIFACT_PREFIX = "rmc011-bounded-family-rejections-"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class PromotionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PromotionError(message)


def validate_document(doc: dict) -> dict:
    require(doc.get("stage") == "RMC-011", "source-universe stage must equal RMC-011")
    rows = doc.get("families")
    require(isinstance(rows, list), "source-universe families must be an array")
    by_id = {row.get("id"): row for row in rows if isinstance(row, dict)}
    require(BOUNDED_FAMILIES <= set(by_id), "bounded rejection family set is incomplete")

    promoted = [
        family
        for family in sorted(BOUNDED_FAMILIES)
        if by_id[family].get("status")
        == "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
    ]

    if not promoted:
        for family in BOUNDED_FAMILIES:
            require(
                by_id[family].get("terminally_resolved") is False,
                f"{family}: pending bounded family cannot be terminally resolved",
            )
        return {
            "promotion_state": "PENDING",
            "family_count": len(BOUNDED_FAMILIES),
            "promoted_count": 0,
        }

    require(
        set(promoted) == BOUNDED_FAMILIES,
        "bounded family promotion must be atomic across all nine families",
    )

    shared = None
    sha256s: set[str] = set()
    for family in sorted(BOUNDED_FAMILIES):
        row = by_id[family]
        require(row.get("terminally_resolved") is True, f"{family}: promoted family is unresolved")
        require(row.get("real_source_path") is None, f"{family}: exhaustive rejection cannot claim a real source path")
        evidence = row.get("resolution_evidence")
        require(isinstance(evidence, dict), f"{family}: resolution_evidence must be an object")
        require(evidence.get("kind") == "EXHAUSTIVE_REJECTION", f"{family}: wrong evidence kind")
        require(evidence.get("repository") == EXPECTED_REPOSITORY, f"{family}: wrong repository")
        require(evidence.get("workflow_name") == EXPECTED_WORKFLOW, f"{family}: wrong workflow")

        run_id = evidence.get("run_id")
        artifact_id = evidence.get("artifact_id")
        require(isinstance(run_id, int) and not isinstance(run_id, bool) and run_id > 0, f"{family}: invalid run_id")
        require(isinstance(artifact_id, int) and not isinstance(artifact_id, bool) and artifact_id > 0, f"{family}: invalid artifact_id")

        head_sha = evidence.get("head_sha")
        require(isinstance(head_sha, str) and HEX40.fullmatch(head_sha) is not None, f"{family}: invalid head_sha")
        artifact_name = evidence.get("artifact_name")
        require(
            isinstance(artifact_name, str)
            and artifact_name.startswith(EXPECTED_ARTIFACT_PREFIX)
            and head_sha in artifact_name,
            f"{family}: artifact_name does not bind expected workflow/head",
        )
        artifact_digest = evidence.get("artifact_digest")
        require(
            isinstance(artifact_digest, str)
            and ARTIFACT_DIGEST.fullmatch(artifact_digest) is not None,
            f"{family}: invalid artifact_digest",
        )

        expected_file = f"families/{family}/evidence.json"
        require(evidence.get("file") == expected_file, f"{family}: wrong per-family evidence file")
        file_sha = evidence.get("sha256")
        require(isinstance(file_sha, str) and HEX64.fullmatch(file_sha) is not None, f"{family}: invalid file sha256")
        require(file_sha not in sha256s, f"{family}: duplicate per-family evidence sha256")
        sha256s.add(file_sha)

        current = (run_id, head_sha, artifact_id, artifact_name, artifact_digest)
        if shared is None:
            shared = current
        else:
            require(current == shared, f"{family}: bounded promotion mixes runs/artifacts")

    return {
        "promotion_state": "AUTHENTICATED_REFERENCES_DECLARED",
        "family_count": len(BOUNDED_FAMILIES),
        "promoted_count": len(promoted),
        "shared_run_id": shared[0],
        "shared_head_sha": shared[1],
        "shared_artifact_id": shared[2],
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-capital-source-universe.json"
    )
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, PromotionError) as exc:
        print(f"RMC011_BOUNDED_FAMILY_PROMOTION_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_BOUNDED_FAMILY_PROMOTION_PASS "
        f"state={result['promotion_state']} "
        f"promoted={result['promoted_count']}/{result['family_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

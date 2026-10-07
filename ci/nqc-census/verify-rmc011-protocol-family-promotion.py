#!/usr/bin/env python3
"""Validate atomic promotion of the four RMC-011 protocol-native families."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FAMILIES = {
    "AAVE_V3_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN",
    "UNISWAP_V3_FLASH",
}
EXPECTED_REPOSITORY = "josuechavando350-png/nexus-engine"
EXPECTED_WORKFLOW = "NQC RMC-011 Real Source Certification"
EXPECTED_ARTIFACT_PREFIX = "rmc011-real-source-certification-"
TERMINAL = {
    "AUTHENTICATED_REAL_SOURCE": "AUTHENTICATED_REAL_SOURCE",
    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE": "EXHAUSTIVE_REJECTION",
}
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class PromotionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PromotionError(message)


def validate_document(doc: dict) -> dict:
    rows = doc.get("families")
    require(isinstance(rows, list), "source-universe families must be an array")
    by_id = {row.get("id"): row for row in rows if isinstance(row, dict)}
    require(FAMILIES <= set(by_id), "protocol family set is incomplete")

    resolved = {
        family for family in FAMILIES
        if by_id[family].get("status") in TERMINAL
    }
    if not resolved:
        for family in FAMILIES:
            require(
                by_id[family].get("terminally_resolved") is False,
                f"{family}: pending family carries terminal flag",
            )
        return {"promotion_state": "PENDING", "resolved_count": 0}

    require(
        resolved == FAMILIES,
        "protocol-family promotion must be atomic across all four families",
    )

    shared = None
    file_hashes: set[str] = set()
    outcomes = {}
    for family in sorted(FAMILIES):
        row = by_id[family]
        status = row.get("status")
        expected_kind = TERMINAL[status]
        require(row.get("terminally_resolved") is True, f"{family}: terminal flag missing")
        if status == "AUTHENTICATED_REAL_SOURCE":
            require(
                isinstance(row.get("real_source_path"), str) and row["real_source_path"],
                f"{family}: real-source promotion requires source path",
            )
        else:
            require(row.get("real_source_path") is None, f"{family}: rejection claims real source")

        evidence = row.get("resolution_evidence")
        require(isinstance(evidence, dict), f"{family}: resolution_evidence missing")
        require(evidence.get("kind") == expected_kind, f"{family}: evidence kind differs")
        require(evidence.get("repository") == EXPECTED_REPOSITORY, f"{family}: repository differs")
        require(evidence.get("workflow_name") == EXPECTED_WORKFLOW, f"{family}: workflow differs")

        run_id = evidence.get("run_id")
        artifact_id = evidence.get("artifact_id")
        head_sha = evidence.get("head_sha")
        artifact_name = evidence.get("artifact_name")
        artifact_digest = evidence.get("artifact_digest")
        file_path = evidence.get("file")
        file_sha = evidence.get("sha256")

        require(isinstance(run_id, int) and not isinstance(run_id, bool) and run_id > 0, f"{family}: run_id invalid")
        require(isinstance(artifact_id, int) and not isinstance(artifact_id, bool) and artifact_id > 0, f"{family}: artifact_id invalid")
        require(isinstance(head_sha, str) and HEX40.fullmatch(head_sha) is not None, f"{family}: head invalid")
        require(
            isinstance(artifact_name, str)
            and artifact_name.startswith(EXPECTED_ARTIFACT_PREFIX)
            and head_sha in artifact_name,
            f"{family}: artifact name does not bind exact head",
        )
        require(
            isinstance(artifact_digest, str)
            and ARTIFACT_DIGEST.fullmatch(artifact_digest) is not None,
            f"{family}: artifact digest invalid",
        )
        require(
            file_path == f"protocol-family-evidence/families/{family}/evidence.json",
            f"{family}: evidence path differs",
        )
        require(isinstance(file_sha, str) and HEX64.fullmatch(file_sha) is not None, f"{family}: file sha invalid")
        require(file_sha not in file_hashes, f"{family}: duplicate evidence sha")
        file_hashes.add(file_sha)

        transport = (run_id, head_sha, artifact_id, artifact_name, artifact_digest)
        if shared is None:
            shared = transport
        else:
            require(transport == shared, f"{family}: promotion mixes transports")
        outcomes[family] = expected_kind

    return {
        "promotion_state": "TERMINAL_PROTOCOL_REFERENCES_DECLARED",
        "resolved_count": 4,
        "shared_run_id": shared[0],
        "outcomes": outcomes,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-capital-source-universe.json"
    )
    try:
        result = validate_document(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, PromotionError) as exc:
        print(f"RMC011_PROTOCOL_FAMILY_PROMOTION_INVALID {exc}", file=sys.stderr)
        return 1
    print(
        "RMC011_PROTOCOL_FAMILY_PROMOTION_PASS "
        f"state={result['promotion_state']} resolved={result['resolved_count']}/4"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

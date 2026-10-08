#!/usr/bin/env python3
"""Validate source-universe promotion for RMC-011 debt-family rejection evidence."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEBT_FAMILIES = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
EXPECTED_REPOSITORY = "josuechavando350-png/nexus-engine"
EXPECTED_WORKFLOW = "NQC RMC-011 Real Source Certification"
EXPECTED_ARTIFACT_PREFIX = "rmc011-real-source-certification-"
EXPECTED_REAL_SOURCE_PATH = "nqc-census/crates/nqc-census-capital/src/external_debt.rs"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class PromotionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PromotionError(message)


def validate_document(doc: dict) -> dict:
    require(
        type(doc.get("schema_version")) is int and doc["schema_version"] == 2,
        "source-universe schema must be exactly version 2",
    )
    require(doc.get("stage") == "RMC-011", "source-universe stage must equal RMC-011")
    require(doc.get("d11_terminal_closed") is False, "this helper cannot close terminal D11")
    rows = doc.get("families")
    require(isinstance(rows, list), "source-universe families must be an array")
    require(all(isinstance(row, dict) for row in rows), "malformed source-universe family row")
    family_ids = [row.get("id") for row in rows]
    require(
        all(isinstance(name, str) and name for name in family_ids)
        and len(family_ids) == len(set(family_ids)),
        "duplicate, missing or invalid source-universe family identity",
    )
    by_id = {row["id"]: row for row in rows}
    require(DEBT_FAMILIES <= set(by_id), "debt family set is incomplete")

    rejected = {
        family
        for family in DEBT_FAMILIES
        if by_id[family].get("status")
        == "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
    }
    authenticated = {
        family
        for family in DEBT_FAMILIES
        if by_id[family].get("status") == "AUTHENTICATED_REAL_SOURCE"
    }

    if not rejected and not authenticated:
        for family in DEBT_FAMILIES:
            require(
                by_id[family].get("terminally_resolved") is False,
                f"{family}: unresolved debt family has terminal flag",
            )
        return {"promotion_state": "PENDING", "rejected_count": 0, "authenticated_count": 0}

    if authenticated:
        require(
            authenticated == DEBT_FAMILIES and not rejected,
            "debt families cannot mix authenticated-real-source and rejection promotion",
        )
        # Historical bug: a pair of bare status strings previously reached the
        # AUTHENTICATED_REAL_SOURCE_PATH result without ANY capital witness.
        # Even after this syntax gate passes, GitHub archive bytes must still
        # be authenticated independently by the enclosing source workflow.
        shared = None
        file_hashes: set[str] = set()
        for family in sorted(DEBT_FAMILIES):
            row = by_id[family]
            require(row.get("terminally_resolved") is True,
                    f"{family}: authenticated source missing terminal flag")
            require(row.get("real_source_path") == EXPECTED_REAL_SOURCE_PATH,
                    f"{family}: canonical real-source implementation missing")
            evidence = row.get("resolution_evidence")
            require(isinstance(evidence, dict),
                    f"{family}: authenticated real-source evidence missing")
            require(evidence.get("kind") == "AUTHENTICATED_REAL_SOURCE",
                    f"{family}: real-source evidence kind differs")
            require(evidence.get("repository") == EXPECTED_REPOSITORY,
                    f"{family}: real-source repository differs")
            require(evidence.get("workflow_name") == EXPECTED_WORKFLOW,
                    f"{family}: real-source workflow differs")
            run_id = evidence.get("run_id")
            artifact_id = evidence.get("artifact_id")
            require(type(run_id) is int and run_id > 0,
                    f"{family}: invalid real-source run ID")
            require(type(artifact_id) is int and artifact_id > 0,
                    f"{family}: invalid real-source artifact ID")
            head_sha = evidence.get("head_sha")
            require(isinstance(head_sha, str) and HEX40.fullmatch(head_sha),
                    f"{family}: invalid real-source producing head")
            name = evidence.get("artifact_name")
            require(isinstance(name, str)
                    and name.startswith(EXPECTED_ARTIFACT_PREFIX)
                    and head_sha in name,
                    f"{family}: real-source artifact name/head mismatch")
            artifact_digest = evidence.get("artifact_digest")
            require(isinstance(artifact_digest, str)
                    and ARTIFACT_DIGEST.fullmatch(artifact_digest)
                    and artifact_digest != "sha256:" + "0" * 64,
                    f"{family}: missing real-source artifact SHA-256")
            require(
                evidence.get("file") ==
                f"debt-family-evidence/families/{family}/evidence.json",
                f"{family}: real-source evidence member path differs",
            )
            file_hash = evidence.get("sha256")
            require(isinstance(file_hash, str) and HEX64.fullmatch(file_hash)
                    and file_hash != "0" * 64 and file_hash not in file_hashes,
                    f"{family}: zero or duplicated real-source file SHA-256")
            file_hashes.add(file_hash)
            transport = (run_id, head_sha, artifact_id, name, artifact_digest)
            if shared is None:
                shared = transport
            else:
                require(shared == transport,
                        f"{family}: real-source evidence mixes runs/artifacts")
        return {
            "promotion_state": "AUTHENTICATED_REAL_SOURCE_REFERENCES_DECLARED",
            "rejected_count": 0,
            "authenticated_count": len(authenticated),
            "shared_run_id": shared[0],
            "shared_head_sha": shared[1],
            "shared_artifact_id": shared[2],
            "independent_artifact_authentication_complete": False,
            "d11_terminal_closed": False,
        }

    require(
        rejected == DEBT_FAMILIES,
        "debt-family exhaustive rejection must be atomic across both families",
    )

    shared = None
    file_hashes: set[str] = set()
    for family in sorted(DEBT_FAMILIES):
        row = by_id[family]
        require(row.get("terminally_resolved") is True, f"{family}: rejected family unresolved")
        require(row.get("real_source_path") is None, f"{family}: rejected family claims real source")
        evidence = row.get("resolution_evidence")
        require(isinstance(evidence, dict), f"{family}: resolution_evidence missing")
        require(evidence.get("kind") == "EXHAUSTIVE_REJECTION", f"{family}: evidence kind differs")
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
        require(isinstance(head_sha, str) and HEX40.fullmatch(head_sha) is not None, f"{family}: head_sha invalid")
        require(
            isinstance(artifact_name, str)
            and artifact_name.startswith(EXPECTED_ARTIFACT_PREFIX)
            and head_sha in artifact_name,
            f"{family}: artifact_name does not bind exact head",
        )
        require(
            isinstance(artifact_digest, str)
            and ARTIFACT_DIGEST.fullmatch(artifact_digest) is not None
            and artifact_digest != "sha256:" + "0" * 64,
            f"{family}: artifact_digest invalid",
        )
        require(
            file_path == f"debt-family-evidence/families/{family}/evidence.json",
            f"{family}: per-family evidence path differs",
        )
        require(
            isinstance(file_sha, str) and HEX64.fullmatch(file_sha) is not None
            and file_sha != "0" * 64,
            f"{family}: missing or zero file sha256",
        )
        require(file_sha not in file_hashes, f"{family}: duplicate family evidence sha256")
        file_hashes.add(file_sha)

        transport = (run_id, head_sha, artifact_id, artifact_name, artifact_digest)
        if shared is None:
            shared = transport
        else:
            require(transport == shared, f"{family}: debt promotion mixes transports")

    return {
        "promotion_state": "EXHAUSTIVE_REJECTION_REFERENCES_DECLARED",
        "rejected_count": len(rejected),
        "authenticated_count": 0,
        "shared_run_id": shared[0],
        "shared_head_sha": shared[1],
        "shared_artifact_id": shared[2],
        "independent_artifact_authentication_complete": False,
        "d11_terminal_closed": False,
    }


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(
        "ci/nqc-census/rmc011-capital-source-universe.json"
    )
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        result = validate_document(doc)
    except (OSError, json.JSONDecodeError, PromotionError) as exc:
        print(f"RMC011_DEBT_FAMILY_PROMOTION_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "RMC011_DEBT_FAMILY_PROMOTION_PASS "
        f"state={result['promotion_state']} rejected={result['rejected_count']} "
        f"authenticated={result['authenticated_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

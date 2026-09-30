#!/usr/bin/env python3
"""Fail-closed semantic coherence verifier for the RMC-011 upstream authority set."""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import sys
from typing import Any


class CoherenceError(RuntimeError):
    pass


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except Exception as exc:
        raise CoherenceError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CoherenceError(f"{path}: JSON root must be an object")
    return value


def fail(condition: bool, message: str) -> None:
    if not condition:
        raise CoherenceError(message)


def normalized_hash(value: Any, field: str) -> str:
    fail(isinstance(value, str), f"{field}: hash must be a string")
    text = value.lower()
    if text.startswith("0x"):
        text = text[2:]
    fail(len(text) == 64 and all(c in "0123456789abcdef" for c in text),
         f"{field}: expected 32-byte hex")
    return text


def normalized_git(value: Any, field: str) -> str:
    fail(isinstance(value, str), f"{field}: git id must be a string")
    text = value.lower()
    fail(len(text) == 40 and all(c in "0123456789abcdef" for c in text),
         f"{field}: expected 40-byte git hex")
    return text


def integer(value: Any, field: str) -> int:
    fail(isinstance(value, int) and not isinstance(value, bool) and value >= 0,
         f"{field}: expected non-negative integer")
    return value


def canonical_anchor(value: Any, field: str) -> dict[str, Any]:
    fail(isinstance(value, dict), f"{field}: anchor must be an object")
    required = {
        "chain_id",
        "genesis_hash",
        "fork_lineage",
        "block_number",
        "block_hash",
        "parent_hash",
        "timestamp",
        "state_root",
    }
    fail(set(value) == required, f"{field}: exact anchor fields required; got {sorted(value)}")
    return {
        "chain_id": integer(value["chain_id"], f"{field}.chain_id"),
        "genesis_hash": normalized_hash(value["genesis_hash"], f"{field}.genesis_hash"),
        "fork_lineage": normalized_hash(value["fork_lineage"], f"{field}.fork_lineage"),
        "block_number": integer(value["block_number"], f"{field}.block_number"),
        "block_hash": normalized_hash(value["block_hash"], f"{field}.block_hash"),
        "parent_hash": normalized_hash(value["parent_hash"], f"{field}.parent_hash"),
        "timestamp": integer(value["timestamp"], f"{field}.timestamp"),
        "state_root": normalized_hash(value["state_root"], f"{field}.state_root"),
    }


def discovery_anchor(doc: dict[str, Any], field: str) -> dict[str, Any]:
    chain = doc.get("chain_domain")
    anchor = doc.get("observation_anchor")
    fail(isinstance(chain, dict), f"{field}.chain_domain missing")
    fail(isinstance(anchor, dict), f"{field}.observation_anchor missing")
    return canonical_anchor(
        {
            "chain_id": chain.get("chain_id"),
            "genesis_hash": chain.get("genesis_hash"),
            "fork_lineage": chain.get("fork_lineage"),
            "block_number": anchor.get("number"),
            "block_hash": anchor.get("hash"),
            "parent_hash": anchor.get("parent_hash"),
            "timestamp": anchor.get("timestamp"),
            "state_root": anchor.get("state_root"),
        },
        field,
    )


def rfc3339_utc(timestamp: int) -> str:
    return dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def descriptor(inputs: dict[str, Any], key: str) -> dict[str, Any]:
    value = inputs.get(key)
    fail(isinstance(value, dict), f"inputs.{key}: missing descriptor")
    return value


def exact_d10_source(cert: dict[str, Any], role: str, expected: dict[str, Any]) -> None:
    sources = cert.get("sources")
    fail(isinstance(sources, list), "RMC-010 certification sources missing")
    rows = [row for row in sources if isinstance(row, dict) and row.get("role") == role]
    fail(len(rows) == 1, f"RMC-010 certification must contain exactly one {role} source")
    row = rows[0]
    checks = {
        "workflow_run_id": expected["run_id"],
        "artifact_id": expected["artifact_id"],
        "artifact": expected["artifact_name"],
        "code_commit": expected["head_sha"],
        "artifact_digest": expected["artifact_digest"],
    }
    for key, expected_value in checks.items():
        fail(row.get(key) == expected_value,
             f"RMC-010 {role}.{key}={row.get(key)!r} != D11 transport {expected_value!r}")


def verify(inputs_path: pathlib.Path, lock_path: pathlib.Path, root: pathlib.Path) -> None:
    inputs = load_json(inputs_path)
    lock = load_json(lock_path)
    fail(inputs.get("schema_version") == 3, "RMC-011 real-source inputs schema must be 3")
    fail(lock.get("schema_version") == 1, "RMC-011 authority lock schema must be 1")

    stages = lock.get("stages")
    fail(isinstance(stages, list), "authority lock stages missing")
    fail(len(stages) == 5, "authority lock must contain exactly five stages")
    by_stage: dict[str, dict[str, Any]] = {}
    for row in stages:
        fail(isinstance(row, dict), "authority lock stage row must be an object")
        stage = row.get("stage")
        fail(stage in {"RMC-006", "RMC-007", "RMC-008", "RMC-009", "RMC-010"},
             f"unexpected authority stage {stage!r}")
        fail(stage not in by_stage, f"duplicate authority stage {stage}")
        by_stage[stage] = row
    fail(set(by_stage) == {"RMC-006", "RMC-007", "RMC-008", "RMC-009", "RMC-010"},
         "authority lock stage set is incomplete")

    anchors = {
        stage: canonical_anchor(row.get("observation_anchor"), f"lock.{stage}.observation_anchor")
        for stage, row in by_stage.items()
    }
    target = anchors["RMC-006"]
    for stage, anchor in anchors.items():
        fail(anchor == target, f"{stage} is not pinned to the exact D11 observation anchor")

    # Transport code identities are independently verified against GitHub by the workflow.
    # Recheck descriptor-to-lock identity here before semantic anchor inspection.
    for key, stage in [("d06", "RMC-006"), ("d07", "RMC-007"), ("d08", "RMC-008"),
                       ("d09", "RMC-009"), ("d10", "RMC-010")]:
        desc = descriptor(inputs, key)
        fail(normalized_git(desc.get("head_sha"), f"inputs.{key}.head_sha") ==
             normalized_git(by_stage[stage].get("code_commit"), f"lock.{stage}.code_commit"),
             f"{stage}: D11 transport head differs from authority lock")

    # D06: full chain-domain + header truth comes from the exact discovery-run bytes.
    d06 = descriptor(inputs, "d06")
    d06_doc = load_json(root / "d06-raw" / d06["anchor_file"])
    fail(d06_doc.get("status") == "RMC_006_PASS_CANDIDATE", "RMC-006 discovery run is not pass-candidate")
    fail(discovery_anchor(d06_doc, "RMC-006.discovery") == target,
         "RMC-006 discovery anchor differs from D11 authority anchor")
    fail(d06_doc.get("generated_at") == rfc3339_utc(target["timestamp"]),
         "RMC-006 generated_at is not derived from the authority block timestamp")

    # D07: same full shape as D06, independently acquired by its own discovery pipeline.
    d07 = descriptor(inputs, "d07")
    d07_doc = load_json(root / "d07-raw" / d07["anchor_file"])
    fail(d07_doc.get("status") == "RMC_007_PASS_CANDIDATE", "RMC-007 discovery run is not pass-candidate")
    fail(discovery_anchor(d07_doc, "RMC-007.discovery") == target,
         "RMC-007 discovery anchor differs from D11 authority anchor")
    fail(d07_doc.get("generated_at") == rfc3339_utc(target["timestamp"]),
         "RMC-007 generated_at is not derived from the authority block timestamp")

    # D08 evidence manifest directly carries the complete StateAnchor.
    d08 = descriptor(inputs, "d08")
    d08_doc = load_json(root / "d08-raw" / d08["authority_file"])
    fail(canonical_anchor(d08_doc.get("observation_anchor"), "RMC-008.observation_anchor") == target,
         "RMC-008 observation anchor differs from D11 authority anchor")
    fail(d08_doc.get("generated_at") == rfc3339_utc(target["timestamp"]),
         "RMC-008 generated_at is not derived from the authority block timestamp")

    # D09 summary intentionally stores only number/hash/timestamp. Full header identity
    # remains inherited from the same authority lock and upstream snapshot.
    d09 = descriptor(inputs, "d09")
    d09_doc = load_json(root / "d09-raw" / d09["account_summary"])
    fail(d09_doc.get("status") == "RMC_009_PASS_CANDIDATE", "RMC-009 summary is not pass-candidate")
    a9 = d09_doc.get("anchor")
    fail(isinstance(a9, dict), "RMC-009 summary anchor missing")
    fail(integer(a9.get("number"), "RMC-009.anchor.number") == target["block_number"],
         "RMC-009 block number differs from D11 authority anchor")
    fail(normalized_hash(a9.get("hash"), "RMC-009.anchor.hash") == target["block_hash"],
         "RMC-009 block hash differs from D11 authority anchor")
    fail(integer(d09_doc.get("anchor_timestamp"), "RMC-009.anchor_timestamp") == target["timestamp"],
         "RMC-009 timestamp differs from D11 authority anchor")
    fail(d09_doc.get("generated_at") == rfc3339_utc(target["timestamp"]),
         "RMC-009 generated_at is not derived from the authority block timestamp")

    # D10 is a transition proof, not a second snapshot. Its target must be the exact
    # D11 snapshot, and it must name the exact D06 + full-D09 artifacts consumed here.
    d10 = descriptor(inputs, "d10")
    d10_doc = load_json(root / "d10-raw" / d10["authority_file"])
    fail(d10_doc.get("status") == "RMC_010_LIVE_PARITY_CERTIFIED",
         "RMC-010 authority is not live-parity certified")
    base = d10_doc.get("base_anchor")
    target10 = d10_doc.get("target_anchor")
    fail(isinstance(base, dict) and isinstance(target10, dict), "RMC-010 base/target anchors missing")
    base_number = integer(base.get("block_number"), "RMC-010.base_anchor.block_number")
    target_number = integer(target10.get("block_number"), "RMC-010.target_anchor.block_number")
    fail(base_number < target_number, "RMC-010 target anchor must be strictly later than base")
    fail(target_number == target["block_number"], "RMC-010 target number differs from D11 authority anchor")
    fail(normalized_hash(target10.get("block_hash"), "RMC-010.target_anchor.block_hash") ==
         target["block_hash"], "RMC-010 target hash differs from D11 authority anchor")

    exact_d10_source(d10_doc, "target_d06", d06)
    exact_d10_source(d10_doc, "full_d09", d09)

    # D10 also commits the exact full-D09 evidence-manifest bytes. Those bytes are
    # RMC-009 authority in D11; this prevents a same-run/same-head file substitution.
    rmc009_authority_sha = normalized_hash(by_stage["RMC-009"].get("artifact_sha256"),
                                           "lock.RMC-009.artifact_sha256")
    fail(normalized_hash(d10_doc.get("full_evidence_manifest_sha256"),
                         "RMC-010.full_evidence_manifest_sha256") == rmc009_authority_sha,
         "RMC-010 full-D09 evidence manifest differs from D11 RMC-009 authority")

    print(
        "RMC011_COHERENT_A1_AUTHORITY_PASS "
        f"block={target['block_number']} hash=0x{target['block_hash']} "
        f"timestamp={target['timestamp']}"
    )


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: verify-rmc011-upstream-coherence.py INPUTS AUTHORITY_LOCK DOWNLOADED_ROOT",
            file=sys.stderr,
        )
        return 2
    try:
        verify(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    except CoherenceError as exc:
        print(f"RMC011_UPSTREAM_COHERENCE_FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

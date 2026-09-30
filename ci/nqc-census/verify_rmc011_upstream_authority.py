#!/usr/bin/env python3
"""Fail-closed semantic verification for RMC-011 upstream authority artifacts.

The RMC-011 authority lock is a normalized statement, not a source of truth.
This verifier derives the certifiable state of each RMC-006..RMC-010 stage from
content-addressed bytes inside the exact GitHub Actions artifact already checked
by the workflow, and requires those bytes to agree with the lock.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # fail closed with path context
        raise VerificationError(f"cannot parse JSON {path}: {exc}") from exc
    require(isinstance(value, dict), f"JSON root is not an object: {path}")
    return value


def load_jsonl_one(path: Path) -> dict[str, Any]:
    rows = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    require(len(rows) == 1, f"expected exactly one JSONL row: {path}")
    value = json.loads(rows[0])
    require(isinstance(value, dict), f"JSONL row is not an object: {path}")
    return value


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def plain_hash32(value: Any, context: str) -> str:
    require(isinstance(value, str), f"{context} is not text")
    normalized = value[2:] if value.startswith("0x") else value
    require(
        len(normalized) == 64
        and all(ch in "0123456789abcdefABCDEF" for ch in normalized),
        f"{context} is not a 32-byte hex digest",
    )
    return normalized.lower()


def canonical_real(path: Path) -> Path:
    return path.resolve(strict=True)


def ensure_under(root: Path, path: Path) -> Path:
    root_real = canonical_real(root)
    path_real = canonical_real(path)
    try:
        path_real.relative_to(root_real)
    except ValueError as exc:
        raise VerificationError(f"path escapes artifact root: {path}") from exc
    return path_real


def lock_row(lock: dict[str, Any], stage: str) -> dict[str, Any]:
    rows = [
        row
        for row in lock.get("stages", [])
        if isinstance(row, dict) and row.get("stage") == stage
    ]
    require(len(rows) == 1, f"lock must contain exactly one {stage} row")
    return rows[0]


def validate_lock_row(row: dict[str, Any], commit: str, tree: str) -> None:
    require(
        row.get("code_commit") == commit,
        "lock code_commit does not equal workflow head",
    )
    require(
        row.get("code_tree") == tree,
        "lock code_tree does not equal workflow tree",
    )
    require(
        row.get("unresolved_mismatch_count") == 0,
        "lock unresolved_mismatch_count is not zero",
    )
    require(
        row.get("unknown_failure_count") == 0,
        "lock unknown_failure_count is not zero",
    )
    require(
        row.get("coverage_complete") is True,
        "lock coverage_complete is not true",
    )
    require(row.get("admitted") is True, "lock admitted is not true")
    anchor = row.get("observation_anchor")
    require(isinstance(anchor, dict), "lock observation_anchor missing")
    for key in (
        "chain_id",
        "genesis_hash",
        "fork_lineage",
        "block_number",
        "block_hash",
        "parent_hash",
        "timestamp",
        "state_root",
    ):
        require(key in anchor, f"lock observation_anchor lacks {key}")


def manifest_entries(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = manifest.get("artifacts")
    require(isinstance(raw, list), "authority manifest lacks artifacts array")
    out: dict[str, dict[str, Any]] = {}
    for entry in raw:
        require(
            isinstance(entry, dict),
            "authority manifest artifact entry is not object",
        )
        name = entry.get("path", entry.get("name"))
        require(
            isinstance(name, str) and name,
            "authority manifest artifact entry lacks path/name",
        )
        require(
            name not in out,
            f"duplicate authority manifest artifact entry: {name}",
        )
        digest = entry.get("sha256")
        size = entry.get("bytes")
        require(
            isinstance(digest, str) and len(digest) == 64,
            f"invalid sha256 for {name}",
        )
        require(
            isinstance(size, int) and size >= 0,
            f"invalid byte length for {name}",
        )
        out[name] = entry
    return out


def load_bound_json(
    base: Path,
    manifest: dict[str, Any],
    name: str,
) -> dict[str, Any]:
    entries = manifest_entries(manifest)
    require(name in entries, f"authority manifest does not bind {name}")
    path = ensure_under(base, base / name)
    entry = entries[name]
    require(
        path.stat().st_size == entry["bytes"],
        f"byte length mismatch for {name}",
    )
    require(
        sha256_file(path) == entry["sha256"],
        f"sha256 mismatch for {name}",
    )
    return load_json(path)


def load_bound_jsonl_one(
    base: Path,
    manifest: dict[str, Any],
    name: str,
) -> dict[str, Any]:
    entries = manifest_entries(manifest)
    require(name in entries, f"authority manifest does not bind {name}")
    path = ensure_under(base, base / name)
    entry = entries[name]
    require(
        path.stat().st_size == entry["bytes"],
        f"byte length mismatch for {name}",
    )
    require(
        sha256_file(path) == entry["sha256"],
        f"sha256 mismatch for {name}",
    )
    return load_jsonl_one(path)


def lock_anchor(row: dict[str, Any]) -> dict[str, Any]:
    value = row["observation_anchor"]
    return {
        "chain_id": value["chain_id"],
        "genesis_hash": value["genesis_hash"],
        "fork_lineage": value["fork_lineage"],
        "block_number": value["block_number"],
        "block_hash": value["block_hash"],
        "parent_hash": value["parent_hash"],
        "timestamp": value["timestamp"],
        "state_root": value["state_root"],
    }


def full_anchor_from_run(run: dict[str, Any]) -> dict[str, Any]:
    chain = run.get("chain_domain")
    anchor = run.get("observation_anchor")
    require(isinstance(chain, dict), "run lacks chain_domain")
    require(isinstance(anchor, dict), "run lacks observation_anchor")

    def pick(
        obj: dict[str, Any],
        primary: str,
        alternate: str | None = None,
    ) -> Any:
        if primary in obj:
            return obj[primary]
        if alternate is not None and alternate in obj:
            return obj[alternate]
        raise VerificationError(f"anchor field missing: {primary}")

    return {
        "chain_id": pick(chain, "chain_id"),
        "genesis_hash": pick(chain, "genesis_hash"),
        "fork_lineage": pick(chain, "fork_lineage"),
        "block_number": pick(anchor, "block_number", "number"),
        "block_hash": pick(anchor, "block_hash", "hash"),
        "parent_hash": pick(anchor, "parent_hash"),
        "timestamp": pick(anchor, "timestamp"),
        "state_root": pick(anchor, "state_root"),
    }


def require_full_anchor(
    actual: dict[str, Any],
    row: dict[str, Any],
    context: str,
) -> None:
    require(
        actual == lock_anchor(row),
        f"{context} full observation anchor differs from authority lock",
    )


def require_partial_anchor(
    number: Any,
    block_hash: Any,
    timestamp: Any,
    row: dict[str, Any],
    context: str,
) -> None:
    expected = lock_anchor(row)
    require(
        number == expected["block_number"],
        f"{context} block number differs from lock",
    )
    require(
        block_hash == expected["block_hash"],
        f"{context} block hash differs from lock",
    )
    require(
        timestamp == expected["timestamp"],
        f"{context} timestamp differs from lock",
    )


def verify_manifest_identity(
    manifest: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    require(
        manifest.get("code_commit") == commit,
        "authority manifest code_commit mismatch",
    )
    require(
        manifest.get("code_tree") == tree,
        "authority manifest code_tree mismatch",
    )


def verify_d06(
    base: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    require(
        manifest.get("status") == "CONTENT_ADDRESSED",
        "D06 evidence manifest not content-addressed",
    )
    verify_manifest_identity(manifest, commit, tree)
    run = load_bound_json(base, manifest, "aave-discovery-run.json")
    summary = load_bound_json(base, manifest, "aave-discovery-summary.json")
    delta = load_bound_jsonl_one(base, manifest, "aave-discovery-deltas.jsonl")
    mismatch = load_bound_jsonl_one(
        base,
        manifest,
        "aave-discovery-mismatch-ledger.jsonl",
    )
    require(
        run.get("status") == "RMC_006_PASS_CANDIDATE",
        "D06 run is not pass candidate",
    )
    require(
        run.get("code_commit") == commit and run.get("code_tree") == tree,
        "D06 run code identity mismatch",
    )
    require(
        summary.get("status") == "RMC_006_PASS_CANDIDATE",
        "D06 summary is not pass candidate",
    )
    require(
        summary.get("code_commit") == commit
        and summary.get("code_tree") == tree,
        "D06 summary code identity mismatch",
    )
    require(
        summary.get("unexplained_delta_count") == 0,
        "D06 has unexplained deltas",
    )
    require(
        summary.get("provider_mismatch_count") == 0,
        "D06 has provider mismatches",
    )
    require(
        summary.get("admission_rejection_count") == 0,
        "D06 has admission rejections",
    )
    require(
        summary.get("blocking_findings") == 0,
        "D06 has blocking findings",
    )
    require(
        summary.get("unexplained_findings") == 0,
        "D06 has unexplained findings",
    )
    require(
        summary.get("deduplication") == "PASS"
        and summary.get("canonicalization") == "PASS",
        "D06 canonical coverage gates did not pass",
    )
    require(
        delta.get("unexplained_delta_count") == 0,
        "D06 delta ledger has unexplained delta",
    )
    require(
        mismatch.get("provider_mismatch_count") == 0
        and mismatch.get("unexplained_findings") == 0,
        "D06 mismatch ledger is nonzero",
    )
    require_full_anchor(full_anchor_from_run(run), row, "D06")


def verify_d07(
    base: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    require(
        manifest.get("status") == "CONTENT_ADDRESSED",
        "D07 evidence manifest not content-addressed",
    )
    verify_manifest_identity(manifest, commit, tree)
    run = load_bound_json(base, manifest, "v2-discovery-run.json")
    summary = load_bound_json(base, manifest, "v2-discovery-summary.json")
    delta = load_bound_jsonl_one(base, manifest, "v2-deltas.jsonl")
    mismatch = load_bound_jsonl_one(
        base,
        manifest,
        "v2-mismatch-ledger.jsonl",
    )
    require(
        run.get("status") == "RMC_007_PASS_CANDIDATE",
        "D07 run is not pass candidate",
    )
    require(
        run.get("code_commit") == commit and run.get("code_tree") == tree,
        "D07 run code identity mismatch",
    )
    require(
        summary.get("status") == "RMC_007_PASS_CANDIDATE",
        "D07 summary is not pass candidate",
    )
    require(
        summary.get("code_commit") == commit
        and summary.get("code_tree") == tree,
        "D07 summary code identity mismatch",
    )
    require(
        summary.get("unexplained_delta_count") == 0,
        "D07 has unexplained deltas",
    )
    require(
        summary.get("provider_mismatch_count") == 0,
        "D07 has provider mismatches",
    )
    require(
        delta.get("unexplained_delta_count") == 0,
        "D07 delta ledger has unexplained delta",
    )
    require(
        mismatch.get("provider_mismatch_count") == 0,
        "D07 mismatch ledger is nonzero",
    )
    require_full_anchor(full_anchor_from_run(run), row, "D07")


def verify_d08(
    base: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    verify_manifest_identity(manifest, commit, tree)
    require(
        isinstance(manifest.get("observation_anchor"), dict),
        "D08 manifest lacks observation_anchor",
    )
    require_full_anchor(
        manifest["observation_anchor"],
        row,
        "D08 manifest",
    )
    summary = load_bound_json(base, manifest, "state-summary.json")
    require(
        summary.get("status") == "RMC_008_PASS_CANDIDATE",
        "D08 summary is not pass candidate",
    )
    require(
        summary.get("code_commit") == commit
        and summary.get("code_tree") == tree,
        "D08 summary code identity mismatch",
    )
    require(
        summary.get("unexplained_mismatches") == 0,
        "D08 has unexplained mismatches",
    )
    require(
        summary.get("unknown_rejections") == 0,
        "D08 has UNKNOWN rejections",
    )
    require(
        summary.get("metrics_conserved") is True,
        "D08 metrics are not conserved",
    )
    require(
        summary.get("every_market_decided") is True,
        "D08 has undecided markets",
    )
    require_full_anchor(
        summary.get("observation_anchor", {}),
        row,
        "D08 summary",
    )


def verify_d09(
    base: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    verify_manifest_identity(manifest, commit, tree)
    summary = load_bound_json(base, manifest, "account-summary.json")
    require(
        summary.get("status") == "RMC_009_PASS_CANDIDATE",
        "D09 summary is not pass candidate",
    )
    require(
        summary.get("all_tokens_conserved") is True,
        "D09 token conservation failed",
    )
    require(
        summary.get("unexplained_mismatches") == 0,
        "D09 has unexplained mismatches",
    )
    findings = summary.get("blocking_findings")
    require(
        isinstance(findings, list) and not findings,
        "D09 has blocking findings",
    )
    anchor = summary.get("anchor")
    require(isinstance(anchor, dict), "D09 summary lacks anchor")
    require_partial_anchor(
        anchor.get("number"),
        anchor.get("hash"),
        summary.get("anchor_timestamp"),
        row,
        "D09",
    )


def verify_d10(
    root: Path,
    authority: dict[str, Any],
    row: dict[str, Any],
    lock: dict[str, Any],
    commit: str,
    tree: str,
) -> None:
    require(
        authority.get("schema")
        == "nqc-rmc-010-live-parity-certification-v1",
        "D10 certification schema mismatch",
    )
    require(
        authority.get("status") == "RMC_010_LIVE_PARITY_CERTIFIED",
        "D10 is not live-parity certified",
    )
    require(
        authority.get("code_commit") == commit
        and authority.get("code_tree") == tree,
        "D10 certification code identity mismatch",
    )
    target = authority.get("target_anchor")
    require(
        isinstance(target, dict),
        "D10 certification lacks target_anchor",
    )
    expected = lock_anchor(row)
    require(
        target.get("block_number") == expected["block_number"],
        "D10 target block number differs from lock",
    )
    require(
        target.get("block_hash") == expected["block_hash"],
        "D10 target block hash differs from lock",
    )

    parity = ensure_under(root, root / "parity-closeout.json")
    incremental_manifest_path = ensure_under(
        root,
        root / "closeout" / "evidence-manifest.json",
    )
    require(
        sha256_file(parity) == authority.get("parity_sha256"),
        "D10 parity file hash differs from certification",
    )
    require(
        sha256_file(incremental_manifest_path)
        == authority.get("incremental_evidence_manifest_sha256"),
        "D10 incremental manifest hash differs from certification",
    )
    d09_row = lock_row(lock, "RMC-009")
    require(
        plain_hash32(
            authority.get("full_evidence_manifest_sha256"),
            "D10 full evidence SHA-256",
        )
        == plain_hash32(
            d09_row.get("artifact_sha256"),
            "locked D09 artifact SHA-256",
        ),
        "D10 full-census authority is not the locked D09 authority",
    )

    parity_doc = load_json(parity)
    require(
        parity_doc.get("status") == "FULL_INCREMENTAL_PARITY_PASS",
        "D10 parity status is not PASS",
    )
    manifest = load_json(incremental_manifest_path)
    verify_manifest_identity(manifest, commit, tree)
    summary = load_bound_json(
        incremental_manifest_path.parent,
        manifest,
        "account-summary.json",
    )
    require(
        summary.get("status") == "RMC_009_PASS_CANDIDATE",
        "D10 incremental account summary is not pass candidate",
    )
    require(
        summary.get("all_tokens_conserved") is True,
        "D10 incremental account conservation failed",
    )
    require(
        summary.get("unexplained_mismatches") == 0,
        "D10 incremental summary has unexplained mismatches",
    )
    findings = summary.get("blocking_findings")
    require(
        isinstance(findings, list) and not findings,
        "D10 incremental summary has blocking findings",
    )
    anchor = summary.get("anchor")
    require(
        isinstance(anchor, dict),
        "D10 incremental summary lacks anchor",
    )
    require_partial_anchor(
        anchor.get("number"),
        anchor.get("hash"),
        summary.get("anchor_timestamp"),
        row,
        "D10 incremental summary",
    )


def verify(args: argparse.Namespace) -> None:
    root = canonical_real(Path(args.artifact_root))
    authority_path = ensure_under(root, root / args.authority_file)
    lock = load_json(Path(args.lock))
    row = lock_row(lock, args.stage)
    validate_lock_row(
        row,
        args.expected_code_commit,
        args.expected_code_tree,
    )
    require(
        sha256_file(authority_path)
        == plain_hash32(
            row.get("artifact_sha256"),
            "lock artifact_sha256",
        ),
        "authority file SHA-256 differs from lock",
    )
    authority = load_json(authority_path)

    if args.stage == "RMC-010":
        verify_d10(
            root,
            authority,
            row,
            lock,
            args.expected_code_commit,
            args.expected_code_tree,
        )
    else:
        verify_manifest_identity(
            authority,
            args.expected_code_commit,
            args.expected_code_tree,
        )
        base = authority_path.parent
        if args.stage == "RMC-006":
            verify_d06(
                base,
                authority,
                row,
                args.expected_code_commit,
                args.expected_code_tree,
            )
        elif args.stage == "RMC-007":
            verify_d07(
                base,
                authority,
                row,
                args.expected_code_commit,
                args.expected_code_tree,
            )
        elif args.stage == "RMC-008":
            verify_d08(
                base,
                authority,
                row,
                args.expected_code_commit,
                args.expected_code_tree,
            )
        elif args.stage == "RMC-009":
            verify_d09(
                base,
                authority,
                row,
                args.expected_code_commit,
                args.expected_code_tree,
            )
        else:
            raise VerificationError(f"unsupported stage: {args.stage}")

    print(
        "RMC011_UPSTREAM_SEMANTIC_AUTHORITY_PASS "
        f"stage={args.stage} "
        f"head={args.expected_code_commit} "
        f"tree={args.expected_code_tree} "
        f"authority_sha256={row['artifact_sha256']}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--stage",
        required=True,
        choices=[f"RMC-00{i}" for i in range(6, 10)] + ["RMC-010"],
    )
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--authority-file", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--expected-code-commit", required=True)
    parser.add_argument("--expected-code-tree", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        verify(parse_args())
    except (
        VerificationError,
        OSError,
        KeyError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        print(
            f"RMC011_UPSTREAM_SEMANTIC_AUTHORITY_FAIL: {exc}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

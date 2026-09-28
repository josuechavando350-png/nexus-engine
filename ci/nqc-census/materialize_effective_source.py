#!/usr/bin/env python3
"""Materialize the exact Protocol/Fork effective source for Real Market Census.

The immutable recovered bytes remain untouched. Inputs are read from the certified
Git commit, repairs are applied only to a fresh output directory, closed measured
reimplementations are bound explicitly, and a deterministic content-addressed
receipt is emitted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROFILE = ROOT / "ci/nqc-census/effective-source-profile.json"
OUTPUT_RECEIPT = "MATERIALIZATION.json"
PROTECTED_PATHS = (
    "ci/nqc-protocol-fork/recovered-source",
    "ci/nqc-protocol-fork/reimplementation",
    "ci/nqc-protocol-fork/compatibility",
    "ci/nqc-protocol-fork/locks",
    "ci/nqc-protocol-fork/PROTOCOL_FORK_TRUTH_CONTRACT.json",
    "ci/nqc-protocol-fork/PROTOCOL_FORK_FINAL_CLOSEOUT.json",
)


class MaterializationError(RuntimeError):
    pass


def git(*args: str, cwd: Path = ROOT) -> bytes:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise MaterializationError(
            f"git {' '.join(args)} failed: {proc.stderr.decode(errors='replace').strip()}"
        )
    return proc.stdout


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_sha(value: Any, size: int) -> bool:
    return (
        isinstance(value, str)
        and len(value) == size
        and all(ch in "0123456789abcdef" for ch in value)
    )


def load_profile(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    if data.get("schema_version") != 1:
        raise MaterializationError("unsupported effective-source profile schema")
    if data.get("authority") != "NQC_RMC_CERTIFIED_EFFECTIVE_SOURCE_PROFILE_V1":
        raise MaterializationError("unexpected effective-source authority")
    if not is_sha(data.get("protocol_fork_certified_commit"), 40):
        raise MaterializationError("invalid certified commit")
    if not is_sha(data.get("protocol_fork_certified_tree"), 40):
        raise MaterializationError("invalid certified tree")
    if not isinstance(data.get("overlays"), list) or not data["overlays"]:
        raise MaterializationError("effective-source profile has no overlays")
    if not isinstance(data.get("reimplementations"), list):
        raise MaterializationError("effective-source profile has invalid reimplementations")
    return data


def verify_git_authority(profile: dict[str, Any]) -> tuple[str, str]:
    commit = profile["protocol_fork_certified_commit"]
    expected_tree = profile["protocol_fork_certified_tree"]
    actual_tree = git("rev-parse", f"{commit}^{{tree}}").decode().strip()
    if actual_tree != expected_tree:
        raise MaterializationError(
            f"certified tree mismatch: expected {expected_tree}, got {actual_tree}"
        )

    head = git("rev-parse", "HEAD").decode().strip()
    ancestor = subprocess.run(
        ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", commit, head],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if ancestor.returncode != 0:
        raise MaterializationError(
            "current HEAD is not descended from certified Protocol/Fork commit"
        )

    status = git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *PROTECTED_PATHS,
    ).decode()
    if status.strip():
        raise MaterializationError("Protocol/Fork inputs have local worktree modifications")

    drift = subprocess.run(
        ["git", "-C", str(ROOT), "diff", "--quiet", commit, "HEAD", "--", *PROTECTED_PATHS],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if drift.returncode != 0:
        raise MaterializationError(
            "Protocol/Fork input paths drifted after certification; rebind before Census"
        )
    return commit, head


def object_sha(commit: str, path: str) -> str:
    return git("rev-parse", f"{commit}:{path}").decode().strip()


def object_bytes(commit: str, path: str) -> bytes:
    return git("show", f"{commit}:{path}")


def verify_object_pin(commit: str, path: str, expected_sha: str) -> None:
    if not is_sha(expected_sha, 40):
        raise MaterializationError(f"invalid Git object pin for {path}")
    actual = object_sha(commit, path)
    if actual != expected_sha:
        raise MaterializationError(
            f"git object drift for {path}: expected {expected_sha}, got {actual}"
        )


def extract_tree(commit: str, prefix: str, destination: Path) -> None:
    raw = git("ls-tree", "-r", "-z", commit, "--", prefix)
    entries = [entry for entry in raw.split(b"\0") if entry]
    if not entries:
        raise MaterializationError(f"empty certified tree: {prefix}")

    prefix_path = PurePosixPath(prefix)
    seen: set[PurePosixPath] = set()
    for entry in entries:
        meta, raw_path = entry.split(b"\t", 1)
        mode, kind, blob_sha = meta.decode().split()
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise MaterializationError(
                f"unsupported git object {mode} {kind} at {raw_path!r}"
            )

        repo_path = PurePosixPath(raw_path.decode())
        relative = repo_path.relative_to(prefix_path)
        if relative in seen or relative.is_absolute() or ".." in relative.parts:
            raise MaterializationError(f"unsafe or duplicate path: {relative}")
        seen.add(relative)

        data = git("cat-file", "blob", blob_sha)
        target = destination.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if mode == "100755" else 0o644)


def tree_digest(root: Path) -> str:
    hasher = hashlib.sha256()
    files = sorted(path for path in root.rglob("*") if path.is_file())
    for path in files:
        rel = path.relative_to(root).as_posix().encode()
        data = path.read_bytes()
        mode = b"755" if path.stat().st_mode & stat.S_IXUSR else b"644"
        hasher.update(len(rel).to_bytes(4, "big"))
        hasher.update(rel)
        hasher.update(mode)
        hasher.update(len(data).to_bytes(8, "big"))
        hasher.update(hashlib.sha256(data).digest())
    return hasher.hexdigest()


def verify_source_manifest(source: Path) -> tuple[int, str]:
    manifest = source / "SOURCE_FILES.sha256"
    raw = manifest.read_bytes()
    count = 0
    for line in raw.decode().splitlines():
        if not line.strip():
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            raise MaterializationError("malformed SOURCE_FILES.sha256")
        expected, rel = parts
        rel = rel.lstrip("*")
        rel_path = PurePosixPath(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise MaterializationError(f"unsafe source manifest path: {rel}")
        path = source.joinpath(*rel_path.parts)
        if not path.is_file():
            raise MaterializationError(f"missing recovered source file: {rel}")
        actual = sha256_bytes(path.read_bytes())
        if actual != expected:
            raise MaterializationError(
                f"recovered source digest mismatch for {rel}: "
                f"expected {expected}, got {actual}"
            )
        count += 1
    if count == 0:
        raise MaterializationError("empty recovered source manifest")
    return count, sha256_bytes(raw)


def verify_reimplementation_closeout(
    commit: str, item: dict[str, Any]
) -> dict[str, Any]:
    closeout_path = item["closeout_path"]
    verify_object_pin(commit, closeout_path, item["closeout_git_blob_sha"])
    closeout = json.loads(object_bytes(commit, closeout_path))
    if closeout.get("schema_version") != 1:
        raise MaterializationError(f"{item['id']} closeout schema mismatch")
    if closeout.get("source_blocker") != item["id"]:
        raise MaterializationError(f"{item['id']} closeout source blocker mismatch")
    if closeout.get("classification") != "NEW_MEASURED_REIMPLEMENTATION_NOT_RECOVERED_SOURCE":
        raise MaterializationError(f"{item['id']} closeout classification mismatch")
    if closeout.get("status") != "CLOSED":
        raise MaterializationError(f"{item['id']} is not CLOSED")
    if closeout.get("unexplained_mismatches") != 0:
        raise MaterializationError(f"{item['id']} has unexplained mismatches")
    return {
        "path": closeout_path,
        "git_blob_sha": item["closeout_git_blob_sha"],
        "sha256": sha256_bytes(object_bytes(commit, closeout_path)),
        "status": "CLOSED",
        "unexplained_mismatches": 0,
    }


def apply_patch(source: Path, patch_path: Path, unidiff_zero: bool) -> None:
    args = ["apply"]
    if unidiff_zero:
        args.append("--unidiff-zero")
    check = subprocess.run(
        ["git", *args, "--check", str(patch_path)],
        cwd=source,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check.returncode != 0:
        raise MaterializationError(
            f"patch preflight failed for {patch_path.name}: "
            f"{check.stderr.decode(errors='replace').strip()}"
        )
    apply = subprocess.run(
        ["git", *args, str(patch_path)],
        cwd=source,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if apply.returncode != 0:
        raise MaterializationError(
            f"patch application failed for {patch_path.name}: "
            f"{apply.stderr.decode(errors='replace').strip()}"
        )


def require_semantic_markers(source: Path) -> None:
    expected = {
        "crates/nqc-hot-state/src/lib.rs": [
            "pub struct ProtocolAccountRisk",
            "pub fn account_protocol_risk_at",
        ],
        "crates/nqc-aave-opportunity/src/lib.rs": [
            "percent_mul_ceil_unbounded",
        ],
        "contracts/src/NqcAaveV3Executor.sol": [
            "function _approveRepaymentAndEmit",
        ],
    }
    for rel, markers in expected.items():
        text = (source / rel).read_text()
        for marker in markers:
            if marker not in text:
                raise MaterializationError(
                    f"effective semantic marker absent: {rel}: {marker}"
                )


def materialize(profile_path: Path, output: Path) -> dict[str, Any]:
    profile = load_profile(profile_path)
    commit, materializer_head = verify_git_authority(profile)

    output = output.resolve()
    root = ROOT.resolve()
    try:
        output.relative_to(root)
    except ValueError:
        pass
    else:
        raise MaterializationError(
            "effective source must be materialized outside the repository"
        )

    if output.exists():
        raise MaterializationError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)

    recovered = profile["recovered_source"]
    verify_object_pin(commit, recovered["path"], recovered["git_tree_sha"])

    lock = profile["pinned_lock"]
    verify_object_pin(commit, lock["path"], lock["git_blob_sha"])
    lock_bytes = object_bytes(commit, lock["path"])
    if not is_sha(lock.get("sha256"), 64):
        raise MaterializationError("invalid pinned Cargo.lock SHA-256")
    if sha256_bytes(lock_bytes) != lock["sha256"]:
        raise MaterializationError("pinned Cargo.lock SHA-256 mismatch")

    with tempfile.TemporaryDirectory(prefix="nqc-rmc-effective-inputs-") as tmp_name:
        temp = Path(tmp_name)
        source = output / "recovered-source"
        reimplementation = output / "reimplementation"

        extract_tree(commit, recovered["path"], source)
        source_count, source_manifest_sha256 = verify_source_manifest(source)
        immutable_tree_sha256 = tree_digest(source)

        reimplementation.mkdir(parents=True)
        reimplementation_receipts: list[dict[str, Any]] = []
        for item in profile["reimplementations"]:
            verify_object_pin(commit, item["path"], item["git_tree_sha"])
            closeout = verify_reimplementation_closeout(commit, item)
            target = output / item["destination"]
            extract_tree(commit, item["path"], target)
            reimplementation_receipts.append(
                {
                    "id": item["id"],
                    "path": item["path"],
                    "git_tree_sha": item["git_tree_sha"],
                    "content_tree_sha256": tree_digest(target),
                    "closeout": closeout,
                }
            )

        overlay_receipts: list[dict[str, Any]] = []
        seen_overlay_ids: set[str] = set()
        for index, item in enumerate(profile["overlays"], start=1):
            overlay_id = item["id"]
            if overlay_id in seen_overlay_ids:
                raise MaterializationError(f"duplicate overlay id: {overlay_id}")
            seen_overlay_ids.add(overlay_id)

            verify_object_pin(commit, item["path"], item["git_blob_sha"])
            data = object_bytes(commit, item["path"])
            digest = sha256_bytes(data)
            expected_digest = item.get("sha256")
            if not is_sha(expected_digest, 64):
                raise MaterializationError(f"invalid SHA-256 pin for {overlay_id}")
            if digest != expected_digest:
                raise MaterializationError(
                    f"SHA-256 mismatch for {overlay_id}: "
                    f"expected {expected_digest}, got {digest}"
                )

            input_path = temp / f"{index:02d}-{Path(item['path']).name}"
            input_path.write_bytes(data)
            mode = item["mode"]
            if mode == "git_apply":
                apply_patch(source, input_path, False)
            elif mode == "git_apply_unidiff_zero":
                apply_patch(source, input_path, True)
            elif mode == "python_root_arg":
                proc = subprocess.run(
                    [sys.executable, str(input_path), str(source)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                if proc.returncode != 0:
                    raise MaterializationError(
                        f"semantic repair failed for {overlay_id}: "
                        f"{proc.stderr.decode(errors='replace').strip()}"
                    )
            elif mode == "copy":
                destination = source / item["destination"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    raise MaterializationError(
                        f"overlay destination already exists: {item['destination']}"
                    )
                destination.write_bytes(data)
                destination.chmod(0o644)
            else:
                raise MaterializationError(f"unsupported overlay mode: {mode}")

            overlay_receipts.append(
                {
                    "order": index,
                    "id": overlay_id,
                    "path": item["path"],
                    "git_blob_sha": item["git_blob_sha"],
                    "sha256": digest,
                    "mode": mode,
                }
            )

        required_repairs = {f"PFT-COMPAT-{number:03d}" for number in range(1, 10)}
        applied_repairs = {
            item["id"] for item in overlay_receipts if item["id"] in required_repairs
        }
        if applied_repairs != required_repairs:
            missing = sorted(required_repairs - applied_repairs)
            extra = sorted(applied_repairs - required_repairs)
            raise MaterializationError(
                f"effective repair set mismatch missing={missing} extra={extra}"
            )

        (source / "Cargo.lock").write_bytes(lock_bytes)
        (source / "Cargo.lock").chmod(0o644)
        require_semantic_markers(source)

        receipt = {
            "schema_version": 1,
            "authority": "NQC_RMC_CERTIFIED_EFFECTIVE_SOURCE_V1",
            "protocol_fork_certified_commit": commit,
            "protocol_fork_certified_tree": profile["protocol_fork_certified_tree"],
            "materializer_head": materializer_head,
            "recovered_checkpoint": profile["recovered_checkpoint"],
            "recovered_source_git_tree_sha": recovered["git_tree_sha"],
            "recovered_source_manifest_file_count": source_count,
            "recovered_source_manifest_sha256": source_manifest_sha256,
            "immutable_recovered_source_tree_sha256": immutable_tree_sha256,
            "pinned_lock": {
                "path": lock["path"],
                "git_blob_sha": lock["git_blob_sha"],
                "sha256": lock["sha256"],
            },
            "ordered_overlays": overlay_receipts,
            "effective_recovered_source_tree_sha256": tree_digest(source),
            "reimplementations": reimplementation_receipts,
            "reimplementation_bundle_tree_sha256": tree_digest(reimplementation),
            "toolchains": profile["toolchains"],
            "truth_boundaries": profile["truth_boundaries"],
            "invariants": {
                "immutable_recovered_source_preserved": True,
                "effective_copy_is_derived": True,
                "network_used_for_materialization": False,
                "secrets_used_for_materialization": False,
                "protocol_fork_reopened": False,
                "all_pft_compat_001_through_009_applied": True,
                "all_reimplementations_closed_zero_mismatch": True,
                "real_market_evidence": False,
                "live_pnl_evidence": False,
                "production_authority": False,
            },
        }
        (output / OUTPUT_RECEIPT).write_text(
            json.dumps(receipt, indent=2, sort_keys=True) + "\n"
        )
        return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        receipt = materialize(args.profile, args.output)
    except (MaterializationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"RMC_EFFECTIVE_SOURCE_FAIL {error}", file=sys.stderr)
        return 1

    print(
        "RMC_EFFECTIVE_SOURCE_PASS "
        f"commit={receipt['protocol_fork_certified_commit']} "
        f"effective_tree_sha256={receipt['effective_recovered_source_tree_sha256']} "
        f"reimplementation_tree_sha256={receipt['reimplementation_bundle_tree_sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

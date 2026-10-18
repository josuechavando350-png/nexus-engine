#!/usr/bin/env python3
"""Temporary compatibility overlays; immutable recovered source stays unchanged."""
import argparse
import hashlib
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PATCHES = {
    "PFT-COMPAT-001-aave-u40.patch": "9dbea652b4555e6240f694a4ceb9b3eb8354d12dcaaf6ec2e3a254a7ab3463ca",
    "PFT-COMPAT-003-sync-devdep.patch": "7076c8d5c6f4ba737c7e5a8e030bcb2a32a50642969d35d3156082ddf1eea3a5",
    "PFT-COMPAT-005-opportunity-devdep.patch": "12c23465ce52ffa71f6bb45737e2b56f866d4d4a56dcad22ffd31f81d2a73664",
}
LOCK_SHA = "f32e4cf8ef1896ac982082583ebfda0e65d45a490ffc4dd6bf58be2077d8984a"


def prepare(target):
    if target.resolve() == (ROOT / "ci/nqc-protocol-fork/recovered-source").resolve():
        raise ValueError("refusing to modify immutable source")
    for name, expected in PATCHES.items():
        path = ROOT / "ci/nqc-protocol-fork/compatibility" / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"overlay digest mismatch: {name}")
        subprocess.run(["git", "apply", "--unidiff-zero", "--check", str(path)], cwd=target, check=True)
        subprocess.run(["git", "apply", "--unidiff-zero", str(path)], cwd=target, check=True)
    lock = (ROOT / "ci/nqc-protocol-fork/locks/recovered-2b640cc-Cargo.lock").read_bytes()
    if hashlib.sha256(lock).hexdigest() != LOCK_SHA:
        raise ValueError("dependency lock mismatch")
    # Example-only tokio edge to the already locked package, no dependency resolution.
    original = tomllib.loads(lock.decode())
    old = next(p for p in original["package"] if p["name"] == "nqc-aave-market")
    text = lock.decode()
    start = text.index('name = "nqc-aave-market"')
    end = text.index('[[package]]', start)
    section = text[start:end]
    if section.count(' "thiserror",\n') != 1:
        raise ValueError("unexpected market lock entry")
    updated = text[:start] + section.replace(' "thiserror",\n', ' "thiserror",\n "tokio",\n') + text[end:]
    expected = dict(old, dependencies=old["dependencies"] + ["tokio"])
    revised = tomllib.loads(updated)
    for before, after in zip(original["package"], revised["package"], strict=True):
        if after != (expected if before["name"] == "nqc-aave-market" else before):
            raise ValueError("unexpected package graph mutation")
    (target / "Cargo.lock").write_text(updated)
    manifest = target / "crates/nqc-aave-market/Cargo.toml"
    manifest.write_text(manifest.read_text() + '\n[dev-dependencies]\ntokio.workspace = true\n')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    prepare(parser.parse_args().target)

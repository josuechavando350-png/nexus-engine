#!/usr/bin/env python3
"""Verify the content-addressed RMC-001 freeze manifest.

  verify_rmc001_freeze.py [--allow-pending] [--offline] [MANIFEST]

Run from the repository root. It checks:

1. The manifest names RMC-001, amendment RMC-001-A1, the original authority
   (base) and the amendment authority commit and tree. The base is an
   ancestor of the authority, and the authority is an ancestor of HEAD.
2. Every frozen file is byte-identical, by SHA-256, at HEAD and at the
   authority commit. Files declared unchanged since the base are also
   identical at the base.
3. Every gate file is byte-identical to its pin at HEAD.
4. The committed evidence tarball matches its pins. It is extracted and
   checked against its own SHA256SUMS, then re-verified offline by
   rmc001_amendment_evidence.py, which must reproduce the committed
   summary.json byte for byte.
5. The certification: a successful run of the RMC-001 workflow on a commit
   whose manifest pinned exactly this content. It is checked against the
   GitHub API unless --offline is given; --offline checks the git side only.
   Without --allow-pending, a PENDING certification fails.

Any failure exits non-zero. There is no warning mode.
"""

import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

MANIFEST = "ci/nqc-census/rmc001-freeze-manifest.json"
SCHEMA_VERSION = 1
CONTRACT = "RMC-001 canonical market identity"
AMENDMENT = "RMC-001-A1"
CERTIFYING_WORKFLOW = ".github/workflows/nqc-census-identity.yml"
REPOSITORY = "josuechavando350-png/nexus-engine"
REQUIRED_FILES = {
    "ci/nqc-census/IDENTITY_CONTRACT.md",
    "ci/nqc-census/identity-vectors.json",
    "nqc-census/rust-toolchain.toml",
    "nqc-census/crates/nqc-census-core/Cargo.toml",
    "nqc-census/crates/nqc-census-core/src/identity.rs",
    "nqc-census/crates/nqc-census-core/tests/identity.rs",
    "nqc-census/crates/nqc-census-core/tests/identity_amendment_1.rs",
    "nqc-census/crates/nqc-census-core/tests/support/identity_corpus.rs",
    "ci/nqc-census/rmc001_amendment_evidence.py",
    ".github/workflows/nqc-census-rmc001-amendment-evidence.yml",
    "ci/nqc-census/rmc001-amendment-1/evidence.tar.gz",
    "ci/nqc-census/rmc001-amendment-1/summary.json",
}
REQUIRED_UNCHANGED = {
    "ci/nqc-census/identity-vectors.json",
    "nqc-census/rust-toolchain.toml",
    "nqc-census/crates/nqc-census-core/Cargo.toml",
    "nqc-census/crates/nqc-census-core/tests/identity.rs",
}
REQUIRED_GATES = {CERTIFYING_WORKFLOW, "ci/nqc-census/verify_rmc001_freeze.py"}


def fail(message):
    raise SystemExit(f"RMC_001_FREEZE_MANIFEST_FAIL {message}")


def git(*args, binary=False):
    result = subprocess.run(["git", *args], capture_output=True)
    if result.returncode != 0:
        fail(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout if binary else result.stdout.decode().strip()


def is_ancestor(older, newer):
    return subprocess.run(["git", "merge-base", "--is-ancestor", older, newer]).returncode == 0


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def full_sha(value, name):
    if len(value) != 40 or any(ch not in "0123456789abcdef" for ch in value):
        fail(f"{name} is not a full commit/tree id: {value!r}")


def without_certification(manifest):
    return {key: value for key, value in manifest.items() if key != "certification"}


def verify_evidence(manifest, files):
    evidence = manifest["evidence"]
    gz = open(evidence["tarball"], "rb").read()
    if sha256(gz) != evidence["tarball_gzip_sha256"]:
        fail("evidence tarball gzip digest differs from its pin")
    tar = gzip.decompress(gz)
    if sha256(tar) != evidence["tarball_tar_sha256"]:
        fail("evidence tar digest differs from its pin")
    summary_bytes = open(evidence["summary"], "rb").read()
    if sha256(summary_bytes) != evidence["summary_sha256"]:
        fail("evidence summary digest differs from its pin")
    with tempfile.TemporaryDirectory() as root:
        with tarfile.open(fileobj=io.BytesIO(tar)) as archive:
            archive.extractall(root, filter="data")
        sums = open(os.path.join(root, "SHA256SUMS")).read().splitlines()
        listed = set()
        for line in sums:
            digest, path = line.split("  ", 1)
            listed.add(path)
            if sha256(open(os.path.join(root, path), "rb").read()) != digest:
                fail(f"evidence file {path} differs from SHA256SUMS")
        present = set()
        for base, _, names in os.walk(root):
            for name in names:
                rel = os.path.relpath(os.path.join(base, name), root)
                if rel != "SHA256SUMS":
                    present.add(rel)
        if present != listed:
            fail(f"evidence files and SHA256SUMS differ: {sorted(present ^ listed)}")
        if open(os.path.join(root, "summary.json"), "rb").read() != summary_bytes:
            fail("committed summary.json differs from the tarball's")
        os.remove(os.path.join(root, "summary.json"))
        result = subprocess.run(
            [sys.executable, "ci/nqc-census/rmc001_amendment_evidence.py", "verify", root],
            capture_output=True, text=True)
        sys.stdout.write(result.stdout)
        if result.returncode != 0:
            fail(f"evidence does not verify: {result.stderr.strip() or result.stdout.strip()}")
        if open(os.path.join(root, "summary.json"), "rb").read() != summary_bytes:
            fail("re-verification did not reproduce summary.json byte for byte")
    summary = json.loads(summary_bytes)
    pairs = sorted((p["pair_address"], p["token0"], p["token1"]) for p in summary["pairs"])
    pinned = sorted((p["pair_address"], p["token0"], p["token1"]) for p in evidence["pairs"])
    if pairs != pinned:
        fail(f"evidence proves {pairs}, the manifest pins {pinned}")
    anchor = (summary["chain_id"], summary["block_number"], summary["block_hash"])
    if anchor != (evidence["chain_id"], evidence["block_number"], evidence["block_hash"]):
        fail(f"evidence anchor {anchor} differs from the manifest")
    return len(pairs)


def github(path):
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("no GitHub token to verify the certification run (use --offline only locally)")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/{path}",
        headers={"authorization": f"Bearer {token}", "accept": "application/vnd.github+json",
                 "user-agent": "nqc-rmc001-freeze"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def verify_certification(manifest, allow_pending, offline):
    cert = manifest["certification"]
    if cert.get("status") == "PENDING":
        if not allow_pending:
            fail("RMC-001-A1 is not certified yet")
        print("RMC_001_FREEZE_CERTIFICATION PENDING")
        return
    if cert.get("status") != "CERTIFIED":
        fail(f"unknown certification status {cert.get('status')!r}")
    if cert.get("workflow") != CERTIFYING_WORKFLOW:
        fail("certification is not a run of the RMC-001 workflow")
    head = cert["head_sha"]
    full_sha(head, "certification head_sha")
    if not is_ancestor(head, "HEAD"):
        fail("the certified commit is not an ancestor of HEAD")
    certified = json.loads(git("show", f"{head}:{MANIFEST}"))
    if sha256(git("show", f"{head}:{MANIFEST}", binary=True)) != cert["manifest_sha256"]:
        fail("certified manifest digest differs")
    if without_certification(certified) != without_certification(manifest):
        fail("the certified manifest pinned other content than this one")
    if offline:
        print(f"RMC_001_FREEZE_CERTIFICATION OFFLINE_GIT_ONLY run={cert['run_id']} head={head}")
        return
    run = github(f"actions/runs/{int(cert['run_id'])}")
    if (run.get("head_sha"), run.get("conclusion"), run.get("path"), run.get("status")) != (
            head, "success", CERTIFYING_WORKFLOW, "completed"):
        fail(f"run {cert['run_id']} is not a successful RMC-001 run on {head}: "
             f"{run.get('head_sha')} {run.get('status')} {run.get('conclusion')} {run.get('path')}")
    print(f"RMC_001_FREEZE_CERTIFICATION CERTIFIED run={cert['run_id']} head={head}")


def main(argv):
    allow_pending = "--allow-pending" in argv
    offline = "--offline" in argv
    rest = [a for a in argv[1:] if not a.startswith("--")]
    path = rest[0] if rest else MANIFEST
    raw = open(path, "rb").read()
    manifest = json.loads(raw)
    if (manifest.get("schema_version"), manifest.get("contract"), manifest.get("amendment_id")) != (
            SCHEMA_VERSION, CONTRACT, AMENDMENT):
        fail("manifest is not the RMC-001-A1 freeze manifest")
    base, authority, tree = (manifest["base_authority_commit"], manifest["authority_commit"],
                             manifest["authority_tree"])
    for value, name in ((base, "base"), (authority, "authority"), (tree, "authority tree")):
        full_sha(value, name)
    if not is_ancestor(base, authority):
        fail("the original authority is not an ancestor of the amendment authority")
    if not is_ancestor(authority, "HEAD"):
        fail("the amendment authority is not an ancestor of HEAD")
    if git("rev-parse", f"{authority}^{{tree}}") != tree:
        fail("authority tree differs from the manifest")

    files = {entry["file_path"]: entry for entry in manifest["files"]}
    if len(files) != len(manifest["files"]) or set(files) != REQUIRED_FILES:
        fail(f"frozen file set differs: {sorted(set(files) ^ REQUIRED_FILES)}")
    unchanged = {p for p, e in files.items() if e.get("unchanged_since_base")}
    if unchanged != REQUIRED_UNCHANGED:
        fail(f"unchanged-since-base set differs: {sorted(unchanged ^ REQUIRED_UNCHANGED)}")
    for file_path, entry in sorted(files.items()):
        pinned = entry["sha256"]
        if sha256(open(file_path, "rb").read()) != pinned:
            fail(f"{file_path} at HEAD differs from its pin")
        if sha256(git("show", f"{authority}:{file_path}", binary=True)) != pinned:
            fail(f"{file_path} at the authority commit differs from its pin")
        if entry.get("unchanged_since_base") and sha256(
                git("show", f"{base}:{file_path}", binary=True)) != pinned:
            fail(f"{file_path} changed since the original authority")
    gates = {entry["file_path"]: entry["sha256"] for entry in manifest["gate_files"]}
    if set(gates) != REQUIRED_GATES:
        fail(f"gate file set differs: {sorted(set(gates) ^ REQUIRED_GATES)}")
    for file_path, pinned in sorted(gates.items()):
        if sha256(open(file_path, "rb").read()) != pinned:
            fail(f"gate {file_path} differs from its pin")

    stability = manifest["backward_stability"]
    test_source = open("nqc-census/crates/nqc-census-core/tests/identity_amendment_1.rs").read()
    constant = re.search(r'ORIGINAL_CORPUS_SHA256: &str =\s*"([0-9a-f]{64})"', test_source)
    if not constant or constant.group(1) != stability["original_corpus_sha256"]:
        fail("the backward-stability digest differs from the pinned test constant")
    if stability.get("corpus_entries") != 10704:
        fail("the backward-stability corpus size differs")

    pairs = verify_evidence(manifest, files)
    verify_certification(manifest, allow_pending, offline)
    print(f"RMC_001_FREEZE_MANIFEST_PASS amendment={AMENDMENT} authority={authority} "
          f"files={len(files)} gates={len(gates)} evidence_pairs={pairs} "
          f"manifest_sha256={sha256(raw)}")


if __name__ == "__main__":
    main(sys.argv)

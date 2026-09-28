#!/usr/bin/env python3
"""RMC-004 mutation gate: proves the adversarial suite attacks properties.

Each mutant disables one invariant of nqc-census-store in a private copy of the
nqc-census workspace (never in the repository checkout). The gate passes only
if every mutant is killed: the Rust suite fails, or, for durability mutants that
no in-process test can observe, the syscall-ordering gate fails.

Usage: store_mutation_gate.py --workspace nqc-census --scratch DIR
Exit status: 0 all mutants killed, 1 a mutant survived or setup failed.
"""

import os
import shutil
import subprocess
import sys

TRACE = ["strace", "-f", "-y", "-qq", "-e",
         "trace=linkat,link,rename,renameat,renameat2,fsync,fdatasync"]

# (id, file, original, replacement, oracle)
MUTANTS = [
    ("M01_parent_lineage_unchecked", "checkpoint.rs",
     "if next.first.parent_hash() != self.last.block_hash() {",
     "if false && next.first.parent_hash() != self.last.block_hash() {", "tests"),
    ("M02_link_replaced_by_rename", "durable.rs",
     "match fs::hard_link(&staged, &target) {",
     "match fs::rename(&staged, &target).and_then(|_| fs::hard_link(&target, &staged)) {",
     "tests"),
    ("M03_match_overflow_unbounded", "codec.rs",
     "            if out.len() + length > raw_len {\n                return Err(CodecError::OutputOverflow);\n            }\n",
     "", "tests"),
    ("M04_head_ahead_accepted", "store.rs",
     "if tip_sequence.is_none_or(|sequence| record.sequence > sequence) {",
     "if false && tip_sequence.is_none_or(|sequence| record.sequence > sequence) {", "tests"),
    ("M05_canonical_manifest_unchecked", "store.rs",
     "        if encoded.manifest_bytes != manifest_bytes {",
     "        if false && encoded.manifest_bytes != manifest_bytes {", "tests"),
    ("M06_range_completion_off_by_one", "store.rs",
     "            if checkpoint.last_block() >= last {",
     "            if checkpoint.last_block() + 1 >= last {", "tests"),
    ("M07_conflicting_retry_accepted", "store.rs",
     "            if existing != bytes {\n                return Err(StoreError::SequenceConflict { sequence });",
     "            if false && existing != bytes {\n                return Err(StoreError::SequenceConflict { sequence });",
     "tests"),
    ("M08_frame_digest_unchecked", "store.rs",
     "            if object::frame_digest(&frame) != entry.frame_digest {",
     "            if false && object::frame_digest(&frame) != entry.frame_digest {", "tests"),
    ("M09_directory_fsync_skipped", "durable.rs",
     "        self.fire(points.linked)?;\n        sync_dir(dir)?;",
     "        self.fire(points.linked)?;", "trace"),
    ("M10_staged_file_fsync_skipped", "durable.rs",
     "                    file.sync_all()\n                        .map_err(|error| StoreError::io(\"fsync\", &path, &error))?;\n",
     "", "trace"),
    ("M11_gap_accepted", "checkpoint.rs",
     "            Some(expected) if next.first_block() == expected => {}",
     "            Some(_) if next.first_block() > self.last_block() => {}", "tests"),
    ("M12_head_contradiction_ignored", "store.rs",
     "        if checkpoint.id()? != head.checkpoint_id {\n            return Err(StoreError::HeadConflictsWithAuthority);",
     "        if false && checkpoint.id()? != head.checkpoint_id {\n            return Err(StoreError::HeadConflictsWithAuthority);",
     "tests"),
    # The STORE seal and the canonical re-encoding comparison are mutually
    # redundant (removing either alone is an equivalent mutant), so this mutant
    # removes both: the persisted policy then has no integrity protection at all.
    ("M13_store_policy_integrity_removed", "config.rs",
     "        if fields.fixed::<32>(7)? != *config.id()?.as_bytes() {\n"
     "            return Err(StoreError::DigestMismatch {\n"
     "                object: Kind::Config.name(),\n"
     "            });\n"
     "        }\n"
     "        if config.sealed_bytes()? != bytes {\n"
     "            return Err(StoreError::NonCanonical {\n"
     "                object: Kind::Config.name(),\n"
     "            });\n"
     "        }\n",
     "", "tests"),
    ("M14_verifier_unknown_entries_allowed", "verify.rs",
     "            if !expected.contains(&name.as_str()) {",
     "            if false && !expected.contains(&name.as_str()) {", "tests"),
]


def run(cmd, cwd, env, log):
    with open(log, "w", encoding="utf-8") as handle:
        return subprocess.run(cmd, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT,
                              timeout=1800).returncode


def main():
    if len(sys.argv) != 5 or sys.argv[1] != "--workspace" or sys.argv[3] != "--scratch":
        print("usage: store_mutation_gate.py --workspace DIR --scratch DIR", file=sys.stderr)
        return 1
    source = os.path.abspath(sys.argv[2])
    scratch = os.path.abspath(sys.argv[4])
    repo_root = os.path.dirname(source)
    if scratch.startswith(repo_root + os.sep):
        print("MUTATION_GATE=FAIL reason=scratch must be outside the repository", file=sys.stderr)
        return 1
    checker = os.path.join(repo_root, "ci", "nqc-census", "check_durability_trace.py")
    shutil.rmtree(scratch, ignore_errors=True)
    workspace = os.path.join(scratch, "workspace")
    shutil.copytree(source, workspace, ignore=shutil.ignore_patterns("target"))
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(scratch, "target"), CARGO_TERM_COLOR="never")
    src = os.path.join(workspace, "crates", "nqc-census-store", "src")

    baseline = run(["cargo", "test", "--locked", "-q", "-p", "nqc-census-store"], workspace, env,
                   os.path.join(scratch, "baseline.log"))
    if baseline != 0:
        print("MUTATION_GATE=FAIL reason=unmutated suite is not green", file=sys.stderr)
        return 1

    survivors = []
    for ident, name, original, replacement, oracle in MUTANTS:
        path = os.path.join(src, name)
        with open(path, encoding="utf-8") as handle:
            pristine = handle.read()
        if pristine.count(original) != 1:
            print(f"MUTATION_GATE=FAIL reason={ident} anchor not found exactly once", file=sys.stderr)
            return 1
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(pristine.replace(original, replacement, 1))
        try:
            log = os.path.join(scratch, f"{ident}.log")
            if oracle == "tests":
                killed = run(["cargo", "test", "--locked", "-q", "-p", "nqc-census-store"],
                             workspace, env, log) != 0
            else:
                built = run(["cargo", "build", "--locked", "-q", "-p", "nqc-census-store",
                             "--example", "rmc004_fixture"], workspace, env, log)
                if built != 0:
                    print(f"MUTATION_GATE=FAIL reason={ident} did not build", file=sys.stderr)
                    return 1
                store = os.path.join(scratch, f"{ident}-store")
                trace = os.path.join(scratch, f"{ident}.trace")
                fixture = os.path.join(env["CARGO_TARGET_DIR"], "debug", "examples", "rmc004_fixture")
                if run(TRACE + ["-o", trace, fixture, store], scratch, env, log + ".fixture") != 0:
                    print(f"MUTATION_GATE=FAIL reason={ident} fixture failed", file=sys.stderr)
                    return 1
                killed = subprocess.run(
                    [sys.executable, checker, "--store", store, "--trace", trace],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
        finally:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(pristine)
        print(f"{ident} oracle={oracle} {'KILLED' if killed else 'SURVIVED'}")
        if not killed:
            survivors.append(ident)

    if survivors:
        print(f"MUTATION_GATE=FAIL survivors={','.join(survivors)}", file=sys.stderr)
        return 1
    print(f"MUTATION_GATE=PASS mutants={len(MUTANTS)} killed={len(MUTANTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Authenticate the one immutable RMC-006 seed, without network or replay.

The caller must obtain metadata from the pinned GitHub API endpoints over its
authenticated connection. Local JSON is not proof of its own API origin. Raw
REST responses and the recorded connector structuredContent envelopes are
accepted; API extensions are ignored, while our pin/index/report schemas are
closed. The CLI uses the actual UTC clock, never a caller-supplied date.

This proves package/source identity only. Store semantics, current/history
replay, disconnected execution and new-checkout closeout remain separate gates.
No new PASS, certification, acquisition time or producer identity is minted.
"""

import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile
import zlib


PIN_PATH = Path(__file__).with_name("rmc006-recertification-source.json")
PIN_KEYS = {
    "schema", "repository", "workflow", "run", "artifact", "index", "anchor",
    "chain_domain", "scope", "history_range", "current_providers",
    "history_providers", "store_evidence_root", "source_report_hashes",
    "source_report_fields", "history_summary", "resume",
    "required_empty_directories",
}
INDEX_KEYS = {
    "code_commit", "code_tree", "files", "job_status", "schema",
    "workflow_run_attempt", "workflow_run_id",
}
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_EXPANDED_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 5000
HEX64 = re.compile(r"[0-9a-f]{64}\Z")


class SourceError(Exception):
    """A fail-closed source authentication error."""


def require(condition, message):
    if not condition:
        raise SourceError(message)


def equal(actual, expected, label):
    # Python considers True == 1 and 1.0 == 1. Identity fields must not.
    require(type(actual) is type(expected), f"{label}: differs from pinned source")
    if isinstance(expected, dict):
        require(set(actual) == set(expected), f"{label}: differs from pinned source")
        for key in expected:
            equal(actual[key], expected[key], label + "." + key)
    elif isinstance(expected, list):
        require(len(actual) == len(expected), f"{label}: differs from pinned source")
        for item, wanted in zip(actual, expected):
            equal(item, wanted, label)
    else:
        require(actual == expected, f"{label}: differs from pinned source")


def exact_keys(value, keys, label):
    require(type(value) is dict and set(value) == set(keys),
            f"{label}: unknown or missing fields")


def strict_json(data, label):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"{label}: duplicate JSON key {key}")
            result[key] = value
        return result

    def constant(value):
        raise SourceError(f"{label}: non-finite JSON value {value}")

    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SourceError(f"{label}: invalid JSON") from error
    require(type(value) is dict, f"{label}: expected JSON object")
    return value


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, limit):
    """Do not follow a final symlink or read unbounded/FIFO/device inputs."""
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode), f"{path}: expected regular file")
    require(info.st_size <= limit, f"{path}: size limit")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_size <= limit,
                f"{path}: changed file type or size")
        data = stream.read(limit + 1)
    require(len(data) <= limit, f"{path}: size limit")
    return data


def utc_time(value, label):
    require(type(value) is str and
            re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value),
            f"{label}: expected UTC timestamp")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise SourceError(f"{label}: invalid timestamp") from error


def safe_path(name):
    require(type(name) is str and 0 < len(name) <= 512,
            "member: invalid path length/type")
    parts = name.split("/")
    require(len(parts) <= 12, f"member: excessive path depth {name}")
    for part in parts:
        require(part not in ("", ".", "..") and
                re.fullmatch(r"[A-Za-z0-9_.-]+", part) is not None and
                not part.endswith("."), f"member: unsafe path {name}")
        require(part.split(".")[0].upper() not in
                {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)],
                 *[f"LPT{i}" for i in range(1, 10)]},
                f"member: reserved path {name}")
    return name


def load_pin(path=PIN_PATH):
    pin = strict_json(read_regular(path, MAX_METADATA_BYTES), "source pin")
    exact_keys(pin, PIN_KEYS, "source pin")
    equal(pin["schema"], "nqc-rmc006-recertification-source-v1", "pin schema")
    for key, fields in {
        "repository": {"full_name", "id"},
        "workflow": {"id", "name", "path"},
        "run": {"id", "attempt", "event", "head_sha", "head_branch", "tree_sha",
                "status", "conclusion"},
        "artifact": {"id", "name", "size_in_bytes", "created_at", "expires_at", "digest"},
        "index": {"schema", "sha256", "indexed_members", "zip_members", "uncompressed_bytes"},
        "anchor": {"hash", "number", "parent_hash", "state_root", "timestamp"},
    }.items():
        exact_keys(pin[key], fields, f"pin {key}")
    equal(pin["run"]["status"], "completed", "pin status")
    equal(pin["run"]["conclusion"], "success", "pin conclusion")
    equal(pin["run"]["attempt"], 1, "pin original attempt")
    equal(pin["index"]["schema"], "nqc-rmc006-evidence-index-v1", "pin index schema")
    require(HEX64.fullmatch(pin["index"]["sha256"]) is not None, "pin index digest")
    require(HEX64.fullmatch(pin["store_evidence_root"]) is not None, "pin store root")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", pin["artifact"]["digest"]) is not None,
            "pin archive digest")
    require(pin["index"]["zip_members"] == pin["index"]["indexed_members"] + 1,
            "pin member counts")
    equal(pin["required_empty_directories"], ["store/tmp"], "pin empty directories")
    for name, digest in pin["source_report_hashes"].items():
        safe_path(name)
        require(type(digest) is str and HEX64.fullmatch(digest) is not None,
                "pin report digest")
    equal(sorted(pin["source_report_hashes"]), sorted(pin["source_report_fields"]),
          "pin report inventory")
    return pin


def metadata_payload(value):
    """Unwrap only actual observed connector formats, never arbitrary text."""
    require(type(value) is dict, "metadata: expected object")
    if "structuredContent" in value:
        require(value.get("isError") is False, "metadata: failed connector response")
        value = value["structuredContent"]
        require(type(value) is dict, "metadata: invalid structuredContent")
        if "content" in value:
            require(type(value["content"]) is str, "metadata: invalid REST content")
            value = strict_json(value["content"], "REST metadata")
    return value


def authenticate_metadata(pin, run, artifact, commit, now):
    run, artifact, commit = map(metadata_payload, (run, artifact, commit))
    if "artifacts" in artifact:
        require(type(artifact["artifacts"]) is list and len(artifact["artifacts"]) == 1,
                "artifact metadata: expected the one original artifact")
        artifact = artifact["artifacts"][0]
    require(all(type(obj) is dict for obj in (run, artifact, commit)),
            "metadata: expected objects")
    repo = pin["repository"]
    api = "https://api.github.com/repos/" + repo["full_name"]
    expected_run = {
        "id": pin["run"]["id"], "run_attempt": pin["run"]["attempt"],
        "name": pin["workflow"]["name"], "path": pin["workflow"]["path"],
        "workflow_id": pin["workflow"]["id"], "head_sha": pin["run"]["head_sha"],
        "head_branch": pin["run"]["head_branch"], "event": pin["run"]["event"],
        "status": "completed", "conclusion": "success",
        "url": f"{api}/actions/runs/{pin['run']['id']}",
        "html_url": f"https://github.com/{repo['full_name']}/actions/runs/{pin['run']['id']}",
        "workflow_url": f"{api}/actions/workflows/{pin['workflow']['id']}",
    }
    for key, expected in expected_run.items():
        equal(run.get(key), expected, "run " + key)
    for key in ("repository", "head_repository"):
        require(type(run.get(key)) is dict, "run " + key)
        for field in ("full_name", "id"):
            equal(run[key].get(field), repo[field], "run " + key + " " + field)
    require(type(run.get("head_commit")) is dict, "run head_commit")
    equal(run["head_commit"].get("id"), pin["run"]["head_sha"], "run commit")
    equal(run["head_commit"].get("tree_id"), pin["run"]["tree_sha"], "run tree")
    for key, expected in pin["artifact"].items():
        equal(artifact.get(key), expected, "artifact " + key)
    equal(artifact.get("expired"), False, "artifact expired")
    expires = utc_time(artifact["expires_at"], "artifact expires_at")
    created = utc_time(artifact["created_at"], "artifact created_at")
    require(now.tzinfo is not None and created <= now < expires,
            "artifact: expired or not yet created at authentication time")
    for key, expected in {
        "url": f"{api}/actions/artifacts/{pin['artifact']['id']}",
        "archive_download_url": f"{api}/actions/artifacts/{pin['artifact']['id']}/zip",
    }.items():
        equal(artifact.get(key), expected, "artifact " + key)
    arun = artifact.get("workflow_run")
    require(type(arun) is dict, "artifact workflow_run")
    for key, expected in {
        "id": pin["run"]["id"], "repository_id": repo["id"],
        "head_repository_id": repo["id"], "head_sha": pin["run"]["head_sha"],
        "head_branch": pin["run"]["head_branch"],
    }.items():
        equal(arun.get(key), expected, "artifact workflow_run " + key)
    equal(commit.get("sha"), pin["run"]["head_sha"], "commit sha")
    equal(commit.get("url"), f"{api}/git/commits/{pin['run']['head_sha']}", "commit URL")
    require(type(commit.get("tree")) is dict, "commit tree")
    equal(commit["tree"].get("sha"), pin["run"]["tree_sha"], "commit tree sha")
    equal(commit["tree"].get("url"), f"{api}/git/trees/{pin['run']['tree_sha']}",
          "commit tree URL")


def authenticate_index(pin, data, names):
    index = strict_json(data, "evidence index")
    exact_keys(index, INDEX_KEYS, "evidence index")
    for key, expected in {
        "schema": pin["index"]["schema"], "code_commit": pin["run"]["head_sha"],
        "code_tree": pin["run"]["tree_sha"], "job_status": "success",
        "workflow_run_id": str(pin["run"]["id"]),
        "workflow_run_attempt": str(pin["run"]["attempt"]),
    }.items():
        equal(index.get(key), expected, "index " + key)
    files = index["files"]
    require(type(files) is list and len(files) == pin["index"]["indexed_members"],
            "index: member count")
    inventory = {}
    portable = set()
    for row in files:
        exact_keys(row, {"path", "size", "sha256"}, "index member")
        name = safe_path(row["path"])
        require(name != "evidence-index.json" and name.casefold() not in portable,
                "index: duplicate or self-indexed member")
        require(type(row["size"]) is int and 0 <= row["size"] <= MAX_EXPANDED_BYTES,
                "index: invalid member size")
        require(type(row["sha256"]) is str and HEX64.fullmatch(row["sha256"]) is not None,
                "index: invalid member digest")
        portable.add(name.casefold())
        inventory[name] = row
    equal(set(inventory) | {"evidence-index.json"}, set(names), "index ZIP membership")
    equal(sha256(data), pin["index"]["sha256"], "index SHA-256")
    return index, inventory


def authenticate_reports(pin, members):
    reports = {}
    for name, digest in pin["source_report_hashes"].items():
        require(name in members, "source report missing: " + name)
        report = strict_json(members[name], name)
        exact_keys(report, pin["source_report_fields"][name], name)
        reports[name] = report
        equal(sha256(members[name]), digest, name + " original bytes")
    for name, providers, schema, status_value in (
        ("aave-current-surface.json", pin["current_providers"],
         "nqc-rmc-006-aave-current-surface-v1", "CURRENT_SURFACE_PASS"),
        ("aave-history.json", pin["history_providers"],
         "nqc-rmc-006-aave-history-reconciliation-v2", "HISTORY_RECONCILIATION_PASS"),
    ):
        report = reports[name]
        equal(report["schema"], schema, name + " schema")
        equal(report["status"], status_value, name + " original status")
        bootstrap = report["bootstrap"]
        exact_keys(bootstrap, {"anchor", "chain_domain", "infrastructure_independence",
                               "provider_count", "providers", "schema"}, name + " bootstrap")
        equal(bootstrap["schema"], "nqc-census-chain-bootstrap-report-v1", "bootstrap schema")
        equal(bootstrap["anchor"], {"anchor": pin["anchor"]}, name + " anchor")
        equal(bootstrap["chain_domain"], pin["chain_domain"], name + " chain domain")
        equal(bootstrap["provider_count"], len(providers), name + " provider count")
        observed = bootstrap["providers"]
        require(type(observed) is list and len(observed) == len(providers), name + " providers")
        for row, expected in zip(observed, providers):
            exact_keys(row, {"provider", "anchor_manifest", "bootstrap_manifest", "client_version"},
                       name + " provider")
            equal(row["provider"], expected, name + " provider identity/namespace")
    current = reports["aave-current-surface.json"]
    equal([row["provider"] for row in current["provider_manifests"]],
          [row["label"] for row in pin["current_providers"]], "current manifest providers")
    history = reports["aave-history.json"]
    equal(history["summary"], pin["history_summary"], "original history summary")
    equal(len(history["replay_manifests"]), 70, "history replay manifest count")
    equal(reports["aave-resume-equivalence.json"], pin["resume"], "original resume report")
    discovery_run = reports["closeout/aave-discovery-run.json"]
    equal(discovery_run["scope"], pin["scope"], "original scope")
    equal(discovery_run["observation_anchor"], pin["anchor"], "closeout anchor")
    equal(discovery_run["history_range"], pin["history_range"], "history range")
    for name in ("closeout/evidence-manifest.json", "closeout/aave-discovery-run.json",
                 "closeout/aave-discovery-summary.json"):
        equal(reports[name]["code_commit"], pin["run"]["head_sha"], name + " producer commit")
        equal(reports[name]["code_tree"], pin["run"]["tree_sha"], name + " producer tree")
    # This is the authenticated ORIGINAL verifier log, not a new store verification.
    log = members["final-store-verify.log"].decode("ascii").splitlines()
    equal([line for line in log if line.startswith("evidence_root=")],
          ["evidence_root=" + pin["store_evidence_root"]], "original store root")
    require("RMC_004_OFFLINE_VERIFY=PASS" in log, "missing original store verification")


def authenticate_archive(pin, data):
    equal(len(data), pin["artifact"]["size_in_bytes"], "archive size")
    equal("sha256:" + sha256(data), pin["artifact"]["digest"], "archive SHA-256")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(len(entries) <= MAX_MEMBERS, "ZIP: member limit")
            equal(len(entries), pin["index"]["zip_members"], "ZIP member count")
            names, portable = set(), set()
            total = 0
            for entry in entries:
                name = safe_path(entry.filename)
                equal(entry.orig_filename, name, "ZIP original name")
                require(name.casefold() not in portable, "ZIP: duplicate member")
                portable.add(name.casefold())
                names.add(name)
                mode = entry.external_attr >> 16
                require(entry.create_system == 3 and stat.S_ISREG(mode),
                        "ZIP: non-regular/symlink member " + name)
                require(not entry.is_dir() and not (entry.flag_bits & 1),
                        "ZIP: directory or encrypted member " + name)
                require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        "ZIP: unsupported compression")
                total += entry.file_size
                require(total <= MAX_EXPANDED_BYTES, "ZIP: expanded size limit")
            equal(total, pin["index"]["uncompressed_bytes"], "ZIP expanded size")
            for name in names:
                require(not any(parent.as_posix() in names for parent in Path(name).parents
                                if parent.as_posix() != "."), "ZIP: file/directory collision")
            require("evidence-index.json" in names, "ZIP: missing evidence index")
            index_data = archive.read("evidence-index.json")
            index, inventory = authenticate_index(pin, index_data, names)
            members = {"evidence-index.json": index_data}
            for name, row in inventory.items():
                entry = archive.getinfo(name)
                equal(entry.file_size, row["size"], name + " indexed size")
                contents = archive.read(entry)
                equal(len(contents), row["size"], name + " actual size")
                equal(sha256(contents), row["sha256"], name + " SHA-256")
                members[name] = contents
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, EOFError, zlib.error) as error:
        raise SourceError("ZIP: invalid or unsupported archive") from error
    authenticate_reports(pin, members)
    return members, index


def allowed_directories(pin, members):
    return {parent.as_posix() for name in members for parent in Path(name).parents
            if parent.as_posix() != "."} | set(pin["required_empty_directories"])


def no_symlink_ancestors(path):
    absolute = Path(os.path.abspath(path))
    for item in (absolute, *absolute.parents):
        if item.exists() or item.is_symlink():
            require(not item.is_symlink(), f"output/input directory symlink: {item}")
    return absolute


def extract_members(pin, members, destination):
    destination = no_symlink_ancestors(destination)
    require(destination.parent.is_dir(), "extraction parent must already exist")
    # Never overwrite or merge with an existing tree, even an empty one.
    destination.mkdir(mode=0o700, exist_ok=False)
    for name in sorted(allowed_directories(pin, members), key=lambda p: (p.count("/"), p)):
        (destination / name).mkdir(mode=0o700)
    for name, contents in members.items():
        with (destination / name).open("xb") as stream:
            stream.write(contents)
        (destination / name).chmod(0o444)
    verify_extracted(pin, members, destination)


def verify_extracted(pin, members, directory):
    directory = no_symlink_ancestors(directory)
    require(directory.is_dir(), "extracted source must be a directory")
    expected_dirs = allowed_directories(pin, members)
    found, found_dirs = set(), set()
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            info = path.lstat()
            require(not stat.S_ISLNK(info.st_mode), "extracted source: symlink " + relative)
            if stat.S_ISDIR(info.st_mode):
                require(relative in expected_dirs, "extracted source: unexpected directory " + relative)
                found_dirs.add(relative)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                        "extracted source: non-regular or linked member " + relative)
                require(relative in members, "extracted source: unindexed member " + relative)
                equal(read_regular(path, MAX_EXPANDED_BYTES), members[relative],
                      "extracted source bytes " + relative)
                found.add(relative)
    equal(found, set(members), "extracted source file inventory")
    equal(found_dirs, expected_dirs, "extracted source directory inventory")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--run-metadata", required=True, type=Path)
    parser.add_argument("--artifact-metadata", required=True, type=Path)
    parser.add_argument("--commit-metadata", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--extract-to", type=Path)
    output.add_argument("--verify-extracted", type=Path)
    args = parser.parse_args(argv)
    try:
        pin = load_pin()
        now = dt.datetime.now(dt.timezone.utc)
        snapshots = {key: read_regular(path, MAX_METADATA_BYTES) for key, path in (
            ("run", args.run_metadata), ("artifact", args.artifact_metadata),
            ("commit", args.commit_metadata))}
        authenticate_metadata(pin, *(strict_json(snapshots[key], key + " metadata")
                                    for key in ("run", "artifact", "commit")), now=now)
        archive_data = read_regular(args.archive, MAX_ARCHIVE_BYTES)
        members, index = authenticate_archive(pin, archive_data)
        provenance_path = no_symlink_ancestors(args.provenance)
        require(not provenance_path.exists(), "provenance must be a new file")
        source_path = args.extract_to or args.verify_extracted
        if source_path:
            source_path = no_symlink_ancestors(source_path)
            require(not provenance_path.is_relative_to(source_path),
                    "provenance must be outside the immutable source tree")
        if args.extract_to:
            extract_members(pin, members, args.extract_to)
        if args.verify_extracted:
            verify_extracted(pin, members, args.verify_extracted)
        provenance = {
            "schema": "nqc-rmc006-source-authentication-v1",
            "kind": "IMMUTABLE_ORIGINAL_SOURCE_AUTHENTICATION",
            "authenticated_at": now.isoformat().replace("+00:00", "Z"),
            "canonical_recertification": False,
            "semantic_replay_performed": False,
            "independent_store_verification_performed": False,
            "metadata_trust_basis": "CALLER_OBTAINED_GITHUB_API_SNAPSHOTS",
            "metadata_snapshot_sha256": {key: sha256(value) for key, value in snapshots.items()},
            "source_pin_sha256": sha256(read_regular(PIN_PATH, MAX_METADATA_BYTES)),
            "original_repository": pin["repository"], "original_workflow": pin["workflow"],
            "original_run": pin["run"], "original_artifact": pin["artifact"],
            "original_observation_anchor": pin["anchor"],
            "original_store_evidence_root": pin["store_evidence_root"],
            "original_evidence_index_sha256": pin["index"]["sha256"],
            "indexed_member_count": len(index["files"]),
            "original_indexed_members": index["files"],
            "documented_empty_directories": pin["required_empty_directories"],
            "extracted_source_rechecked": source_path is not None,
        }
        with provenance_path.open("x", encoding="utf-8") as stream:
            json.dump(provenance, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
    except (SourceError, OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        print(f"RMC006_SOURCE_AUTHENTICATION_FAILED: {error}", file=sys.stderr)
        return 1
    print(f"RMC006_SOURCE_AUTHENTICATED original_run={pin['run']['id']} "
          f"indexed_members={len(index['files'])} canonical_recertification=false")
    return 0


if __name__ == "__main__":
    sys.exit(main())

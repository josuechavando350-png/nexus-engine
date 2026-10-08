#!/usr/bin/env python3
"""Offline authentication regressions. No downloads, RPC or CI dispatch.

Run: python -m unittest discover -s ci/nqc-census -p test_rmc006_recertification_source.py -v

For the real package integration also set RMC006_SOURCE_ARCHIVE,
RMC006_SOURCE_RUN_METADATA, RMC006_SOURCE_ARTIFACT_METADATA and
RMC006_SOURCE_COMMIT_METADATA to already-downloaded local files. The real
metadata test uses the actual clock and therefore refuses an expired artifact.
The pure tests explicitly use an injected historical clock; the production CLI
has no such override. Synthetic pins below are internal test fixtures, never an
accepted CLI option or evidence of semantic/canonical recertification.
"""

import copy
import datetime as dt
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

import verify_rmc006_recertification_source as source


NOW = dt.datetime(2026, 10, 8, 21, 0, tzinfo=dt.timezone.utc)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def api_fixtures(pin):
    """Minimal synthetic API field fixtures, not recorded API responses."""
    api = "https://api.github.com/repos/" + pin["repository"]["full_name"]
    run = {
        "id": pin["run"]["id"], "run_attempt": pin["run"]["attempt"],
        "name": pin["workflow"]["name"], "path": pin["workflow"]["path"],
        "workflow_id": pin["workflow"]["id"], "head_sha": pin["run"]["head_sha"],
        "head_branch": pin["run"]["head_branch"], "event": "workflow_dispatch",
        "status": "completed", "conclusion": "success",
        "url": f"{api}/actions/runs/{pin['run']['id']}",
        "html_url": f"https://github.com/{pin['repository']['full_name']}/actions/runs/{pin['run']['id']}",
        "workflow_url": f"{api}/actions/workflows/{pin['workflow']['id']}",
        "repository": copy.deepcopy(pin["repository"]),
        "head_repository": copy.deepcopy(pin["repository"]),
        "head_commit": {"id": pin["run"]["head_sha"], "tree_id": pin["run"]["tree_sha"]},
    }
    artifact = {
        **pin["artifact"], "expired": False,
        "url": f"{api}/actions/artifacts/{pin['artifact']['id']}",
        "archive_download_url": f"{api}/actions/artifacts/{pin['artifact']['id']}/zip",
        "workflow_run": {
            "id": pin["run"]["id"], "repository_id": pin["repository"]["id"],
            "head_repository_id": pin["repository"]["id"],
            "head_sha": pin["run"]["head_sha"], "head_branch": pin["run"]["head_branch"],
        },
    }
    commit = {
        "sha": pin["run"]["head_sha"],
        "url": f"{api}/git/commits/{pin['run']['head_sha']}",
        "tree": {"sha": pin["run"]["tree_sha"],
                 "url": f"{api}/git/trees/{pin['run']['tree_sha']}"},
    }
    return run, artifact, commit


def synthetic_reports(pin):
    """Shape fixtures exercise authentication only, not valid RMC store semantics."""
    reports = {name: dict.fromkeys(fields) for name, fields in pin["source_report_fields"].items()}
    for name, providers, schema, status in (
        ("aave-current-surface.json", pin["current_providers"],
         "nqc-rmc-006-aave-current-surface-v1", "CURRENT_SURFACE_PASS"),
        ("aave-history.json", pin["history_providers"],
         "nqc-rmc-006-aave-history-reconciliation-v2", "HISTORY_RECONCILIATION_PASS"),
    ):
        reports[name].update({
            "schema": schema, "status": status,
            "bootstrap": {
                "schema": "nqc-census-chain-bootstrap-report-v1",
                "anchor": {"anchor": pin["anchor"]}, "chain_domain": pin["chain_domain"],
                "infrastructure_independence": "NOT_PROVEN_DISTINCT_DECLARED_OPERATORS",
                "provider_count": len(providers),
                "providers": [{"provider": provider, "anchor_manifest": "a" * 64,
                               "bootstrap_manifest": "b" * 64, "client_version": "test fixture"}
                              for provider in providers],
            },
        })
    reports["aave-current-surface.json"]["provider_manifests"] = [
        {"provider": p["label"], "manifest": "c" * 64} for p in pin["current_providers"]]
    reports["aave-history.json"].update({"summary": pin["history_summary"],
                                       "replay_manifests": [f"{n:064x}" for n in range(70)]})
    reports["aave-resume-equivalence.json"] = copy.deepcopy(pin["resume"])
    reports["closeout/aave-discovery-run.json"].update({
        "scope": pin["scope"], "observation_anchor": pin["anchor"],
        "history_range": pin["history_range"],
    })
    for name in ("closeout/evidence-manifest.json", "closeout/aave-discovery-run.json",
                 "closeout/aave-discovery-summary.json"):
        reports[name].update({"code_commit": pin["run"]["head_sha"],
                              "code_tree": pin["run"]["tree_sha"]})
    return copy.deepcopy(reports)


def make_archive(pin, members, entries=None):
    """Re-pin ONLY test bytes to reach deeper checks behind outer digest defense."""
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, body, mode in entries or [(n, d, stat.S_IFREG | 0o644)
                                              for n, d in members.items()]:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = mode << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, body)
    data = buffer.getvalue()
    pin = copy.deepcopy(pin)
    pin["artifact"]["size_in_bytes"] = len(data)
    pin["artifact"]["digest"] = "sha256:" + source.sha256(data)
    return pin, data


def synthetic_package():
    pin = copy.deepcopy(source.load_pin())
    reports = synthetic_reports(pin)
    members = {name: encoded(value) for name, value in reports.items()}
    members["final-store-verify.log"] = (
        "RMC_004_OFFLINE_VERIFY=PASS\nevidence_root=" + pin["store_evidence_root"] + "\n").encode()
    members["store/STORE"] = b"synthetic shape fixture, never a valid store\n"
    pin["source_report_hashes"] = {name: source.sha256(members[name]) for name in reports}
    index = {
        "code_commit": pin["run"]["head_sha"], "code_tree": pin["run"]["tree_sha"],
        "job_status": "success", "schema": pin["index"]["schema"],
        "workflow_run_id": str(pin["run"]["id"]), "workflow_run_attempt": "1",
        "files": [{"path": name, "size": len(data), "sha256": source.sha256(data)}
                  for name, data in sorted(members.items())],
    }
    members["evidence-index.json"] = encoded(index)
    pin["index"].update({"sha256": source.sha256(members["evidence-index.json"]),
                         "indexed_members": len(index["files"]), "zip_members": len(members),
                         "uncompressed_bytes": sum(map(len, members.values()))})
    return pin, members, index


class SourceAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.pin = source.load_pin()
        self.run, self.artifact, self.commit = api_fixtures(self.pin)

    def authenticate(self, now=NOW):
        source.authenticate_metadata(self.pin, self.run, self.artifact, self.commit, now)

    def test_positive_raw_api_fields_and_observed_connector_envelopes(self):
        self.authenticate()
        wrap = lambda value: {"isError": False,
                              "structuredContent": {"content": encoded(value).decode()}}
        source.authenticate_metadata(self.pin, wrap(self.run),
                                     {"isError": False, "structuredContent": {"artifacts": [self.artifact]}},
                                     wrap(self.commit), NOW)

    def test_wrong_or_missing_run_fields_fail_closed(self):
        for key in ("id", "run_attempt", "name", "path", "workflow_id", "head_sha", "head_branch",
                    "event", "status", "conclusion", "url", "html_url", "workflow_url"):
            for wrong in (None, "wrong", False):
                with self.subTest(key=key, wrong=wrong):
                    run = copy.deepcopy(self.run)
                    run[key] = wrong
                    with self.assertRaises(source.SourceError):
                        source.authenticate_metadata(self.pin, run, self.artifact, self.commit, NOW)

    def test_false_missing_and_failed_source_success(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure"),
                                   ("completed", False), ("completed", None)):
            self.run.update(status=status, conclusion=conclusion)
            with self.assertRaises(source.SourceError):
                self.authenticate()

    def test_cross_repository_and_wrong_head_or_tree(self):
        for key, field in (("repository", "id"), ("repository", "full_name"),
                           ("head_repository", "id"), ("head_repository", "full_name"),
                           ("head_commit", "id"), ("head_commit", "tree_id")):
            with self.subTest(key=key, field=field):
                run = copy.deepcopy(self.run)
                run[key][field] = "wrong"
                with self.assertRaises(source.SourceError):
                    source.authenticate_metadata(self.pin, run, self.artifact, self.commit, NOW)

    def test_wrong_artifact_identity_name_digest_expiry_or_size(self):
        for key in (*self.pin["artifact"], "expired", "url", "archive_download_url"):
            with self.subTest(key=key):
                artifact = copy.deepcopy(self.artifact)
                artifact[key] = "wrong"
                with self.assertRaises(source.SourceError):
                    source.authenticate_metadata(self.pin, self.run, artifact, self.commit, NOW)

    def test_wrong_artifact_run_repository_or_head(self):
        for key in self.artifact["workflow_run"]:
            with self.subTest(key=key):
                artifact = copy.deepcopy(self.artifact)
                artifact["workflow_run"][key] = "wrong"
                with self.assertRaises(source.SourceError):
                    source.authenticate_metadata(self.pin, self.run, artifact, self.commit, NOW)

    def test_expired_future_and_exact_expiry_boundary(self):
        for now in (dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc),
                    source.utc_time(self.pin["artifact"]["expires_at"], "expiry"),
                    dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc)):
            with self.subTest(now=now), self.assertRaises(source.SourceError):
                self.authenticate(now)

    def test_changed_commit_or_tree_metadata(self):
        for key, field in (("sha", None), ("url", None), ("tree", "sha"), ("tree", "url")):
            commit = copy.deepcopy(self.commit)
            if field:
                commit[key][field] = "wrong"
            else:
                commit[key] = "wrong"
            with self.subTest(key=key, field=field), self.assertRaises(source.SourceError):
                source.authenticate_metadata(self.pin, self.run, self.artifact, commit, NOW)

    def test_connector_error_and_ambiguous_artifact_list(self):
        with self.assertRaises(source.SourceError):
            source.metadata_payload({"isError": True, "structuredContent": self.run})
        with self.assertRaises(source.SourceError):
            source.authenticate_metadata(self.pin, self.run, {"artifacts": [self.artifact] * 2},
                                         self.commit, NOW)

    def test_json_duplicate_keys_non_finite_and_non_objects(self):
        for data in (b'{"id":1,"id":2}', b'{"v":NaN}', b'{"v":Infinity}', b'[]', b'null'):
            with self.subTest(data=data), self.assertRaises(source.SourceError):
                source.strict_json(data, "test")

    def test_recursive_numeric_and_boolean_identity_types(self):
        for value in (True, 1.0):
            with self.assertRaises(source.SourceError):
                source.equal({"nested": [value]}, {"nested": [1]}, "test")

    def test_unknown_pin_schema_and_fields(self):
        for changes in ({"schema": "future"}, {"unrecognized": True}):
            pin = copy.deepcopy(self.pin)
            pin.update(changes)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "pin.json"
                path.write_bytes(encoded(pin))
                with self.assertRaises(source.SourceError):
                    source.load_pin(path)

    def test_synthetic_authenticated_bytes_roundtrip_and_read_only_extraction(self):
        pin, members, _ = synthetic_package()
        pin, data = make_archive(pin, members)
        actual, _ = source.authenticate_archive(pin, data)
        self.assertEqual(actual, members)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            source.extract_members(pin, members, root)
            source.verify_extracted(pin, members, root)
            self.assertEqual((root / "store/STORE").read_bytes(), members["store/STORE"])
            self.assertFalse((root / "store/STORE").stat().st_mode & stat.S_IWUSR)
            self.assertEqual(list((root / "store/tmp").iterdir()), [])
            with self.assertRaises(FileExistsError):
                source.extract_members(pin, members, root)

    def test_wrong_zip_digest_and_size(self):
        pin, members, _ = synthetic_package()
        pin, data = make_archive(pin, members)
        for changed in (data + b"x", bytes([data[0] ^ 1]) + data[1:]):
            with self.assertRaises(source.SourceError):
                source.authenticate_archive(pin, changed)

    def test_unsafe_duplicate_symlink_and_collision_members(self):
        pin, members, _ = synthetic_package()
        rows = [(name, data, stat.S_IFREG | 0o644) for name, data in members.items()]
        mutations = ["../escape", "/absolute", "a//b", "a/./b", "a\\b", "C:escape",
                     "a\x00ignored", "NUL", "trailing.", rows[1][0], "store"]
        for name in mutations:
            changed = [(name, rows[0][1], rows[0][2]), *rows[1:]]
            mutated_pin, data = make_archive(pin, members, changed)
            with self.subTest(name=name), self.assertRaises(source.SourceError):
                source.authenticate_archive(mutated_pin, data)
        changed = [(rows[0][0], rows[0][1], stat.S_IFLNK | 0o777), *rows[1:]]
        mutated_pin, data = make_archive(pin, members, changed)
        with self.assertRaises(source.SourceError):
            source.authenticate_archive(mutated_pin, data)

    def test_missing_extra_tampered_and_unindexed_members(self):
        pin, members, _ = synthetic_package()
        for kind in ("missing", "extra", "renamed", "tampered"):
            changed = dict(members)
            if kind == "missing":
                del changed["store/STORE"]
            elif kind == "extra":
                changed["extra"] = b"x"
            elif kind == "renamed":
                changed["store/OTHER"] = changed.pop("store/STORE")
            else:
                changed["store/STORE"] = b"x" * len(changed["store/STORE"])
            mutated_pin, data = make_archive(pin, changed)
            with self.subTest(kind=kind), self.assertRaises(source.SourceError):
                source.authenticate_archive(mutated_pin, data)

    def test_index_closed_schema_identity_and_duplicate_members(self):
        pin, members, index = synthetic_package()
        changes = [{"schema": "future"}, {"extra": False}, {"job_status": False},
                   {"code_commit": "0" * 40}, {"code_tree": "0" * 40},
                   {"workflow_run_attempt": "2"}, {"workflow_run_id": "1"}]
        for change in changes:
            mutated = {**index, **change}
            with self.subTest(change=change), self.assertRaises(source.SourceError):
                source.authenticate_index(pin, encoded(mutated), members)
        for kind in ("duplicate", "unknown_field", "boolean_size", "bad_hash", "unsafe"):
            mutated = copy.deepcopy(index)
            row = mutated["files"][0]
            if kind == "duplicate":
                mutated["files"][1] = copy.deepcopy(row)
            elif kind == "unknown_field":
                row["admitted"] = True
            elif kind == "boolean_size":
                row["size"] = True
            elif kind == "bad_hash":
                row["sha256"] = "f" * 63
            else:
                row["path"] = "../escape"
            with self.subTest(kind=kind), self.assertRaises(source.SourceError):
                source.authenticate_index(pin, encoded(mutated), members)

    def test_changed_report_schema_scope_anchor_provider_namespace_and_fabricated_pass(self):
        pin, members, _ = synthetic_package()
        cases = [
            ("aave-current-surface.json", lambda r: r.update(schema="future")),
            ("aave-current-surface.json", lambda r: r.update(fabricated_pass=True)),
            ("aave-current-surface.json", lambda r: r.update(status="PASS")),
            ("aave-current-surface.json", lambda r: r["bootstrap"]["anchor"]["anchor"].update(number=25437474)),
            ("aave-current-surface.json", lambda r: r["bootstrap"]["providers"].append(r["bootstrap"]["providers"][0])),
            ("aave-current-surface.json", lambda r: r["bootstrap"]["providers"][0]["provider"].update(namespace=999)),
            ("closeout/aave-discovery-run.json", lambda r: r.update(scope="GLOBAL")),
            ("closeout/aave-discovery-run.json", lambda r: r.update(history_range=[16291072, 26095351])),
            ("aave-resume-equivalence.json", lambda r: r["interruptions"].pop()),
            ("aave-history.json", lambda r: r["summary"].update(provider_mismatch_count=1)),
        ]
        for name, mutate in cases:
            changed = dict(members)
            report = source.strict_json(changed[name], name)
            mutate(report)
            changed[name] = encoded(report)
            # Exercise the semantic identity checks as well as the outer exact
            # bytes check. Only this in-memory unit pin is re-digested; callers
            # cannot provide replacement pins to the production CLI.
            deeper_pin = copy.deepcopy(pin)
            deeper_pin["source_report_hashes"][name] = source.sha256(changed[name])
            with self.subTest(name=name), self.assertRaises(source.SourceError):
                source.authenticate_reports(pin, changed)
            with self.subTest(name=name, inner_gate=True), self.assertRaises(source.SourceError):
                source.authenticate_reports(deeper_pin, changed)

    def test_changed_original_store_root(self):
        pin, members, _ = synthetic_package()
        members["final-store-verify.log"] = b"RMC_004_OFFLINE_VERIFY=PASS\nevidence_root=wrong\n"
        with self.assertRaises(source.SourceError):
            source.authenticate_reports(pin, members)

    def test_post_replay_source_mutation_extra_missing_symlink_and_hardlink(self):
        pin, members, _ = synthetic_package()
        for kind in ("mutation", "extra", "missing", "symlink", "hardlink", "extra_dir"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "source"
                source.extract_members(pin, members, root)
                target = root / "store/STORE"
                if kind == "mutation":
                    target.chmod(0o600)
                    target.write_bytes(b"tampered")
                elif kind == "extra":
                    (root / "extra").write_bytes(b"x")
                elif kind == "extra_dir":
                    (root / "extra").mkdir()
                else:
                    target.unlink()
                    if kind == "symlink":
                        target.symlink_to(root / "evidence-index.json")
                    elif kind == "hardlink":
                        os.link(root / "evidence-index.json", target)
                with self.assertRaises(source.SourceError):
                    source.verify_extracted(pin, members, root)

    def test_symlink_destination_ancestor_and_nonregular_input(self):
        pin, members, _ = synthetic_package()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "link").symlink_to(root, target_is_directory=True)
            with self.assertRaises(source.SourceError):
                source.extract_members(pin, members, root / "link/source")
            fifo = root / "fifo"
            os.mkfifo(fifo)
            with self.assertRaises(source.SourceError):
                source.read_regular(fifo, 10)

    def test_cli_cannot_override_clock_or_source_pin_or_accept_blank_inputs(self):
        for args in ([], ["--now", "2026-10-08T00:00:00Z"], ["--pin", "other.json"]):
            result = subprocess.run([sys.executable, str(Path(source.__file__)), *args],
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 2)


@unittest.skipUnless(os.environ.get("RMC006_SOURCE_ARCHIVE"),
                     "real source ZIP not provided; pure offline negatives still run")
class OriginalPackageIntegrationTests(unittest.TestCase):
    def test_real_original_archive_all_members_and_safe_extract_roundtrip(self):
        pin = source.load_pin()
        original = source.read_regular(os.environ["RMC006_SOURCE_ARCHIVE"], source.MAX_ARCHIVE_BYTES)
        members, index = source.authenticate_archive(pin, original)
        self.assertEqual(len(index["files"]), 4234)
        self.assertEqual(len(members), 4235)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "original"
            source.extract_members(pin, members, root)
            source.verify_extracted(pin, members, root)
            self.assertEqual(source.sha256(source.read_regular(os.environ["RMC006_SOURCE_ARCHIVE"],
                                                               source.MAX_ARCHIVE_BYTES)),
                             source.sha256(original))

    def test_real_connector_metadata_and_actual_expiry_clock(self):
        paths = [os.environ.get("RMC006_SOURCE_" + name + "_METADATA")
                 for name in ("RUN", "ARTIFACT", "COMMIT")]
        if not all(paths):
            self.skipTest("real run/artifact/commit snapshots not all provided")
        metadata = [source.strict_json(source.read_regular(path, source.MAX_METADATA_BYTES), path)
                    for path in paths]
        source.authenticate_metadata(source.load_pin(), *metadata, dt.datetime.now(dt.timezone.utc))

    def test_real_cli_provenance_preserves_original_identity_without_new_pass(self):
        paths = [os.environ.get("RMC006_SOURCE_" + name + "_METADATA")
                 for name in ("RUN", "ARTIFACT", "COMMIT")]
        if not all(paths):
            self.skipTest("real run/artifact/commit snapshots not all provided")
        with tempfile.TemporaryDirectory() as tmp:
            provenance = Path(tmp) / "provenance.json"
            command = [sys.executable, str(Path(source.__file__)),
                       "--archive", os.environ["RMC006_SOURCE_ARCHIVE"],
                       "--run-metadata", paths[0], "--artifact-metadata", paths[1],
                       "--commit-metadata", paths[2], "--provenance", str(provenance)]
            result = subprocess.run(command, capture_output=True, check=False, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(provenance.read_text())
            self.assertFalse(report["canonical_recertification"])
            self.assertFalse(report["semantic_replay_performed"])
            self.assertFalse(report["independent_store_verification_performed"])
            self.assertEqual(report["original_run"]["id"], 36820687233)
            self.assertEqual(report["original_artifact"]["id"], 11143129177)
            self.assertEqual(len(report["original_indexed_members"]), 4234)
            self.assertNotIn("status", report)
            repeated = subprocess.run(command, capture_output=True, check=False, text=True)
            self.assertNotEqual(repeated.returncode, 0)
            self.assertEqual(json.loads(provenance.read_text()), report)


if __name__ == "__main__":
    unittest.main()

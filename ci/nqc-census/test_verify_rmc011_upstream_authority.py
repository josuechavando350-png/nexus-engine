import argparse
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("verify_rmc011_upstream_authority.py")
SPEC = importlib.util.spec_from_file_location("rmc011_verify", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MOD)


def enc(obj):
    return (
        json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class SemanticAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.anchor = {
            "chain_id": 1,
            "genesis_hash": "11" * 32,
            "fork_lineage": "22" * 32,
            "block_number": 123,
            "block_hash": "33" * 32,
            "parent_hash": "44" * 32,
            "timestamp": 1700000000,
            "state_root": "55" * 32,
        }
        self.stage_meta = {
            "RMC-006": ("06" * 20, "16" * 20),
            "RMC-007": ("07" * 20, "17" * 20),
            "RMC-008": ("08" * 20, "18" * 20),
            "RMC-009": ("09" * 20, "19" * 20),
            "RMC-010": ("0a" * 20, "1a" * 20),
        }
        self.authorities = {}
        self.build_d06()
        self.build_d07()
        self.build_d08()
        self.build_d09()
        self.build_d10()

        rows = []
        for stage in self.stage_meta:
            commit, tree = self.stage_meta[stage]
            path = self.authorities[stage][0]
            rows.append(
                {
                    "stage": stage,
                    "code_commit": commit,
                    "code_tree": tree,
                    "artifact_sha256": "0x" + MOD.sha256_file(path),
                    "observation_anchor": self.anchor,
                    "unresolved_mismatch_count": 0,
                    "unknown_failure_count": 0,
                    "coverage_complete": True,
                    "admitted": True,
                }
            )
        self.lock = self.root / "lock.json"
        self.lock.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "authority_lock_commitment": "fixture",
                    "stages": rows,
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def run_doc(self, stage):
        commit, tree = self.stage_meta[stage]
        auth_path, artifact_root = self.authorities[stage]
        args = argparse.Namespace(
            stage=stage,
            artifact_root=str(artifact_root),
            authority_file=str(auth_path.relative_to(artifact_root)),
            lock=str(self.lock),
            expected_code_commit=commit,
            expected_code_tree=tree,
        )
        MOD.verify(args)

    def manifest(
        self,
        base,
        commit,
        tree,
        docs,
        *,
        key="path",
        extra=None,
    ):
        base.mkdir(parents=True, exist_ok=True)
        entries = []
        for name, obj in docs.items():
            data = obj if isinstance(obj, bytes) else enc(obj)
            (base / name).write_bytes(data)
            entries.append(
                {
                    key: name,
                    "sha256": sha(data),
                    "bytes": len(data),
                }
            )
        manifest = {
            "schema_version": 1,
            "code_commit": commit,
            "code_tree": tree,
            "artifacts": entries,
        }
        if extra:
            manifest.update(extra)
        path = base / "evidence-manifest.json"
        path.write_bytes(enc(manifest))
        return path

    def run_anchor(self):
        return {
            "chain_domain": {
                key: self.anchor[key]
                for key in (
                    "chain_id",
                    "genesis_hash",
                    "fork_lineage",
                )
            },
            "observation_anchor": {
                "number": self.anchor["block_number"],
                "hash": self.anchor["block_hash"],
                "parent_hash": self.anchor["parent_hash"],
                "timestamp": self.anchor["timestamp"],
                "state_root": self.anchor["state_root"],
            },
        }

    def build_d06(self):
        stage = "RMC-006"
        commit, tree = self.stage_meta[stage]
        root = self.root / "d06"
        base = root / "closeout"
        run = {
            "status": "RMC_006_PASS_CANDIDATE",
            "code_commit": commit,
            "code_tree": tree,
            **self.run_anchor(),
        }
        summary = {
            "status": "RMC_006_PASS_CANDIDATE",
            "code_commit": commit,
            "code_tree": tree,
            "unexplained_delta_count": 0,
            "provider_mismatch_count": 0,
            "admission_rejection_count": 0,
            "blocking_findings": 0,
            "unexplained_findings": 0,
            "deduplication": "PASS",
            "canonicalization": "PASS",
        }
        path = self.manifest(
            base,
            commit,
            tree,
            {
                "aave-discovery-run.json": run,
                "aave-discovery-summary.json": summary,
                "aave-discovery-deltas.jsonl": enc(
                    {
                        "status": "EMPTY",
                        "unexplained_delta_count": 0,
                    }
                ),
                "aave-discovery-mismatch-ledger.jsonl": enc(
                    {
                        "status": "EMPTY",
                        "provider_mismatch_count": 0,
                        "unexplained_findings": 0,
                    }
                ),
            },
            key="name",
            extra={"status": "CONTENT_ADDRESSED"},
        )
        self.authorities[stage] = (path, root)

    def build_d07(self):
        stage = "RMC-007"
        commit, tree = self.stage_meta[stage]
        root = self.root / "d07"
        base = root / "closeout"
        run = {
            "status": "RMC_007_PASS_CANDIDATE",
            "code_commit": commit,
            "code_tree": tree,
            **self.run_anchor(),
        }
        summary = {
            "status": "RMC_007_PASS_CANDIDATE",
            "code_commit": commit,
            "code_tree": tree,
            "unexplained_delta_count": 0,
            "provider_mismatch_count": 0,
        }
        path = self.manifest(
            base,
            commit,
            tree,
            {
                "v2-discovery-run.json": run,
                "v2-discovery-summary.json": summary,
                "v2-deltas.jsonl": enc(
                    {
                        "status": "EMPTY",
                        "unexplained_delta_count": 0,
                    }
                ),
                "v2-mismatch-ledger.jsonl": enc(
                    {
                        "status": "EMPTY",
                        "provider_mismatch_count": 0,
                    }
                ),
            },
            key="name",
            extra={"status": "CONTENT_ADDRESSED"},
        )
        self.authorities[stage] = (path, root)

    def build_d08(self):
        stage = "RMC-008"
        commit, tree = self.stage_meta[stage]
        root = self.root / "d08"
        base = root / "closeout"
        summary = {
            "status": "RMC_008_PASS_CANDIDATE",
            "code_commit": commit,
            "code_tree": tree,
            "observation_anchor": self.anchor,
            "unexplained_mismatches": 0,
            "unknown_rejections": 0,
            "metrics_conserved": True,
            "every_market_decided": True,
        }
        path = self.manifest(
            base,
            commit,
            tree,
            {"state-summary.json": summary},
            extra={"observation_anchor": self.anchor},
        )
        self.authorities[stage] = (path, root)

    def build_d09(self):
        stage = "RMC-009"
        commit, tree = self.stage_meta[stage]
        root = self.root / "d09"
        base = root / "closeout"
        summary = {
            "status": "RMC_009_PASS_CANDIDATE",
            "all_tokens_conserved": True,
            "unexplained_mismatches": 0,
            "blocking_findings": [],
            "anchor": {
                "number": self.anchor["block_number"],
                "hash": self.anchor["block_hash"],
            },
            "anchor_timestamp": self.anchor["timestamp"],
        }
        path = self.manifest(
            base,
            commit,
            tree,
            {"account-summary.json": summary},
        )
        self.authorities[stage] = (path, root)

    def build_d10(self):
        stage = "RMC-010"
        commit, tree = self.stage_meta[stage]
        root = self.root / "d10"
        base = root / "closeout"
        base.mkdir(parents=True)

        summary = {
            "status": "RMC_009_PASS_CANDIDATE",
            "all_tokens_conserved": True,
            "unexplained_mismatches": 0,
            "blocking_findings": [],
            "anchor": {
                "number": self.anchor["block_number"],
                "hash": self.anchor["block_hash"],
            },
            "anchor_timestamp": self.anchor["timestamp"],
        }
        manifest = self.manifest(
            base,
            commit,
            tree,
            {"account-summary.json": summary},
        )

        parity = root / "parity-closeout.json"
        parity.write_bytes(
            enc(
                {
                    "status": "FULL_INCREMENTAL_PARITY_PASS",
                    "artifacts": [],
                }
            )
        )

        d09_sha = MOD.sha256_file(
            self.authorities["RMC-009"][0]
        )
        cert = {
            "schema": "nqc-rmc-010-live-parity-certification-v1",
            "status": "RMC_010_LIVE_PARITY_CERTIFIED",
            "code_commit": commit,
            "code_tree": tree,
            "target_anchor": {
                "block_number": self.anchor["block_number"],
                "block_hash": self.anchor["block_hash"],
            },
            "parity_sha256": MOD.sha256_file(parity),
            "incremental_evidence_manifest_sha256": MOD.sha256_file(
                manifest
            ),
            "full_evidence_manifest_sha256": d09_sha,
        }
        path = root / "rmc010-certification.json"
        path.write_bytes(enc(cert))
        self.authorities[stage] = (path, root)

    def test_all_stage_semantics_pass(self):
        for stage in self.stage_meta:
            with self.subTest(stage=stage):
                self.run_doc(stage)

    def test_hash_bound_semantic_tamper_fails(self):
        summary = (
            self.root
            / "d08"
            / "closeout"
            / "state-summary.json"
        )
        doc = json.loads(summary.read_text())
        doc["unknown_rejections"] = 1
        summary.write_bytes(enc(doc))
        with self.assertRaises(MOD.VerificationError):
            self.run_doc("RMC-008")

    def test_lock_cannot_self_assert_coverage(self):
        lock = json.loads(self.lock.read_text())
        row = next(
            row
            for row in lock["stages"]
            if row["stage"] == "RMC-007"
        )
        row["coverage_complete"] = False
        self.lock.write_text(json.dumps(lock))
        with self.assertRaises(MOD.VerificationError):
            self.run_doc("RMC-007")

    def test_d10_must_bind_locked_d09_authority(self):
        cert = self.root / "d10" / "rmc010-certification.json"
        doc = json.loads(cert.read_text())
        doc["full_evidence_manifest_sha256"] = "ff" * 32
        cert.write_bytes(enc(doc))

        lock = json.loads(self.lock.read_text())
        row = next(
            row
            for row in lock["stages"]
            if row["stage"] == "RMC-010"
        )
        row["artifact_sha256"] = "0x" + MOD.sha256_file(cert)
        self.lock.write_text(json.dumps(lock))

        with self.assertRaises(MOD.VerificationError):
            self.run_doc("RMC-010")


if __name__ == "__main__":
    unittest.main()

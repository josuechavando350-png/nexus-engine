#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("verify-rmc011-upstream-coherence.py")
SPEC = importlib.util.spec_from_file_location("rmc011_coherence", SCRIPT)
assert SPEC and SPEC.loader
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def h(byte: str) -> str:
    return "0x" + byte * 64


def git(byte: str) -> str:
    return byte * 40


ANCHOR = {
    "chain_id": 1,
    "genesis_hash": h("1"),
    "fork_lineage": h("2"),
    "block_number": 300,
    "block_hash": h("3"),
    "parent_hash": h("4"),
    "timestamp": 1_800_000_000,
    "state_root": h("5"),
}


class Fixture:
    def __init__(self, root: pathlib.Path):
        self.root = root
        for key in ("d06", "d07", "d08", "d09", "d10"):
            (root / f"{key}-raw").mkdir(parents=True)

        self.inputs = {
            "schema_version": 3,
            "repository": "owner/repo",
            "d06": self.desc("6", 6, "d06.zip", "closeout/evidence-manifest.json"),
            "d07": self.desc("7", 7, "d07.zip", "closeout/evidence-manifest.json"),
            "d08": self.desc("8", 8, "d08.zip", "closeout/evidence-manifest.json"),
            "d09": self.desc("9", 9, "d09.zip", "closeout/evidence-manifest.json"),
            "d10": self.desc("a", 10, "d10.zip", "rmc010-certification.json"),
        }
        self.inputs["d06"]["anchor_file"] = "closeout/aave-discovery-run.json"
        self.inputs["d07"]["anchor_file"] = "closeout/v2-discovery-run.json"
        self.inputs["d08"].update({
            "market_state_manifest": "closeout/market-state-manifest.jsonl",
            "token_admission": "closeout/token-admission.jsonl",
            "pool_and_factory_facts": "closeout/pool-and-factory-facts.json",
        })
        self.inputs["d09"].update({
            "account_manifest": "closeout/account-manifest.jsonl",
            "account_summary": "closeout/account-summary.json",
        })

        self.lock = {
            "schema_version": 1,
            "authority_lock_commitment": "0x" + "f" * 64,
            "stages": [
                {
                    "stage": f"RMC-{n:03d}",
                    "code_commit": self.inputs[f"d{n:02d}"]["head_sha"],
                    "code_tree": git(str(n % 10)),
                    "artifact_sha256": h(str(n % 10)),
                    "observation_anchor": dict(ANCHOR),
                    "unresolved_mismatch_count": 0,
                    "unknown_failure_count": 0,
                    "coverage_complete": True,
                    "admitted": True,
                }
                for n in range(6, 11)
            ],
        }

        generated = MOD.rfc3339_utc(ANCHOR["timestamp"])
        chain = {
            "chain_id": ANCHOR["chain_id"],
            "genesis_hash": ANCHOR["genesis_hash"],
            "fork_lineage": ANCHOR["fork_lineage"],
        }
        obs = {
            "number": ANCHOR["block_number"],
            "hash": ANCHOR["block_hash"],
            "parent_hash": ANCHOR["parent_hash"],
            "timestamp": ANCHOR["timestamp"],
            "state_root": ANCHOR["state_root"],
        }
        self.write("d06-raw/closeout/aave-discovery-run.json", {
            "status": "RMC_006_PASS_CANDIDATE",
            "chain_domain": chain,
            "observation_anchor": obs,
            "generated_at": generated,
        })
        self.write("d07-raw/closeout/v2-discovery-run.json", {
            "status": "RMC_007_PASS_CANDIDATE",
            "chain_domain": chain,
            "observation_anchor": obs,
            "generated_at": generated,
        })
        self.write("d08-raw/closeout/evidence-manifest.json", {
            "observation_anchor": dict(ANCHOR),
            "generated_at": generated,
        })
        self.write("d09-raw/closeout/account-summary.json", {
            "status": "RMC_009_PASS_CANDIDATE",
            "anchor": {"number": ANCHOR["block_number"], "hash": ANCHOR["block_hash"]},
            "anchor_timestamp": ANCHOR["timestamp"],
            "generated_at": generated,
        })
        self.write("d10-raw/rmc010-certification.json", {
            "status": "RMC_010_LIVE_PARITY_CERTIFIED",
            "base_anchor": {"block_number": 299, "block_hash": h("b")},
            "target_anchor": {
                "block_number": ANCHOR["block_number"],
                "block_hash": ANCHOR["block_hash"],
            },
            "sources": [
                self.d10_source("target_d06", self.inputs["d06"]),
                self.d10_source("full_d09", self.inputs["d09"]),
                {
                    "role": "base_d09",
                    "workflow_run_id": 1,
                    "artifact_id": 1,
                    "artifact": "base",
                    "code_commit": git("b"),
                    "artifact_digest": "sha256:" + "b" * 64,
                },
            ],
            "full_evidence_manifest_sha256": self.lock["stages"][3]["artifact_sha256"],
        })
        self.inputs_path = root / "inputs.json"
        self.lock_path = root / "lock.json"
        self.persist()

    @staticmethod
    def desc(byte: str, n: int, name: str, authority: str):
        return {
            "run_id": 1000 + n,
            "head_sha": git(byte),
            "workflow_name": f"RMC-{n:03d}",
            "artifact_id": 2000 + n,
            "artifact_name": name,
            "artifact_digest": "sha256:" + byte * 64,
            "authority_file": authority,
        }

    @staticmethod
    def d10_source(role, desc):
        return {
            "role": role,
            "workflow_run_id": desc["run_id"],
            "artifact_id": desc["artifact_id"],
            "artifact": desc["artifact_name"],
            "code_commit": desc["head_sha"],
            "artifact_digest": desc["artifact_digest"],
        }

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, sort_keys=True))

    def read(self, relative):
        return json.loads((self.root / relative).read_text())

    def persist(self):
        self.inputs_path.write_text(json.dumps(self.inputs, sort_keys=True))
        self.lock_path.write_text(json.dumps(self.lock, sort_keys=True))

    def verify(self):
        MOD.verify(self.inputs_path, self.lock_path, self.root)


class CoherenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fx = Fixture(pathlib.Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_coherent_a1_snapshot_passes(self):
        self.fx.verify()

    def test_d08_mixed_anchor_fails(self):
        doc = self.fx.read("d08-raw/closeout/evidence-manifest.json")
        doc["observation_anchor"]["block_hash"] = h("e")
        self.fx.write("d08-raw/closeout/evidence-manifest.json", doc)
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()

    def test_d09_timestamp_divergence_fails(self):
        doc = self.fx.read("d09-raw/closeout/account-summary.json")
        doc["anchor_timestamp"] += 1
        self.fx.write("d09-raw/closeout/account-summary.json", doc)
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()

    def test_d10_full_d09_source_substitution_fails(self):
        doc = self.fx.read("d10-raw/rmc010-certification.json")
        row = next(x for x in doc["sources"] if x["role"] == "full_d09")
        row["artifact_id"] += 1
        self.fx.write("d10-raw/rmc010-certification.json", doc)
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()

    def test_d10_full_manifest_substitution_fails(self):
        doc = self.fx.read("d10-raw/rmc010-certification.json")
        doc["full_evidence_manifest_sha256"] = h("e")
        self.fx.write("d10-raw/rmc010-certification.json", doc)
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()

    def test_d10_target_must_be_later_than_base(self):
        doc = self.fx.read("d10-raw/rmc010-certification.json")
        doc["base_anchor"]["block_number"] = ANCHOR["block_number"]
        self.fx.write("d10-raw/rmc010-certification.json", doc)
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()

    def test_lock_itself_cannot_mix_anchors(self):
        self.fx.lock["stages"][2]["observation_anchor"]["state_root"] = h("e")
        self.fx.persist()
        with self.assertRaises(MOD.CoherenceError):
            self.fx.verify()


if __name__ == "__main__":
    unittest.main()

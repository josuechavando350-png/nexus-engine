#!/usr/bin/env python3
"""Adversarial tests for RMC-013's only legal no-RPC/no-fork path."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from materialize_rmc013_no_eligible import create

COMMIT = "a" * 40
TREE = "b" * 40
ARTIFACT = "sha256:" + "c" * 64


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jsonl(rows: list[dict]) -> bytes:
    return b"".join((json.dumps(v, sort_keys=True, separators=(",", ":")) + "\n").encode()
                    for v in rows)


class ZeroCoverageRegression(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.root = Path(self.t.name)
        ids = ["1" * 64, "2" * 64, "3" * 64]
        records = [
            {"pair_id": ids[0], "candidate_id": "a" * 64, "status": "ADMITTED"},
            {"pair_id": ids[1], "candidate_id": "b" * 64, "status": "ADMITTED"},
            {"pair_id": ids[2], "reason": "COLLATERAL_NOT_ENABLED", "status": "REJECTED"},
        ]
        promotions = [
            {"actionable_candidate_id": candidate, "capital_status": "REJECTED",
             "rejection_reason": "EXECUTION_BLOCKED", "allocations": [],
             "gas_funding_certified": False}
            for candidate in ("a" * 64, "b" * 64)
        ]
        self._write("sources.jsonl", b"verified-source\n")
        self._write("records.jsonl", jsonl(records))
        self._write("promotions.jsonl", jsonl(promotions))
        summary = {
            "status": "RMC_012_ACTIONABILITY_PASS",
            "anchor": {"chain_id": 1, "block_number": 26095351},
            "code_commit": COMMIT,
            "code_tree": TREE,
            "principal_capital_conserved": True,
            "expected_pairs": 3, "admitted": 2, "rejected": 1,
            "principal_capital_feasible": 0, "principal_capital_rejected": 2,
            "principal_capital_promoted": 2,
            "portfolio_simultaneously_feasible": False,
            "records_sha256": sha((self.root / "records.jsonl").read_bytes()),
            "capital_promotions_sha256": sha((self.root / "promotions.jsonl").read_bytes()),
            "d11_capital_sources_sha256": sha((self.root / "sources.jsonl").read_bytes()),
        }
        cert = {k: summary[k] for k in
                ("code_commit", "code_tree", "expected_pairs", "admitted", "rejected",
                 "principal_capital_feasible", "principal_capital_rejected",
                 "principal_capital_promoted", "d11_capital_sources_sha256")}
        cert.update({"status": "RMC_012_TERMINAL_ACTIONABILITY_CERTIFIED",
                     "schema_version": 2,
                     "principal_capital_promotion_certified": True,
                     "gas_funding_certified": False,
                     "portfolio_concurrent_capacity_certified": False,
                     "portfolio_simultaneously_feasible": False,
                     "portfolio_candidate_claim_count": 2,
                     "realized_pnl_certified": False,
                     "economics_certified": False})
        self.summary = summary
        self.cert = cert
        self._write("summary.json", json.dumps(summary).encode())
        self._write("cert.json", json.dumps(cert).encode())

    def _write(self, name, data):
        (self.root / name).write_bytes(data)

    def produce(self):
        return create(self.root / "cert.json", self.root / "summary.json",
                      self.root / "records.jsonl", self.root / "promotions.jsonl",
                      self.root / "sources.jsonl", ARTIFACT, COMMIT, TREE, self.root / "out")

    def test_empty_scope_is_exact_non_claim(self):
        result = self.produce()
        self.assertEqual(result["input_candidate_count"], 0)
        self.assertEqual(result["economics_quote_count"], 0)
        self.assertFalse(result["gas_price_evidence_collected"])
        self.assertFalse(result["physical_execution_claimed"])
        self.assertEqual(result["status"], "RMC_013_NO_EXECUTION_ELIGIBLE_CANDIDATES_PROVEN")
        out = self.root / "out"
        self.assertEqual((out / "execution-economics.jsonl").read_bytes(), b"")
        self.assertEqual((out / "gas-funding-bindings.jsonl").read_bytes(), b"")
        physical = json.loads((out / "physical-execution-summary.json").read_bytes())
        self.assertFalse(physical["provider_consensus"])
        proof = json.loads((out / "zero-capital-feasible-proof.json").read_bytes())
        self.assertEqual(proof["d12_principal_capital_rejected"], 2)

    def test_positive_feasible_candidate_refused(self):
        self.summary["principal_capital_feasible"] = 1
        self._write("summary.json", json.dumps(self.summary).encode())
        with self.assertRaises(ValueError):
            self.produce()

    def test_duplicate_promotion_rejected(self):
        raw = (self.root / "promotions.jsonl").read_bytes()
        self._write("promotions.jsonl", raw + raw.splitlines(keepends=True)[0])
        self.summary["capital_promotions_sha256"] = sha((self.root / "promotions.jsonl").read_bytes())
        self._write("summary.json", json.dumps(self.summary).encode())
        with self.assertRaises(ValueError):
            self.produce()

    def test_source_hash_tampering_refused(self):
        self._write("sources.jsonl", b"changed\n")
        with self.assertRaises(ValueError):
            self.produce()

    def test_unknown_rejection_refused(self):
        rows = [
            {"pair_id": "1" * 64, "candidate_id": "a" * 64, "status": "ADMITTED"},
            {"pair_id": "2" * 64, "candidate_id": "b" * 64, "status": "ADMITTED"},
            {"pair_id": "3" * 64, "reason": "UNKNOWN", "status": "REJECTED"},
        ]
        self._write("records.jsonl", jsonl(rows))
        self.summary["records_sha256"] = sha((self.root / "records.jsonl").read_bytes())
        self._write("summary.json", json.dumps(self.summary).encode())
        with self.assertRaises(ValueError):
            self.produce()


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "seo_avengers_2500_proof.py"
SPEC = importlib.util.spec_from_file_location("seo_avengers_2500_proof", MODULE_PATH)
assert SPEC and SPEC.loader
proofmod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proofmod)

SOURCE_REVISION = "a" * 40
SOURCE_TREE = "b" * 40
SHA = "sha256:" + "c" * 64


class ProofFixture:
    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.outcomes = []
        self.gates = self._make_gates()
        self._make_ranges()

    def cleanup(self) -> None:
        self.temp.cleanup()

    def _make_gates(self):
        gates = []
        for index, name in enumerate(
            ("CHAINED_VERIFIER_M201_M2500", "ORIGINAL_VERIFIER_M001_M200"), start=1
        ):
            stdout = self.root / "gates" / f"gate-{index}.stdout.log"
            stderr = self.root / "gates" / f"gate-{index}.stderr.log"
            stdout.parent.mkdir(parents=True, exist_ok=True)
            stdout.write_text("PASS\n", encoding="utf-8")
            stderr.write_text("", encoding="utf-8")
            gates.append(
                {
                    "name": name,
                    "status": "PASS",
                    "exit_code": 0,
                    "skip_detected": False,
                    "stdout_sha256": proofmod._sha256_file(stdout),
                    "stderr_sha256": proofmod._sha256_file(stderr),
                    "stdout_file": str(stdout.relative_to(self.root)),
                    "stderr_file": str(stderr.relative_to(self.root)),
                }
            )
        return gates

    def _make_ranges(self) -> None:
        ranges = self.root / "ranges"
        ranges.mkdir(parents=True, exist_ok=True)
        specs = (
            ("M001-M200", 1, 200, "m001-m200.json"),
            ("M201-M400", 201, 400, "m201-m400.json"),
            ("M401-M600", 401, 600, "m401-m600.json"),
            ("M601-M800", 601, 800, "m601-m800.json"),
            ("M801-M1000", 801, 1000, "m801-m1000.json"),
            ("M1001-M2500", 1001, 2500, "m1001-m2500.json"),
        )
        for label, first, last, filename in specs:
            receipts = {}
            for number in range(first, last + 1):
                module_id = f"M{number}"
                evidence_hash = "sha256:" + f"{number:064x}"[-64:]
                if first == 1:
                    receipts[module_id] = {
                        "job_id": f"job-{number}",
                        "module_id": number,
                        "output_hash": evidence_hash,
                        "error": "",
                        "evidence": {
                            "module_id": number,
                            "module_key": module_id,
                            "state": "ON",
                            "execution": "ASYNC_CONTRACT_EVIDENCE",
                            "source_revision": SOURCE_REVISION,
                            "input_hash": SHA,
                            "evidence_hash": evidence_hash,
                        },
                    }
                else:
                    receipts[module_id] = {
                        "module": module_id,
                        "execution_status": "SUCCESS",
                        "finding_status": "NO_FINDING",
                        "evidence_hash": evidence_hash,
                        "output": {"module": module_id},
                    }
            data = {
                "schema_version": 1,
                "receipt_count": last - first + 1,
                "receipts": receipts,
            }
            if first == 1:
                data["source_revision"] = SOURCE_REVISION
            if first == 1001:
                data["first_module"] = "M1001"
                data["last_module"] = "M2500"
                data["execution_hash"] = SHA
                data["terminal_evidence_hash"] = receipts["M2500"]["evidence_hash"]
            path = ranges / filename
            proofmod._write_json(path, data)
            self.outcomes.append(
                {
                    "range": label,
                    "status": "PASS",
                    "reason": "OK",
                    "evidence_file": str(path.relative_to(self.root)),
                }
            )

    def build(self):
        return proofmod._build_and_write_proof(
            self.root,
            SOURCE_REVISION,
            SOURCE_TREE,
            self.outcomes,
            self.gates,
            [],
        )


class ExecutionProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = ProofFixture()

    def tearDown(self) -> None:
        self.fx.cleanup()

    def validation_errors(self, proof):
        base_errors = (
            proofmod.validate_proof_document(proof, self.fx.root)
            + proofmod._validate_verifier_gates(proof, self.fx.root)
            + proofmod._validate_range_containers(proof, self.fx.root)
            + proofmod._validate_raw_receipt_hashes(proof, self.fx.root)
        )
        return base_errors + proofmod._validate_claim(proof, base_errors)

    def assert_validation_fails(self, proof, needle: str) -> None:
        errors = self.validation_errors(proof)
        self.assertTrue(any(needle in error for error in errors), errors)

    def test_complete_2500_fixture_derives_true_claim(self) -> None:
        proof, errors = self.fx.build()
        self.assertEqual(errors, [])
        self.assertTrue(proof["full_execution_claim"])
        self.assertEqual(
            proof["counts"],
            {"EXECUTED": 2500, "FAILED": 0, "BLOCKED": 0, "NOT_TESTED": 0},
        )

    def test_missing_module_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        proof = copy.deepcopy(proof)
        proof["modules"] = [item for item in proof["modules"] if item["module_id"] != "M777"]
        self.assert_validation_fails(proof, "missing_modules")

    def test_duplicate_module_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        proof = copy.deepcopy(proof)
        proof["modules"] = [item for item in proof["modules"] if item["module_id"] != "M2"]
        proof["modules"].append(copy.deepcopy(proof["modules"][0]))
        self.assert_validation_fails(proof, "duplicate_modules")

    def test_corrupt_receipt_container_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        (self.fx.root / "ranges" / "m201-m400.json").write_text("{broken", encoding="utf-8")
        self.assert_validation_fails(proof, "corrupt_receipt_container")

    def test_wrong_receipt_hash_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        proof = copy.deepcopy(proof)
        proof["modules"][0]["receipt_sha256"] = "sha256:" + "0" * 64
        self.assert_validation_fails(proof, "receipt_hash_mismatch:M1")

    def test_source_revision_mismatch_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        proof = copy.deepcopy(proof)
        proof["modules"][99]["source_revision"] = "d" * 40
        self.assert_validation_fails(proof, "source_binding_mismatch:M100")

    def test_timeout_is_blocked(self) -> None:
        outcome = proofmod._subprocess_outcome(
            [sys.executable, "-c", "import time; time.sleep(0.2)"],
            cwd=self.fx.root,
            env={},
            timeout_seconds=0.02,
            stdout_path=self.fx.root / "timeout.stdout",
            stderr_path=self.fx.root / "timeout.stderr",
        )
        self.assertEqual(outcome["status"], "BLOCKED")
        self.assertEqual(outcome["reason"], "TIMEOUT")

    def test_runtime_error_is_not_pass(self) -> None:
        outcome = proofmod._subprocess_outcome(
            [sys.executable, "-c", "raise SystemExit(7)"],
            cwd=self.fx.root,
            env={},
            timeout_seconds=2,
            stdout_path=self.fx.root / "error.stdout",
            stderr_path=self.fx.root / "error.stderr",
        )
        self.assertEqual(outcome["status"], "FAIL")
        self.assertEqual(outcome["reason"], "EXIT_7")

    def test_skip_is_not_pass(self) -> None:
        outcome = proofmod._subprocess_outcome(
            [sys.executable, "-c", "print('SKIP controlled')"],
            cwd=self.fx.root,
            env={},
            timeout_seconds=2,
            stdout_path=self.fx.root / "skip.stdout",
            stderr_path=self.fx.root / "skip.stderr",
        )
        self.assertEqual(outcome["status"], "NOT_TESTED")
        self.assertTrue(outcome["skip_detected"])

    def test_incomplete_evidence_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        proof = copy.deepcopy(proof)
        proof["modules"][1200].pop("evidence_hash")
        self.assert_validation_fails(proof, "invalid_evidence_hash:M1201")

    def test_raw_cardinality_mismatch_is_rejected(self) -> None:
        proof, _ = self.fx.build()
        path = self.fx.root / "ranges" / "m801-m1000.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["receipt_count"] = 199
        proofmod._write_json(path, raw)
        self.assert_validation_fails(proof, "receipt_container_cardinality_mismatch")

    def test_artificial_module_failure_forces_false_claim(self) -> None:
        path = self.fx.root / "ranges" / "m401-m600.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["receipts"]["M401"]["execution_status"] = "ERROR"
        raw["receipts"]["M401"]["finding_status"] = "NOT_APPLICABLE"
        proofmod._write_json(path, raw)
        proof, errors = self.fx.build()
        self.assertEqual(errors, [])
        self.assertFalse(proof["full_execution_claim"])
        self.assertEqual(proof["counts"]["FAILED"], 1)
        self.assertEqual(proof["counts"]["EXECUTED"], 2499)

    def test_not_tested_module_forces_false_claim(self) -> None:
        path = self.fx.root / "ranges" / "m601-m800.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["receipts"]["M601"]["execution_status"] = "SKIP"
        proofmod._write_json(path, raw)
        proof, errors = self.fx.build()
        self.assertEqual(errors, [])
        self.assertFalse(proof["full_execution_claim"])
        self.assertEqual(proof["counts"]["NOT_TESTED"], 1)

    def test_verifier_skip_forces_false_claim(self) -> None:
        gates = copy.deepcopy(self.fx.gates)
        gates[0]["status"] = "FAIL"
        gates[0]["skip_detected"] = True
        proof, errors = proofmod._build_and_write_proof(
            self.fx.root,
            SOURCE_REVISION,
            SOURCE_TREE,
            self.fx.outcomes,
            gates,
            ["verifier_gate_failed:CHAINED_VERIFIER_M201_M2500"],
        )
        self.assertFalse(proof["full_execution_claim"])
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()

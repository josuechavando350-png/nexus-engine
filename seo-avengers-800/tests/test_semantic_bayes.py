from __future__ import annotations

import copy
import unittest

from fixture import rich_payload, row_for
from runtime.common import canonical_json, hash_value
from runtime.manifest import MODULE_SPECS, SEMANTIC_SOURCE_MODULES, SEMANTIC_TARGET_MODULES, source_to_target_map
from runtime.runner import run_module, run_semantic_25
from runtime.semantic_bayes import _entropy_from_counts_ppm


class SemanticBayesSliceTests(unittest.TestCase):
    def test_exact_25_source_target_mapping(self):
        self.assertEqual(SEMANTIC_TARGET_MODULES, tuple(f"M{i}" for i in range(701, 726)))
        self.assertEqual(SEMANTIC_SOURCE_MODULES, tuple(f"M{i}" for i in range(1701, 1726)))
        mapping = source_to_target_map()
        self.assertEqual(mapping["M1701"], "M701")
        self.assertEqual(mapping["M1725"], "M725")
        self.assertEqual(len([s for s in MODULE_SPECS.values() if s["family"] == "SEMANTIC_BAYES"]), 25)

    def test_operations_are_unique_and_non_generic(self):
        operations = [MODULE_SPECS[module_id]["operation"] for module_id in SEMANTIC_TARGET_MODULES]
        self.assertEqual(len(operations), 25)
        self.assertEqual(len(set(operations)), 25)
        self.assertFalse(any("resolver_" in operation or "metric_" in operation for operation in operations))

    def test_all_25_execute_success(self):
        receipts = run_semantic_25(rich_payload(), {})
        self.assertEqual(len(receipts), 25)
        self.assertTrue(all(r["execution_status"] == "SUCCESS" for r in receipts.values()))
        self.assertEqual(len({r["algorithm"] for r in receipts.values()}), 25)

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        first = canonical_json(run_semantic_25(payload, {}))
        second = canonical_json(run_semantic_25(copy.deepcopy(payload), {}))
        self.assertEqual(first, second)

    def test_missing_evidence_is_insufficient_not_fake_no_finding(self):
        receipt = run_module("M702", {"bayesian_semantic_records": [row_for("M701")]}, {})
        self.assertEqual(receipt["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")

    def test_float_rejected_fail_closed(self):
        payload = rich_payload()
        for row in payload["bayesian_semantic_records"]:
            if row["module_id"] == "M701":
                row["prior_probability_ppm"] = 0.95
        receipt = run_module("M701", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["reason_code"], "floats_not_allowed")

    def test_conflicting_duplicate_rejected(self):
        payload = rich_payload()
        duplicate = row_for("M701")
        duplicate["prior_probability_ppm"] = 900_000
        payload["bayesian_semantic_records"].append(duplicate)
        receipt = run_module("M701", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertIn("conflicting_duplicate", receipt["reason_code"])

    def test_config_is_hash_bound(self):
        payload = rich_payload()
        default = run_module("M701", payload, {})
        changed = run_module("M701", payload, {"m701_threshold_ppm": 900_000})
        self.assertNotEqual(default["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(default["evidence_hash"], changed["evidence_hash"])

    def test_uniform_entropy_reaches_one_million(self):
        self.assertEqual(_entropy_from_counts_ppm([10, 10, 10, 10], 4), 1_000_000)

    def test_entropy_bounds_for_skewed_distribution(self):
        score = _entropy_from_counts_ppm([9, 1], 2)
        self.assertGreater(score, 0)
        self.assertLess(score, 1_000_000)

    def test_entropy_single_category_is_zero(self):
        self.assertEqual(_entropy_from_counts_ppm([20], 1), 0)

    def test_entropy_nfc_equivalence(self):
        row = row_for("M702")
        row["token_stream"] = ["café", "cafe\u0301"]
        row["vocabulary_set"] = ["café", "té"]
        payload = {"bayesian_semantic_records": [row]}
        receipt = run_module("M702", payload, {})
        self.assertEqual(receipt["execution_status"], "SUCCESS")
        self.assertEqual(receipt["output"]["metric_ppm"], 0)

    def test_bayes_known_case(self):
        receipt = run_module("M706", rich_payload(), {})
        self.assertEqual(receipt["output"]["metric_ppm"], 1_000_000)

    def test_receipt_hash_format(self):
        receipt = run_module("M701", rich_payload(), {})
        for key in ("raw_input_hash", "normalized_input_hash", "module_config_hash", "evidence_hash"):
            self.assertRegex(receipt[key], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(hash_value({"a": 1}), hash_value({"a": 1}))


if __name__ == "__main__":
    unittest.main()

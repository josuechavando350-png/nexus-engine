from __future__ import annotations

import copy
import unittest

from fixture import rich_payload, row_for
from runtime.common import canonical_json
from runtime.manifest import HTML_SOURCE_MODULES, HTML_TARGET_MODULES, MODULE_SPECS, source_to_target_map
from runtime.runner import run_html_stream_25, run_module


class HtmlStreamingSliceTests(unittest.TestCase):
    def test_exact_25_source_target_mapping(self):
        self.assertEqual(HTML_TARGET_MODULES, tuple(f"M{i}" for i in range(726, 751)))
        self.assertEqual(HTML_SOURCE_MODULES, tuple(f"M{i}" for i in range(1726, 1751)))
        mapping = source_to_target_map()
        self.assertEqual(mapping["M1726"], "M726")
        self.assertEqual(mapping["M1750"], "M750")
        self.assertEqual(len([s for s in MODULE_SPECS.values() if s["family"] == "HTML_STREAM_V2"]), 25)

    def test_operations_are_unique_and_non_generic(self):
        operations = [MODULE_SPECS[module_id]["operation"] for module_id in HTML_TARGET_MODULES]
        self.assertEqual(len(operations), 25)
        self.assertEqual(len(set(operations)), 25)
        self.assertFalse(any("flatten_engine_" in operation or "accelerator_" in operation for operation in operations))

    def test_all_25_execute_success(self):
        receipts = run_html_stream_25(rich_payload(), {})
        self.assertEqual(len(receipts), 25)
        self.assertTrue(all(r["execution_status"] == "SUCCESS" for r in receipts.values()))
        self.assertEqual(len({r["algorithm"] for r in receipts.values()}), 25)

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        first = canonical_json(run_html_stream_25(payload, {}))
        second = canonical_json(run_html_stream_25(copy.deepcopy(payload), {}))
        self.assertEqual(first, second)

    def test_missing_evidence_is_insufficient(self):
        receipt = run_module("M726", {"html_stream_records": [row_for("M727")]}, {})
        self.assertEqual(receipt["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")

    def test_float_rejected_fail_closed(self):
        payload = rich_payload()
        for row in payload["html_stream_records"]:
            if row["module_id"] == "M726":
                row["quic_stream_chunks"] = 100.0
        receipt = run_module("M726", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["reason_code"], "floats_not_allowed")

    def test_conflicting_duplicate_rejected(self):
        payload = rich_payload()
        duplicate = row_for("M726")
        duplicate["aligned_quic_chunks"] = 99
        payload["html_stream_records"].append(duplicate)
        receipt = run_module("M726", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertIn("conflicting_duplicate", receipt["reason_code"])

    def test_config_is_hash_bound(self):
        payload = rich_payload()
        default = run_module("M726", payload, {})
        changed = run_module("M726", payload, {"m726_threshold_ppm": 900_000})
        self.assertNotEqual(default["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(default["evidence_hash"], changed["evidence_hash"])

    def test_representative_metrics_are_exact(self):
        payload = rich_payload()
        for module_id in ("M726", "M736", "M746", "M750"):
            receipt = run_module(module_id, payload, {})
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            self.assertEqual(receipt["output"]["metric_ppm"], 1_000_000)

    def test_singleton_guards_find_duplicates(self):
        payload = rich_payload()
        for row in payload["html_stream_records"]:
            if row["module_id"] == "M746":
                row["canonical_tag_count"] = 2
            if row["module_id"] == "M748":
                row["viewport_tag_count"] = 2
        self.assertEqual(run_module("M746", payload, {})["finding_status"], "FINDING")
        self.assertEqual(run_module("M748", payload, {})["finding_status"], "FINDING")

    def test_stream_completion_requires_expected_tokens(self):
        payload = rich_payload()
        for row in payload["html_stream_records"]:
            if row["module_id"] == "M750":
                row["expected_terminal_tokens"] = []
        receipt = run_module("M750", payload, {})
        self.assertEqual(receipt["execution_status"], "INSUFFICIENT_DATA")


if __name__ == "__main__":
    unittest.main()

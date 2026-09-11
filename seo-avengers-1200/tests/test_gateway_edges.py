import unittest

from runtime.seo_avengers_1200 import (
    canonical_hash,
    compile_receipt,
    inspect_evidence_m1101,
    run_m1102,
)


class GatewayEdgeTests(unittest.TestCase):
    def _good_row(self, module_id="M401"):
        receipt = compile_receipt(
            module_id,
            "fixture",
            1,
            1,
            "sha256:" + "0" * 64,
            "sha256:" + "1" * 64,
            "sha256:" + "2" * 64,
            "SUCCESS",
            "NO_FINDING",
            "OK",
            {"fixture": True},
        )
        return {
            "target_module_id": module_id,
            "reported_evidence_hash": receipt["evidence_hash"],
            "receipt_payload": receipt,
        }

    def test_embedded_evidence_hash_is_excluded_from_rehash(self):
        row = self._good_row()
        receipt, inspected, invalid_count, duplicate_count = inspect_evidence_m1101([row])
        self.assertEqual(receipt["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertEqual(invalid_count, 0)
        self.assertEqual(duplicate_count, 0)
        self.assertEqual(inspected["M401"]["reported_hash"], inspected["M401"]["calculated_hash"])

    def test_receipt_module_identity_must_match_envelope(self):
        row = self._good_row("M401")
        row["target_module_id"] = "M402"
        receipt, inspected, invalid_count, _ = inspect_evidence_m1101([row])
        self.assertEqual(inspected, {})
        self.assertEqual(invalid_count, 1)
        self.assertEqual(receipt["reason_code"], "EVIDENCE_SET_ANOMALY_DETECTED")

    def test_duplicate_module_evidence_is_an_anomaly(self):
        row = self._good_row()
        receipt, _, _, duplicate_count = inspect_evidence_m1101([row, row])
        self.assertEqual(duplicate_count, 1)
        self.assertEqual(receipt["reason_code"], "EVIDENCE_SET_ANOMALY_DETECTED")

    def test_structural_failure_halts_even_at_one_million_threshold(self):
        good = self._good_row()
        _, inspected, invalid_count, duplicate_count = inspect_evidence_m1101([good, "corrupt"])
        gate = run_m1102(
            inspected,
            invalid_count,
            duplicate_count,
            ["M401"],
            {"m1102_max_failure_rate_ppm": 1_000_000},
            canonical_hash({"fixture": 1}),
        )
        self.assertTrue(gate["output"]["deployment_halt_recommended"])
        self.assertEqual(gate["output"]["calculated_failure_rate_ppm"], 1_000_000)
        self.assertEqual(gate["reason_code"], "DEPLOYMENT_HALT_RECOMMENDED")

    def test_manifest_identity_not_just_size_changes_config_hash(self):
        rows = [self._good_row("M401")]
        _, inspected, invalid_count, duplicate_count = inspect_evidence_m1101(rows)
        gate_a = run_m1102(
            inspected,
            invalid_count,
            duplicate_count,
            ["M401"],
            {"m1102_max_failure_rate_ppm": 50_000},
            canonical_hash({"fixture": "a"}),
        )
        gate_b = run_m1102(
            inspected,
            invalid_count,
            duplicate_count,
            ["M402"],
            {"m1102_max_failure_rate_ppm": 50_000},
            canonical_hash({"fixture": "a"}),
        )
        self.assertNotEqual(gate_a["module_config_hash"], gate_b["module_config_hash"])


if __name__ == "__main__":
    unittest.main()

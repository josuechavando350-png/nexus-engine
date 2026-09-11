import json
import unittest

from runtime.legacy_bridge import bridge_semantic200_module_evidence
from runtime.seo_avengers_1200 import canonical_hash
from runtime.service import execute_avengers_1200


class LegacyEvidenceBridgeTests(unittest.TestCase):
    def _legacy_record(self):
        record = {
            "status": "complete",
            "basis": "google-nlp-v2+deterministic-vector",
            "site_id": "probe",
            "route": "/",
            "section_id": "hero",
            "source_revision": "fixture-revision",
            "input_hash": "sha256:" + "a" * 64,
            "entity_count": 2,
            "entity_type_count": 2,
            "query_cosine": 0.8125,
            "embedding_hash": "sha256:" + "b" * 64,
            "normalized_salience": [0.75, 0.25],
        }
        record["evidence_hash"] = canonical_hash({"module_id": 51, **record})
        return record

    def test_valid_semantic200_record_is_independently_verified(self):
        record = self._legacy_record()
        rows, summary = bridge_semantic200_module_evidence({"M51": record})
        self.assertEqual(summary["verified_records"], 1)
        self.assertEqual(summary["rejected_records"], 0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target_module_id"], "M51")
        bridge_receipt = rows[0]["receipt_payload"]
        self.assertEqual(bridge_receipt["reason_code"], "LEGACY_EVIDENCE_VERIFIED")
        self.assertEqual(bridge_receipt["output"]["legacy_evidence_hash"], record["evidence_hash"])

    def test_transport_json_with_float_evidence_reaches_m1101_and_m1102(self):
        record = self._legacy_record()
        payload = {
            "meta_telemetry": {},
            "site_images_data": [],
            "upstream_evidence": [],
            "seo_avengers_200_module_evidence_json": json.dumps(
                {"M51": record},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ),
        }
        config = {
            "CONFIG_SEO_AVENGERS_1200": True,
            "m1102_required_module_ids": ["M51", "M901", "M902", "M1001", "M1002"],
            "m1102_max_failure_rate_ppm": 50_000,
        }
        result = execute_avengers_1200(payload, config)
        self.assertEqual(result["legacy_evidence_bridge"]["verified_records"], 1)
        self.assertEqual(result["legacy_evidence_bridge"]["rejected_records"], 0)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])

    def test_legacy_hash_mismatch_is_not_silently_promoted(self):
        record = self._legacy_record()
        record["evidence_hash"] = "sha256:" + "0" * 64
        payload = {
            "meta_telemetry": {},
            "site_images_data": [],
            "seo_avengers_200_module_evidence": {"M51": record},
        }
        config = {
            "CONFIG_SEO_AVENGERS_1200": True,
            "m1102_required_module_ids": ["M51", "M901", "M902", "M1001", "M1002"],
            "m1102_max_failure_rate_ppm": 1_000_000,
        }
        result = execute_avengers_1200(payload, config)
        self.assertEqual(result["legacy_evidence_bridge"]["verified_records"], 0)
        self.assertEqual(result["legacy_evidence_bridge"]["rejected_records"], 1)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EVIDENCE_SET_ANOMALY_DETECTED")
        self.assertTrue(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])

    def test_direct_and_transport_sources_are_rejected_as_ambiguous(self):
        record = self._legacy_record()
        payload = {
            "meta_telemetry": {},
            "site_images_data": [],
            "seo_avengers_200_module_evidence": {"M51": record},
            "seo_avengers_200_module_evidence_json": json.dumps({"M51": record}),
        }
        config = {
            "CONFIG_SEO_AVENGERS_1200": True,
            "m1102_required_module_ids": ["M51", "M901", "M902", "M1001", "M1002"],
            "m1102_max_failure_rate_ppm": 1_000_000,
        }
        result = execute_avengers_1200(payload, config)
        self.assertEqual(result["legacy_evidence_bridge"]["verified_records"], 0)
        self.assertGreater(result["legacy_evidence_bridge"]["rejected_records"], 0)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EVIDENCE_SET_ANOMALY_DETECTED")
        self.assertTrue(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

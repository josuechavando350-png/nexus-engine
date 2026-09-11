import unittest

from runtime.seo_avengers_1200 import (
    SeoAvengers1200Runtime,
    canonical_hash,
    compile_receipt,
    inspect_evidence_m1101,
    module_registry,
    run_m1102,
)


class RegistryTests(unittest.TestCase):
    def test_registry_is_exactly_1200_and_never_executes_reserved(self):
        registry = module_registry()
        self.assertEqual(len(registry), 1200)
        self.assertEqual(list(registry), [f"M{i}" for i in range(1, 1201)])
        self.assertTrue(all(
            item["executable_here"] is False
            for item in registry.values()
            if item["status"] == "RESERVED"
        ))
        self.assertEqual(registry["M1"]["status"], "DELEGATED_TO_SEO_AVENGERS_200")
        self.assertEqual(registry["M901"]["status"], "IMPLEMENTED_PRODUCTION")

    def test_runtime_is_deny_by_default(self):
        result = SeoAvengers1200Runtime().execute({}, {})
        self.assertTrue(result["bypassed"])
        self.assertFalse(result["enabled"])
        self.assertEqual(result["modules_executed"], 0)


class GoldenVectorTests(unittest.TestCase):
    def setUp(self):
        self.runtime = SeoAvengers1200Runtime()
        self.payload = {
            "meta_telemetry": {
                "server_cpu_utilization_percent": 40,
                "cloudflare_kv_latency_ms": 900,
                "active_pipeline_actions_pool": [
                    {
                        "action": "SEO_MUTATION",
                        "resource_id": "/servicios/Abogado-Penal",
                        "scope": "production",
                    },
                    {
                        "action": "PAGE_REMOVAL",
                        "resource_id": "/servicios/Abogado-Penal",
                        "scope": "production",
                    },
                    {
                        "action": "SEO_MUTATION",
                        "resource_id": "/servicios/Abogado-Penal",
                        "scope": "staging",
                    },
                    {
                        "action": "DESTROY_EVERYTHING",
                        "resource_id": "/servicios/Abogado-Penal",
                        "scope": "production",
                    },
                ],
            },
            "site_images_data": [
                {
                    "image_url": "https://nexusbotstudio.com",
                    "page_url_context": "/servicios/abogado-penal",
                    "occupied_color_bins_count": 120,
                    "histogram_total_bins_count": 512,
                    "extractor_binning_algorithm": "median_cut_v1",
                    "alt_text": "Abogado penalista de confianza en CDMX",
                    "page_context_keywords": "defensa penal delito fraude",
                },
                {
                    "image_url": "https://nexusbotstudio.com",
                    "page_url_context": "/blog/corporativo-estrategia",
                    "occupied_color_bins_count": 120,
                    "histogram_total_bins_count": 512,
                    "extractor_binning_algorithm": "median_cut_v1",
                    "alt_text": "Equipo corporativo premium",
                    "page_context_keywords": "derecho mercantil empresas",
                },
            ],
        }
        self.config = {
            "CONFIG_SEO_AVENGERS_1200": True,
            "m901_max_safe_cpu_percent": 80,
            "m901_max_safe_kv_latency_ms": 150,
            "m901_kv_saturation_latency_ms": 1000,
            "m1001_min_chromatic_diversity_ppm": 400000,
            "m1002_min_lexical_alignment_ppm": 300000,
            "m1102_max_failure_rate_ppm": 50000,
        }

    def test_extended_chain(self):
        result = self.runtime.execute(self.payload, self.config)
        self.assertEqual(result["modules_executed"], 6)

        m901 = result["receipts"]["M901"]
        self.assertEqual(m901["output"]["cpu_pressure_ppm"], 0)
        self.assertEqual(m901["output"]["kv_pressure_ppm"], 882353)
        self.assertEqual(m901["output"]["recommended_throttle_ppm"], 882353)

        m902 = result["receipts"]["M902"]
        self.assertTrue(m902["output"]["logical_contradiction_found"])
        self.assertEqual(m902["output"]["invalid_or_unknown_actions_count"], 1)
        self.assertEqual(len(m902["output"]["detected_collisions"]), 1)

        m1001 = result["receipts"]["M1001"]
        self.assertEqual(
            m1001["output"]["low_diversity_images"][0]["calculated_diversity_ppm"],
            234375,
        )

        m1002 = result["receipts"]["M1002"]
        self.assertEqual(m1002["output"]["analyzed_observations_count"], 2)
        self.assertEqual(len(m1002["output"]["misaligned_visual_metadata_observations"]), 2)

        m1101 = result["receipts"]["M1101"]
        self.assertEqual(m1101["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")

        m1102 = result["receipts"]["M1102"]
        self.assertFalse(m1102["output"]["deployment_halt_recommended"])
        self.assertEqual(m1102["output"]["calculated_failure_rate_ppm"], 0)

    def test_m1001_conflicting_duplicate_measurement_fails_closed(self):
        payload = dict(self.payload)
        payload["site_images_data"] = [
            dict(self.payload["site_images_data"][0]),
            {
                **self.payload["site_images_data"][0],
                "occupied_color_bins_count": 121,
            },
        ]
        result = self.runtime.execute(payload, self.config)
        m1001 = result["receipts"]["M1001"]
        self.assertEqual(m1001["execution_status"], "ERROR")
        self.assertEqual(m1001["reason_code"], "DUPLICATE_MEASUREMENT_CONFLICT")

    def test_m1102_invalid_and_missing_evidence_halts(self):
        good = compile_receipt(
            "M401",
            "fixture",
            1,
            1,
            "sha256:" + "0" * 64,
            "sha256:" + "1" * 64,
            "sha256:" + "2" * 64,
            "SUCCESS",
            "NO_FINDING",
            "OK",
            {"value": 1},
        )
        rows = [
            {
                "target_module_id": "M401",
                "reported_evidence_hash": good["evidence_hash"],
                "receipt_payload": good,
            },
            {
                "target_module_id": "M601",
                "reported_evidence_hash": "sha256:not-a-real-sha256",
                "receipt_payload": {"module": "M601"},
            },
            "corrupt-record",
        ]
        m1101, inspected, invalid_count, duplicate_count = inspect_evidence_m1101(rows)
        self.assertEqual(m1101["reason_code"], "EVIDENCE_SET_ANOMALY_DETECTED")
        self.assertEqual(invalid_count, 2)

        m1102 = run_m1102(
            inspected,
            invalid_count,
            duplicate_count,
            ["M401", "M601", "M901"],
            {"m1102_max_failure_rate_ppm": 50000},
            canonical_hash({"raw_evidence": rows}),
        )
        self.assertTrue(m1102["output"]["deployment_halt_recommended"])
        self.assertEqual(m1102["output"]["calculated_failure_rate_ppm"], 1000000)
        self.assertEqual(m1102["reason_code"], "DEPLOYMENT_HALT_RECOMMENDED")


if __name__ == "__main__":
    unittest.main()

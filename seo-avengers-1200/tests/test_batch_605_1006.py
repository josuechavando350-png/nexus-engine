import unittest

from runtime.batch_605_1006 import (
    run_m605,
    run_m606,
    run_m705,
    run_m706,
    run_m805,
    run_m806,
    run_m1005,
    run_m1006,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch6051006Tests(unittest.TestCase):
    def test_m605_detects_dominant_token_concentration(self):
        text = " ".join(["alpha"] * 8 + ["beta", "gamma"])
        result = run_m605(
            [{"document_id": "/a", "text": text}],
            {"m605_min_tokens": 10, "m605_max_dominant_token_share_ppm": 700_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "DOMINANT_TOKEN_CONCENTRATION_HIGH")
        finding = result["output"]["high_concentration_documents"][0]
        self.assertEqual(finding["dominant_token"], "alpha")
        self.assertEqual(finding["dominant_token_share_ppm"], 800_000)

    def test_m606_measures_content_length_dispersion_without_float(self):
        result = run_m606(
            [
                {"document_id": "/short", "text": " ".join(f"uno{i}" for i in range(10))},
                {"document_id": "/long-a", "text": " ".join(f"dos{i}" for i in range(100))},
                {"document_id": "/long-b", "text": " ".join(f"tres{i}" for i in range(100))},
            ],
            {"m606_min_documents": 3, "m606_min_document_tokens": 1,
             "m606_max_relative_mad_ppm": 500_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "CONTENT_LENGTH_DISPERSION_HIGH")
        self.assertEqual(result["output"]["relative_mad_ppm"], 571_429)

    def test_m705_measures_brand_competitor_comention_share(self):
        result = run_m705(
            [
                {"source_url": "https://a.example/x", "html": "<p>Nexus Bot y Competidor Uno</p>", "authority_score_ppm": 1},
                {"source_url": "https://b.example/x", "html": "<p>Nexus Bot y Competidor Uno</p>", "authority_score_ppm": 1},
                {"source_url": "https://c.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 1},
            ],
            {"m705_brand_terms": ["Nexus Bot"], "m705_competitor_terms": ["Competidor Uno"],
             "m705_min_relevant_documents": 3, "m705_max_comention_share_ppm": 500_000},
        )
        self.assertEqual(result["reason_code"], "BRAND_COMPETITOR_COMENTION_SHARE_HIGH")
        self.assertEqual(result["output"]["comention_share_ppm"], 666_667)
        self.assertEqual(len(result["output"]["comention_sources"]), 2)

    def test_m706_weights_link_coverage_by_observed_authority(self):
        result = run_m706(
            [
                {"source_url": "https://a.example/x", "html": '<p>Nexus Bot</p><a href="https://nexusbotstudio.com/x">sitio</a>', "authority_score_ppm": 100_000},
                {"source_url": "https://b.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 900_000},
            ],
            {"m706_brand_terms": ["Nexus Bot"], "m706_owned_hosts": ["nexusbotstudio.com"],
             "m706_min_brand_mention_authority_ppm": 1, "m706_min_weighted_link_coverage_ppm": 500_000},
        )
        self.assertEqual(result["reason_code"], "AUTHORITY_WEIGHTED_LINKED_BRAND_COVERAGE_LOW")
        self.assertEqual(result["output"]["weighted_link_coverage_ppm"], 100_000)

    def test_m805_detects_low_modal_nap_consensus_without_canonical_record(self):
        result = run_m805(
            [
                {"source_id": "a", "name": "Nexus", "address": "Reforma 1", "phone": "+52 55 1111 1111"},
                {"source_id": "b", "name": "Nexus", "address": "Reforma 1", "phone": "+52 55 1111 1111"},
                {"source_id": "c", "name": "Nexus Studio", "address": "Reforma 2", "phone": "+52 55 1111 1111"},
            ],
            {"m805_min_sources_per_field": 3, "m805_min_modal_consensus_ppm": 800_000},
        )
        self.assertEqual(result["reason_code"], "LOCAL_NAP_MODAL_CONSENSUS_LOW")
        low = {item["field"]: item["modal_consensus_ppm"] for item in result["output"]["low_consensus_fields"]}
        self.assertEqual(low["name"], 666_667)
        self.assertEqual(low["address"], 666_667)
        self.assertNotIn("phone_digits", low)

    def test_m806_detects_coordinate_outlier_from_component_median(self):
        result = run_m806(
            [
                {"source_id": "a", "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
                {"source_id": "b", "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
                {"source_id": "c", "latitude_e6": 19_452_600, "longitude_e6": -99_133_200},
            ],
            {"m806_min_coordinate_sources": 3, "m806_max_l1_median_deviation_e6": 5_000},
        )
        self.assertEqual(result["reason_code"], "LOCAL_COORDINATE_MEDIAN_DEVIATION_HIGH")
        self.assertEqual(result["output"]["max_l1_median_deviation_e6"], 20_000)
        self.assertEqual(result["output"]["out_of_policy_sources"][0]["source_id"], "c")

    def test_m1005_detects_asset_reuse_across_many_pages(self):
        result = run_m1005(
            [
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "occurrence_id": "x", "alt_text": "uno dos"},
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/b", "occurrence_id": "x", "alt_text": "uno dos"},
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/c", "occurrence_id": "x", "alt_text": "uno dos"},
            ],
            {"m1005_min_occurrences": 3, "m1005_max_distinct_pages_per_image": 2},
        )
        self.assertEqual(result["reason_code"], "IMAGE_ASSET_PAGE_REUSE_HIGH")
        self.assertEqual(result["output"]["high_reuse_assets"][0]["distinct_page_count"], 3)

    def test_m1006_audits_alt_token_count_bounds_without_accessibility_claim(self):
        result = run_m1006(
            [{"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "occurrence_id": "hero", "alt_text": "abogado"}],
            {"m1006_min_alt_tokens": 2, "m1006_max_alt_tokens": 10,
             "m1006_min_nonempty_alt_occurrences": 1},
        )
        self.assertEqual(result["reason_code"], "IMAGE_ALT_TOKEN_COUNT_OUT_OF_BOUNDS")
        finding = result["output"]["out_of_bounds_alt_occurrences"][0]
        self.assertEqual(finding["bound_violation"], "BELOW_MIN")
        self.assertEqual(finding["alt_token_count"], 1)

    def test_catalog_and_gateway_include_all_fifty_eight_pre_gate_modules(self):
        registry = module_registry()
        self.assertEqual(len(IMPLEMENTED_EXTENDED_MODULES), 60)
        self.assertEqual(len(PRE_GATE_MODULES), 58)
        for module_id in ("M605", "M606", "M705", "M706", "M805", "M806", "M1005", "M1006"):
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])
        self.assertEqual(registry["M1007"]["status"], "RESERVED")
        self.assertFalse(registry["M1007"]["executable_here"])

        result = execute_avengers_1200({}, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(result["reserved_extended_modules"], 940)
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], 58)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

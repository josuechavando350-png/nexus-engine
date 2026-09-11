import unittest

from runtime.batch_603_1004 import (
    run_m603,
    run_m604,
    run_m703,
    run_m704,
    run_m803,
    run_m804,
    run_m1003,
    run_m1004,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch6031004Tests(unittest.TestCase):
    def test_m603_detects_low_lexical_breadth(self):
        result = run_m603(
            [{"document_id": "/a", "text": "alpha alpha alpha beta beta gamma"}],
            {"m603_min_tokens": 6, "m603_min_unique_token_share_ppm": 600_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "LOW_CONTENT_LEXICAL_BREADTH_FOUND")
        finding = result["output"]["low_breadth_documents"][0]
        self.assertEqual(finding["unique_token_share_ppm"], 500_000)
        self.assertEqual(finding["unique_token_count"], 3)

    def test_m604_detects_short_relative_content_outlier(self):
        long_a = " ".join(f"palabra{i}" for i in range(40))
        long_b = " ".join(f"termino{i}" for i in range(40))
        result = run_m604(
            [
                {"document_id": "/short", "text": "uno dos tres cuatro"},
                {"document_id": "/long-a", "text": long_a},
                {"document_id": "/long-b", "text": long_b},
            ],
            {"m604_min_documents": 3, "m604_min_document_tokens": 1,
             "m604_min_relative_length_ppm": 500_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "SHORT_CONTENT_OUTLIER_FOUND")
        self.assertEqual(result["output"]["lower_median_token_count"], 40)
        self.assertEqual(result["output"]["short_content_outliers"][0]["relative_to_lower_median_ppm"], 100_000)

    def test_m703_measures_owned_link_coverage_on_brand_mentions(self):
        pages = [
            {"source_url": "https://a.example/x", "html": '<p>Nexus Bot</p><a href="https://nexusbotstudio.com/x">sitio</a>', "authority_score_ppm": 1},
            {"source_url": "https://b.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 1},
            {"source_url": "https://c.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 1},
        ]
        result = run_m703(
            pages,
            {"m703_brand_terms": ["Nexus Bot"], "m703_owned_hosts": ["nexusbotstudio.com"],
             "m703_min_mention_documents": 3, "m703_min_linked_mention_share_ppm": 500_000},
        )
        self.assertEqual(result["reason_code"], "LINKED_BRAND_MENTION_COVERAGE_LOW")
        self.assertEqual(result["output"]["linked_mention_share_ppm"], 333_333)
        self.assertEqual(len(result["output"]["unlinked_mention_sources"]), 2)

    def test_m704_measures_authority_weighted_brand_presence(self):
        result = run_m704(
            [
                {"source_url": "https://brand.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 100_000},
                {"source_url": "https://competitor.example/x", "html": "<p>Competidor Uno</p>", "authority_score_ppm": 900_000},
            ],
            {"m704_brand_terms": ["Nexus Bot"], "m704_competitor_terms": ["Competidor Uno"],
             "m704_min_relevant_authority_ppm": 1, "m704_min_weighted_brand_share_ppm": 250_000},
        )
        self.assertEqual(result["reason_code"], "AUTHORITY_WEIGHTED_BRAND_PRESENCE_LOW")
        self.assertEqual(result["output"]["weighted_brand_share_ppm"], 100_000)

    def test_m803_detects_incomplete_local_listing_fields(self):
        result = run_m803(
            [
                {"source_id": "complete", "name": "Nexus", "address": "Reforma 1", "phone": "+52 55 1234 5678",
                 "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
                {"source_id": "incomplete", "name": "Nexus", "address": "Reforma 1", "phone": "",
                 "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
            ],
            {"m803_min_sources": 2, "m803_min_complete_source_share_ppm": 800_000},
        )
        self.assertEqual(result["reason_code"], "LOCAL_LISTING_COMPLETENESS_LOW")
        self.assertEqual(result["output"]["complete_source_share_ppm"], 500_000)
        self.assertEqual(result["output"]["incomplete_sources"][0]["missing_fields"], ["phone"])

    def test_m804_detects_coordinate_consensus_spread(self):
        result = run_m804(
            [
                {"source_id": "a", "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
                {"source_id": "b", "latitude_e6": 19_442_600, "longitude_e6": -99_133_200},
            ],
            {"m804_min_coordinate_sources": 2, "m804_max_pairwise_l1_spread_e6": 5_000},
        )
        self.assertEqual(result["reason_code"], "LOCAL_COORDINATE_CONSENSUS_SPREAD_HIGH")
        self.assertEqual(result["output"]["max_pairwise_l1_spread_e6"], 10_000)
        self.assertEqual(result["output"]["max_spread_source_pair"], ["a", "b"])

    def test_m1003_measures_alt_presence_coverage(self):
        result = run_m1003(
            [
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "occurrence_id": "hero", "alt_text": "Equipo legal"},
                {"image_url": "https://cdn.example/b.jpg", "page_url_context": "/b", "occurrence_id": "hero", "alt_text": ""},
            ],
            {"m1003_min_occurrences": 2, "m1003_min_alt_presence_share_ppm": 900_000},
        )
        self.assertEqual(result["reason_code"], "IMAGE_ALT_PRESENCE_COVERAGE_LOW")
        self.assertEqual(result["output"]["alt_presence_share_ppm"], 500_000)
        self.assertEqual(len(result["output"]["missing_alt_occurrences"]), 1)

    def test_m1004_detects_duplicate_alt_across_distinct_assets(self):
        result = run_m1004(
            [
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "occurrence_id": "hero", "alt_text": "Equipo legal experto"},
                {"image_url": "https://cdn.example/b.jpg", "page_url_context": "/b", "occurrence_id": "hero", "alt_text": "Equipo legal experto"},
            ],
            {"m1004_min_distinct_images_per_alt": 2, "m1004_min_alt_tokens": 2},
        )
        self.assertEqual(result["reason_code"], "DUPLICATE_ALT_TEXT_ACROSS_ASSETS_FOUND")
        finding = result["output"]["duplicate_alt_groups"][0]
        self.assertEqual(finding["distinct_image_count"], 2)

    def test_conflicting_image_occurrence_fails_closed(self):
        result = run_m1003(
            [
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "alt_text": "Alt uno"},
                {"image_url": "https://cdn.example/a.jpg", "page_url_context": "/a", "alt_text": "Alt dos"},
            ],
            {},
        )
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "DUPLICATE_IMAGE_OCCURRENCE_CONFLICT")

    def test_original_603_1004_batch_remains_promoted_as_catalog_grows(self):
        registry = module_registry()
        original_batch = {"M603", "M604", "M703", "M704", "M803", "M804", "M1003", "M1004"}
        self.assertTrue(original_batch.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(original_batch.issubset(set(PRE_GATE_MODULES)))
        for module_id in original_batch:
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])

    def test_current_pre_gate_manifest_reaches_integrity_gateway(self):
        result = execute_avengers_1200({}, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(result["reserved_extended_modules"], 1000 - len(IMPLEMENTED_EXTENDED_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

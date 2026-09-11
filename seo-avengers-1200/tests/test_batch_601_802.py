import unittest

from runtime.batch_601_802 import (
    run_m601,
    run_m602,
    run_m701,
    run_m702,
    run_m801,
    run_m802,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch601802Tests(unittest.TestCase):
    def test_m601_identical_long_documents_are_detected(self):
        text = " ".join(f"token{i}" for i in range(40))
        result = run_m601(
            [
                {"document_id": "/a", "text": text},
                {"document_id": "/b", "text": text},
            ],
            {"m601_similarity_threshold_ppm": 900_000, "m601_shingle_size": 5, "m601_min_tokens": 20},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "HIGH_INTERNAL_CONTENT_SIMILARITY_FOUND")
        self.assertEqual(result["output"]["analyzed_pairs_count"], 1)
        self.assertEqual(result["output"]["similar_document_pairs"][0]["jaccard_similarity_ppm"], 1_000_000)

    def test_m601_conflicting_duplicate_document_fails_closed(self):
        result = run_m601(
            [
                {"document_id": "/a", "text": "uno dos tres cuatro cinco seis siete ocho nueve diez once doce"},
                {"document_id": "/a", "text": "contenido completamente distinto para el mismo documento fuente"},
            ],
            {"m601_min_tokens": 5, "m601_shingle_size": 2},
        )
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "DUPLICATE_DOCUMENT_CONFLICT")

    def test_m602_like_for_like_decay_is_review_candidate(self):
        result = run_m602(
            [{"document_id": "/guia", "baseline_clicks": 100, "current_clicks": 50,
              "baseline_impressions": 1000, "current_impressions": 700,
              "baseline_window_days": 28, "current_window_days": 28, "age_days": 120}],
            {"m602_min_decline_ppm": 300_000, "m602_min_age_days": 60,
             "m602_min_baseline_clicks": 10, "m602_min_baseline_impressions": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "CONTENT_DECAY_REVIEW_CANDIDATE_FOUND")
        candidate = result["output"]["review_candidates"][0]
        self.assertEqual(candidate["click_decline_ppm"], 500_000)
        self.assertEqual(candidate["impression_decline_ppm"], 300_000)
        self.assertTrue(candidate["review_recommended"])

    def test_m701_detects_external_unlinked_mention_only(self):
        pages = [
            {"source_url": "https://example.org/post-a", "html": "<html><body><p>Nexus Bot ayuda a negocios.</p></body></html>", "authority_score_ppm": 700_000},
            {"source_url": "https://example.net/post-b", "html": '<html><body><p>Nexus Bot</p><a href="https://nexusbotstudio.com/">sitio</a></body></html>', "authority_score_ppm": 500_000},
            {"source_url": "https://example.com/post-c", "html": "<html><body><script>Nexus Bot</script><p>sin marca elegible</p></body></html>", "authority_score_ppm": 900_000},
        ]
        result = run_m701(pages, {"m701_brand_terms": ["Nexus Bot"], "m701_owned_hosts": ["nexusbotstudio.com"]})
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "UNLINKED_BRAND_MENTION_FOUND")
        self.assertEqual(len(result["output"]["unlinked_brand_mentions"]), 1)
        self.assertEqual(result["output"]["unlinked_brand_mentions"][0]["source_url"], "https://example.org/post-a")

    def test_m702_uses_guarded_relevant_corpus_share(self):
        pages = [
            {"source_url": "https://a.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 1},
            {"source_url": "https://b.example/x", "html": "<p>Competidor Uno</p>", "authority_score_ppm": 1},
            {"source_url": "https://c.example/x", "html": "<p>Competidor Uno</p>", "authority_score_ppm": 1},
            {"source_url": "https://d.example/x", "html": "<p>tema no rastreado</p>", "authority_score_ppm": 1},
        ]
        result = run_m702(
            pages,
            {"m702_brand_terms": ["Nexus Bot"], "m702_competitor_terms": ["Competidor Uno"],
             "m702_min_sample_documents": 3, "m702_min_brand_share_ppm": 400_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["relevant_sample_documents_count"], 3)
        self.assertEqual(result["output"]["brand_mention_documents_count"], 1)
        self.assertEqual(result["output"]["corpus_brand_share_ppm"], 333_333)
        self.assertEqual(result["reason_code"], "LOW_BRAND_PROMINENCE_SHARE_FOUND")

    def test_m801_strict_nap_reports_exact_field_mismatch(self):
        config = {"m801_canonical_nap": {"name": "Nexus Bot Studio", "address": "Av Reforma 100, CDMX", "phone": "+52 55 1234 5678"}}
        result = run_m801(
            [
                {"source_id": "google-business-profile", "name": "Nexus Bot Studio", "address": "Av Reforma 100, CDMX", "phone": "+52 55 1234 5678"},
                {"source_id": "directory-x", "name": "Nexus Bot Studio", "address": "Av Reforma 101, CDMX", "phone": "+52 55 1234 5678"},
            ],
            config,
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "LOCAL_NAP_INCONSISTENCY_FOUND")
        mismatch = result["output"]["inconsistent_sources"][0]
        self.assertEqual(mismatch["source_id"], "directory-x")
        self.assertEqual(mismatch["mismatched_fields"], ["address"])

    def test_m802_integer_microdegree_l1_deviation(self):
        result = run_m802(
            [
                {"source_id": "a", "latitude_e6": 19_432_600, "longitude_e6": -99_133_200},
                {"source_id": "b", "latitude_e6": 19_442_600, "longitude_e6": -99_133_200},
            ],
            {"m802_reference_latitude_e6": 19_432_600, "m802_reference_longitude_e6": -99_133_200,
             "m802_max_l1_deviation_e6": 5_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "LOCAL_GEOLOCATION_DEVIATION_FOUND")
        self.assertEqual(result["output"]["out_of_policy_sources"][0]["l1_deviation_e6"], 10_000)

    def test_601_802_modules_remain_promoted_inside_expanded_catalog(self):
        registry = module_registry()
        required = {"M601", "M602", "M701", "M702", "M801", "M802"}
        self.assertTrue(required.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(required.issubset(set(PRE_GATE_MODULES)))
        for module_id in required:
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])

    def test_service_connects_all_current_pre_gate_receipts_to_m1101_m1102(self):
        repeated = " ".join(f"palabra{i}" for i in range(30))
        payload = {
            "meta_telemetry": {"server_cpu_utilization_percent": 20, "cloudflare_kv_latency_ms": 50,
                               "active_pipeline_actions_pool": []},
            "site_images_data": [],
            "content_documents": [{"document_id": "/a", "text": repeated}, {"document_id": "/b", "text": repeated}],
            "content_decay_records": [{"document_id": "/a", "baseline_clicks": 100, "current_clicks": 90,
                                        "baseline_impressions": 1000, "current_impressions": 900,
                                        "baseline_window_days": 28, "current_window_days": 28, "age_days": 100}],
            "external_pages": [
                {"source_url": "https://one.example/x", "html": "<p>Nexus Bot</p>", "authority_score_ppm": 1},
                {"source_url": "https://two.example/x", "html": "<p>Competidor Uno</p>", "authority_score_ppm": 1},
            ],
            "local_business_records": [{"source_id": "gbp", "name": "Nexus Bot Studio",
                                        "address": "Av Reforma 100, CDMX", "phone": "+52 55 1234 5678",
                                        "latitude_e6": 19_432_600, "longitude_e6": -99_133_200}],
            "upstream_evidence": [],
        }
        config = {
            "CONFIG_SEO_AVENGERS_1200": True,
            "m601_min_tokens": 20, "m601_shingle_size": 5,
            "m702_brand_terms": ["Nexus Bot"], "m702_competitor_terms": ["Competidor Uno"],
            "m702_min_sample_documents": 2,
            "m701_brand_terms": ["Nexus Bot"], "m701_owned_hosts": ["nexusbotstudio.com"],
            "m801_canonical_nap": {"name": "Nexus Bot Studio", "address": "Av Reforma 100, CDMX", "phone": "+52 55 1234 5678"},
            "m802_reference_latitude_e6": 19_432_600, "m802_reference_longitude_e6": -99_133_200,
        }
        result = execute_avengers_1200(payload, config)
        self.assertEqual(result["implemented_extended_modules"], sorted(IMPLEMENTED_EXTENDED_MODULES, key=lambda mid: int(mid[1:])))
        self.assertEqual(result["reserved_extended_modules"], 1000 - len(IMPLEMENTED_EXTENDED_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))


if __name__ == "__main__":
    unittest.main()

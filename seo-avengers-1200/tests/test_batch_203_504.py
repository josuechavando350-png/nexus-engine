import unittest

from runtime.batch_203_504 import (
    run_m203,
    run_m204,
    run_m303,
    run_m304,
    run_m403,
    run_m404,
    run_m503,
    run_m504,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch203504Tests(unittest.TestCase):
    def test_m203_detects_material_zero_click_exposure(self):
        result = run_m203(
            [{
                "query": "abogado penal",
                "page_url": "/penal",
                "clicks": 0,
                "impressions": 500,
                "average_position_milli": 5_000,
            }],
            {"m203_min_impressions": 100, "m203_max_average_position_milli": 10_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "ZERO_CLICK_SEARCH_EXPOSURE_FOUND")
        self.assertEqual(result["output"]["zero_click_exposures"][0]["impressions"], 500)

    def test_m204_detects_query_exposure_across_multiple_pages(self):
        result = run_m204(
            [
                {"query": "defensa penal", "page_url": "/a", "clicks": 3, "impressions": 70, "average_position_milli": 6_000},
                {"query": "defensa penal", "page_url": "/b", "clicks": 2, "impressions": 80, "average_position_milli": 7_000},
            ],
            {"m204_min_query_impressions": 100, "m204_min_distinct_pages": 2},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "MULTI_PAGE_QUERY_EXPOSURE_FOUND")
        finding = result["output"]["multi_page_queries"][0]
        self.assertEqual(finding["total_impressions"], 150)
        self.assertEqual(finding["distinct_pages_count"], 2)

    def test_m303_measures_competitor_saturation_share(self):
        result = run_m303(
            [
                {"keyword": "uno", "site_ranked": False, "competitor_ranked_count": 4, "search_volume": 80},
                {"keyword": "dos", "site_ranked": True, "competitor_ranked_count": 3, "search_volume": 70},
                {"keyword": "tres", "site_ranked": True, "competitor_ranked_count": 1, "search_volume": 50},
            ],
            {"m303_min_competitor_ranked_count": 3, "m303_max_saturated_volume_share_ppm": 700_000,
             "m303_min_tracked_search_volume": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["saturated_volume_share_ppm"], 750_000)
        self.assertEqual(result["reason_code"], "COMPETITOR_SATURATION_SHARE_HIGH")

    def test_m304_detects_concentrated_uncovered_opportunity(self):
        result = run_m304(
            [
                {"keyword": "principal", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 80},
                {"keyword": "secundaria", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 20},
                {"keyword": "cubierta", "site_ranked": True, "competitor_ranked_count": 3, "search_volume": 100},
            ],
            {"m304_top_opportunity_count": 1, "m304_max_top_opportunity_share_ppm": 700_000,
             "m304_min_uncovered_search_volume": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["top_opportunity_share_ppm"], 800_000)
        self.assertEqual(result["reason_code"], "UNCOVERED_OPPORTUNITY_CONCENTRATION_HIGH")

    def test_m403_detects_consecutive_decline_streak(self):
        result = run_m403(
            [{"entity_id": "/", "visits_series": [100, 90, 80, 70, 60, 60, 61]}],
            {"m403_min_points": 7, "m403_min_consecutive_declines": 3},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "SUSTAINED_TRAFFIC_DECLINE_STREAK_FOUND")
        self.assertEqual(result["output"]["declining_entities"][0]["longest_consecutive_declines"], 4)

    def test_m404_detects_single_interval_concentration(self):
        result = run_m404(
            [{"entity_id": "/", "visits_series": [100, 10, 10, 10, 10, 10, 10]}],
            {"m404_min_points": 7, "m404_max_peak_share_ppm": 400_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["concentrated_entities"][0]["peak_share_ppm"], 625_000)
        self.assertEqual(result["reason_code"], "TRAFFIC_PEAK_CONCENTRATION_HIGH")

    def test_m503_reports_only_observed_funnel_stage_weakness(self):
        result = run_m503(
            [{"source_id": "organic", "sessions": 1000, "lead_conversion_ppm": 10_000,
              "close_rate_ppm": 300_000, "average_ticket_micros": 5_000_000}],
            {"m503_min_sessions": 100, "m503_min_lead_conversion_ppm": 20_000,
             "m503_min_close_rate_ppm": 200_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "FUNNEL_STAGE_CONVERSION_BELOW_POLICY")
        self.assertEqual(result["output"]["below_policy_sources"][0]["below_policy_stages"], ["LEAD_CONVERSION"])

    def test_m504_detects_attributed_revenue_source_concentration(self):
        result = run_m504(
            [
                {"source_id": "organic", "total_revenue_micros": 900, "attributed_revenue_micros": 800},
                {"source_id": "paid", "total_revenue_micros": 300, "attributed_revenue_micros": 200},
            ],
            {"m504_top_source_count": 1, "m504_max_top_source_share_ppm": 700_000,
             "m504_min_total_attributed_revenue_micros": 1},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["top_source_share_ppm"], 800_000)
        self.assertEqual(result["reason_code"], "ATTRIBUTED_REVENUE_SOURCE_CONCENTRATION_HIGH")

    def test_catalog_truthfully_has_twenty_eight_extended_modules(self):
        registry = module_registry()
        self.assertEqual(len(IMPLEMENTED_EXTENDED_MODULES), 28)
        self.assertEqual(len(PRE_GATE_MODULES), 26)
        self.assertEqual(registry["M204"]["status"], "IMPLEMENTED_PRODUCTION")
        self.assertEqual(registry["M504"]["status"], "IMPLEMENTED_PRODUCTION")
        self.assertEqual(registry["M505"]["status"], "RESERVED")
        self.assertFalse(registry["M505"]["executable_here"])

    def test_all_twenty_six_pre_gate_receipts_reach_integrity_gateway(self):
        payload = {
            "meta_telemetry": {},
            "site_images_data": [],
            "search_performance_records": [],
            "keyword_coverage_records": [],
            "traffic_window_records": [],
            "traffic_series_records": [],
            "revenue_funnel_records": [],
            "revenue_attribution_records": [],
            "content_documents": [],
            "content_decay_records": [],
            "external_pages": [],
            "local_business_records": [],
            "upstream_evidence": [],
        }
        result = execute_avengers_1200(payload, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(result["implemented_extended_modules"],
                         sorted(IMPLEMENTED_EXTENDED_MODULES, key=lambda mid: int(mid[1:])))
        self.assertEqual(result["reserved_extended_modules"], 972)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], 26)


if __name__ == "__main__":
    unittest.main()

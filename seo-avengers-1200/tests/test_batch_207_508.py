import unittest

from runtime.batch_207_508 import (
    run_m207,
    run_m208,
    run_m307,
    run_m308,
    run_m407,
    run_m408,
    run_m507,
    run_m508,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch207508Tests(unittest.TestCase):
    def test_m207_detects_page_impression_concentration(self):
        result = run_m207(
            [
                {"query": "uno", "page_url": "/a", "clicks": 80, "impressions": 800, "average_position_milli": 4_000},
                {"query": "dos", "page_url": "/a", "clicks": 10, "impressions": 100, "average_position_milli": 5_000},
                {"query": "tres", "page_url": "/b", "clicks": 10, "impressions": 100, "average_position_milli": 6_000},
            ],
            {"m207_top_page_count": 1, "m207_max_top_page_impression_share_ppm": 800_000,
             "m207_min_total_impressions": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "SEARCH_PAGE_IMPRESSION_CONCENTRATION_HIGH")
        self.assertEqual(result["output"]["top_page_impression_share_ppm"], 900_000)
        self.assertEqual(result["output"]["top_pages"][0]["page_url"], "/a")

    def test_m208_aggregates_ctr_at_page_level(self):
        result = run_m208(
            [
                {"query": "uno", "page_url": "/a", "clicks": 5, "impressions": 500, "average_position_milli": 4_000},
                {"query": "dos", "page_url": "/a", "clicks": 5, "impressions": 500, "average_position_milli": 9_000},
            ],
            {"m208_min_page_impressions": 100, "m208_min_page_ctr_ppm": 20_000},
        )
        self.assertEqual(result["reason_code"], "LOW_PAGE_LEVEL_SEARCH_CTR_FOUND")
        self.assertEqual(result["output"]["low_ctr_pages"][0]["ctr_ppm"], 10_000)

    def test_m307_measures_competitor_covered_gap_volume(self):
        result = run_m307(
            [
                {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 800},
                {"keyword": "covered", "site_ranked": True, "competitor_ranked_count": 2, "search_volume": 200},
                {"keyword": "irrelevant", "site_ranked": True, "competitor_ranked_count": 0, "search_volume": 500},
            ],
            {"m307_min_competitor_covered_search_volume": 100, "m307_max_gap_volume_share_ppm": 500_000},
        )
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_VOLUME_SHARE_HIGH")
        self.assertEqual(result["output"]["gap_volume_share_ppm"], 800_000)
        self.assertEqual(result["output"]["site_absent_search_volume"], 800)

    def test_m308_computes_volume_weighted_competitor_intensity(self):
        result = run_m308(
            [
                {"keyword": "uno", "site_ranked": True, "competitor_ranked_count": 4, "search_volume": 800},
                {"keyword": "dos", "site_ranked": False, "competitor_ranked_count": 1, "search_volume": 200},
            ],
            {"m308_min_tracked_search_volume": 100, "m308_max_weighted_competitor_count_milli": 3_000},
        )
        self.assertEqual(result["reason_code"], "WEIGHTED_COMPETITOR_INTENSITY_HIGH")
        self.assertEqual(result["output"]["weighted_competitor_count_milli"], 3_400)

    def test_m407_detects_consecutive_zero_run(self):
        result = run_m407(
            [{"entity_id": "/", "visits_series": [5, 0, 0, 0, 2, 0, 0]}],
            {"m407_min_points": 7, "m407_min_consecutive_zero_intervals": 3},
        )
        self.assertEqual(result["reason_code"], "SUSTAINED_ZERO_TRAFFIC_RUN_FOUND")
        self.assertEqual(result["output"]["zero_run_entities"][0]["longest_consecutive_zero_intervals"], 3)

    def test_m408_detects_peak_to_later_trough_drawdown(self):
        result = run_m408(
            [{"entity_id": "/", "visits_series": [100, 90, 80, 50, 70, 60, 80]}],
            {"m408_min_points": 7, "m408_min_peak_visits": 50, "m408_min_drawdown_ppm": 300_000},
        )
        self.assertEqual(result["reason_code"], "MATERIAL_TRAFFIC_DRAWDOWN_FOUND")
        self.assertEqual(result["output"]["material_drawdowns"][0]["max_drawdown_ppm"], 500_000)

    def test_m507_detects_unattributed_revenue_concentration(self):
        result = run_m507(
            [
                {"source_id": "organic", "total_revenue_micros": 1000, "attributed_revenue_micros": 100},
                {"source_id": "paid", "total_revenue_micros": 100, "attributed_revenue_micros": 100},
                {"source_id": "referral", "total_revenue_micros": 100, "attributed_revenue_micros": 0},
            ],
            {"m507_top_source_count": 1, "m507_max_top_unattributed_share_ppm": 700_000,
             "m507_min_total_unattributed_revenue_micros": 1},
        )
        self.assertEqual(result["reason_code"], "UNATTRIBUTED_REVENUE_CONCENTRATION_HIGH")
        self.assertEqual(result["output"]["top_unattributed_share_ppm"], 900_000)

    def test_m508_measures_attribution_breadth_across_material_sources(self):
        result = run_m508(
            [
                {"source_id": "organic", "total_revenue_micros": 100, "attributed_revenue_micros": 100},
                {"source_id": "paid", "total_revenue_micros": 100, "attributed_revenue_micros": 0},
                {"source_id": "referral", "total_revenue_micros": 100, "attributed_revenue_micros": 50},
            ],
            {"m508_min_material_sources": 3, "m508_min_source_revenue_micros": 1,
             "m508_min_attributed_source_share_ppm": 800_000},
        )
        self.assertEqual(result["reason_code"], "REVENUE_SOURCE_ATTRIBUTION_BREADTH_LOW")
        self.assertEqual(result["output"]["attributed_source_share_ppm"], 666_667)
        self.assertEqual(result["output"]["fully_unattributed_sources"], ["paid"])

    def test_duplicate_search_observation_fails_closed(self):
        result = run_m208(
            [
                {"query": "uno", "page_url": "/a", "clicks": 1, "impressions": 100, "average_position_milli": 4_000},
                {"query": "uno", "page_url": "/a", "clicks": 2, "impressions": 100, "average_position_milli": 4_000},
            ],
            {},
        )
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "DUPLICATE_SEARCH_OBSERVATION_CONFLICT")

    def test_catalog_and_gateway_include_all_forty_two_pre_gate_modules(self):
        registry = module_registry()
        self.assertEqual(len(IMPLEMENTED_EXTENDED_MODULES), 44)
        self.assertEqual(len(PRE_GATE_MODULES), 42)
        self.assertEqual(registry["M508"]["status"], "IMPLEMENTED_PRODUCTION")
        self.assertEqual(registry["M509"]["status"], "RESERVED")
        self.assertFalse(registry["M509"]["executable_here"])

        result = execute_avengers_1200({}, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(result["reserved_extended_modules"], 956)
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], 42)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

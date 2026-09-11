import unittest

from runtime.batch_205_506 import (
    run_m205,
    run_m206,
    run_m305,
    run_m306,
    run_m405,
    run_m406,
    run_m505,
    run_m506,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch205506Tests(unittest.TestCase):
    def test_m205_measures_configured_position_band_exposure(self):
        result = run_m205(
            [
                {"query": "a", "page_url": "/a", "clicks": 10, "impressions": 600, "average_position_milli": 15_000},
                {"query": "b", "page_url": "/b", "clicks": 20, "impressions": 400, "average_position_milli": 5_000},
            ],
            {"m205_min_average_position_milli": 10_000, "m205_max_average_position_milli": 20_000,
             "m205_min_total_impressions": 100, "m205_min_band_exposure_share_ppm": 500_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["band_exposure_share_ppm"], 600_000)
        self.assertEqual(result["reason_code"], "SEARCH_POSITION_BAND_EXPOSURE_HIGH")

    def test_m206_detects_click_concentration(self):
        result = run_m206(
            [
                {"query": "a", "page_url": "/a", "clicks": 80, "impressions": 100, "average_position_milli": 1_000},
                {"query": "b", "page_url": "/b", "clicks": 20, "impressions": 100, "average_position_milli": 2_000},
            ],
            {"m206_top_record_count": 1, "m206_max_top_click_share_ppm": 700_000, "m206_min_total_clicks": 10},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["top_click_share_ppm"], 800_000)
        self.assertEqual(result["reason_code"], "SEARCH_CLICK_CONCENTRATION_HIGH")

    def test_m305_measures_count_based_keyword_breadth(self):
        result = run_m305(
            [
                {"keyword": "a", "site_ranked": True, "competitor_ranked_count": 1, "search_volume": 100},
                {"keyword": "b", "site_ranked": False, "competitor_ranked_count": 1, "search_volume": 100},
                {"keyword": "c", "site_ranked": False, "competitor_ranked_count": 1, "search_volume": 100},
                {"keyword": "d", "site_ranked": False, "competitor_ranked_count": 1, "search_volume": 100},
            ],
            {"m305_min_relevant_keywords": 4, "m305_min_keyword_coverage_ppm": 500_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["keyword_coverage_ppm"], 250_000)
        self.assertEqual(result["reason_code"], "COMPETITIVE_KEYWORD_BREADTH_LOW")

    def test_m306_measures_contested_site_coverage(self):
        result = run_m306(
            [
                {"keyword": "a", "site_ranked": True, "competitor_ranked_count": 2, "search_volume": 800},
                {"keyword": "b", "site_ranked": True, "competitor_ranked_count": 0, "search_volume": 200},
                {"keyword": "c", "site_ranked": False, "competitor_ranked_count": 5, "search_volume": 1000},
            ],
            {"m306_max_contested_coverage_ppm": 700_000, "m306_min_site_covered_search_volume": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["contested_coverage_ppm"], 800_000)
        self.assertEqual(result["reason_code"], "CONTESTED_SITE_COVERAGE_SHARE_HIGH")

    def test_m405_detects_sparse_zero_interval_series(self):
        result = run_m405(
            [{"entity_id": "/", "visits_series": [0, 0, 0, 10, 10, 10, 10, 10]}],
            {"m405_min_points": 8, "m405_max_zero_interval_share_ppm": 300_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["sparse_entities"][0]["zero_interval_share_ppm"], 375_000)
        self.assertEqual(result["reason_code"], "TRAFFIC_ZERO_INTERVAL_SHARE_HIGH")

    def test_m406_detects_equal_half_window_shift(self):
        result = run_m406(
            [{"entity_id": "/", "visits_series": [25, 25, 25, 25, 50, 50, 50, 50]}],
            {"m406_min_points": 8, "m406_min_absolute_shift_ppm": 500_000, "m406_min_first_half_visits": 100},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        finding = result["output"]["material_shifts"][0]
        self.assertEqual(finding["direction"], "UP")
        self.assertEqual(finding["absolute_shift_ppm"], 1_000_000)

    def test_m505_composes_only_supplied_funnel_rates(self):
        result = run_m505(
            [{"source_id": "organic", "sessions": 1000, "lead_conversion_ppm": 100_000,
              "close_rate_ppm": 100_000, "average_ticket_micros": 1_000_000}],
            {"m505_min_sessions": 100, "m505_min_composed_conversion_ppm": 20_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["output"]["below_policy_sources"][0]["composed_conversion_ppm"], 10_000)
        self.assertEqual(result["reason_code"], "COMPOSED_FUNNEL_CONVERSION_BELOW_POLICY")

    def test_m506_detects_source_level_attribution_gap(self):
        result = run_m506(
            [
                {"source_id": "organic", "total_revenue_micros": 1000, "attributed_revenue_micros": 600},
                {"source_id": "paid", "total_revenue_micros": 1000, "attributed_revenue_micros": 950},
            ],
            {"m506_min_source_revenue_micros": 1, "m506_min_source_attribution_coverage_ppm": 900_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        gap = result["output"]["source_attribution_gaps"][0]
        self.assertEqual(gap["source_id"], "organic")
        self.assertEqual(gap["attribution_coverage_ppm"], 600_000)
        self.assertEqual(gap["unattributed_revenue_micros"], 400)

    def test_original_205_506_batch_remains_promoted_as_catalog_grows(self):
        registry = module_registry()
        original_batch = {"M205", "M206", "M305", "M306", "M405", "M406", "M505", "M506"}
        self.assertTrue(original_batch.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(original_batch.issubset(set(PRE_GATE_MODULES)))
        for module_id in original_batch:
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])

    def test_current_pre_gate_manifest_reaches_integrity_gateway(self):
        result = execute_avengers_1200({}, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(
            result["implemented_extended_modules"],
            sorted(IMPLEMENTED_EXTENDED_MODULES, key=lambda module_id: int(module_id[1:])),
        )
        self.assertEqual(result["reserved_extended_modules"], 1000 - len(IMPLEMENTED_EXTENDED_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertEqual(
            result["receipts"]["M1101"]["output"]["checked_modules_count"],
            len(PRE_GATE_MODULES),
        )


if __name__ == "__main__":
    unittest.main()

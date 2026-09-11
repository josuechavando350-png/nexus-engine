import unittest

from runtime.batch_201_502 import (
    run_m201,
    run_m202,
    run_m301,
    run_m302,
    run_m401,
    run_m402,
    run_m501,
    run_m502,
)
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch201502Tests(unittest.TestCase):
    def test_m201_detects_high_impression_low_ctr_observation(self):
        receipt = run_m201(
            [{"query": "abogado penal", "page_url": "/penal", "clicks": 10, "impressions": 1000, "average_position_milli": 5000}],
            {"m201_min_impressions": 100, "m201_max_ctr_ppm": 20_000, "m201_max_average_position_milli": 10_000},
        )
        self.assertEqual(receipt["execution_status"], "SUCCESS")
        self.assertEqual(receipt["reason_code"], "LOW_CTR_SEARCH_OPPORTUNITY_FOUND")
        self.assertEqual(receipt["output"]["opportunities"][0]["ctr_ppm"], 10_000)

    def test_m202_detects_demand_concentration(self):
        receipt = run_m202(
            [
                {"query": "a", "impressions": 800},
                {"query": "b", "impressions": 100},
                {"query": "c", "impressions": 100},
            ],
            {"m202_top_query_count": 1, "m202_max_top_query_share_ppm": 700_000, "m202_min_total_impressions": 100},
        )
        self.assertEqual(receipt["reason_code"], "SEARCH_DEMAND_CONCENTRATION_HIGH")
        self.assertEqual(receipt["output"]["top_query_share_ppm"], 800_000)

    def test_m301_and_m302_use_real_keyword_coverage_records(self):
        records = [
            {"keyword": "seo local", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 900},
            {"keyword": "diseño web", "site_ranked": True, "competitor_ranked_count": 1, "search_volume": 100},
        ]
        gap = run_m301(records, {"m301_min_competitor_ranked_count": 1, "m301_min_search_volume": 10})
        self.assertEqual(gap["reason_code"], "COMPETITOR_KEYWORD_GAP_FOUND")
        self.assertEqual(gap["output"]["keyword_gaps"][0]["keyword"], "seo local")

        share = run_m302(records, {"m302_min_weighted_coverage_ppm": 500_000, "m302_min_tracked_search_volume": 100})
        self.assertEqual(share["reason_code"], "COMPETITIVE_COVERAGE_SHARE_LOW")
        self.assertEqual(share["output"]["weighted_coverage_ppm"], 100_000)

    def test_m401_detects_equal_window_traffic_drop(self):
        receipt = run_m401(
            [{"entity_id": "/", "baseline_visits": 1000, "current_visits": 700, "baseline_window_days": 28, "current_window_days": 28}],
            {"m401_min_baseline_visits": 100, "m401_min_absolute_change_ppm": 200_000},
        )
        self.assertEqual(receipt["reason_code"], "MATERIAL_TRAFFIC_CHANGE_FOUND")
        item = receipt["output"]["material_changes"][0]
        self.assertEqual(item["direction"], "DOWN")
        self.assertEqual(item["absolute_change_ppm"], 300_000)

    def test_m402_computes_integer_relative_mad(self):
        receipt = run_m402(
            [{"entity_id": "/", "visits_series": [0, 0, 100, 100]}],
            {"m402_min_points": 4, "m402_max_relative_mad_ppm": 500_000},
        )
        self.assertEqual(receipt["reason_code"], "TRAFFIC_VOLATILITY_HIGH")
        self.assertEqual(receipt["output"]["volatile_entities"][0]["relative_mad_ppm"], 1_000_000)

    def test_m501_projects_only_from_explicit_funnel_rates(self):
        receipt = run_m501(
            [{"source_id": "organic", "sessions": 1000, "lead_conversion_ppm": 100_000, "close_rate_ppm": 200_000, "average_ticket_micros": 1_000_000}],
            {"m501_min_sessions": 100},
        )
        self.assertEqual(receipt["execution_status"], "SUCCESS")
        self.assertEqual(receipt["finding_status"], "NO_FINDING")
        projection = receipt["output"]["projections"][0]
        self.assertEqual(projection["projected_leads"], 100)
        self.assertEqual(projection["projected_sales"], 20)
        self.assertEqual(projection["projected_revenue_micros"], 20_000_000)

    def test_m502_detects_low_attribution_coverage(self):
        receipt = run_m502(
            [{"source_id": "all", "total_revenue_micros": 100_000_000, "attributed_revenue_micros": 80_000_000}],
            {"m502_min_attribution_coverage_ppm": 900_000},
        )
        self.assertEqual(receipt["reason_code"], "REVENUE_ATTRIBUTION_COVERAGE_LOW")
        self.assertEqual(receipt["output"]["attribution_coverage_ppm"], 800_000)

    def test_original_201_502_batch_remains_promoted_as_catalog_grows(self):
        registry = module_registry()
        original_batch = {"M201", "M202", "M301", "M302", "M401", "M402", "M501", "M502"}
        self.assertTrue(original_batch.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(original_batch.issubset(PRE_GATE_MODULES))
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
        self.assertEqual(
            result["receipts"]["M1101"]["output"]["checked_modules_count"],
            len(PRE_GATE_MODULES),
        )
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

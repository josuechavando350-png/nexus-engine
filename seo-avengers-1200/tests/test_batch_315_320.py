import unittest

from runtime.batch_315_320 import run_m315
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch315320Tests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"keyword": "gap uno", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap dos", "site_ranked": False, "competitor_ranked_count": 4, "search_volume": 300},
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 5, "search_volume": 100},
        ]
        self.config = {
            "m315_min_gap_search_volume": 100,
            "m315_max_weighted_upper_quartile_gap_competitor_count": 3,
        }

    def test_m315_golden_weighted_upper_quartile_pressure(self):
        result = run_m315(self.records, self.config)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_WEIGHTED_UPPER_QUARTILE_PRESSURE_HIGH")
        self.assertEqual(result["output"]["gap_search_volume"], 400)
        self.assertEqual(result["output"]["gap_keyword_count"], 2)
        self.assertEqual(result["output"]["weighted_upper_quartile_target_search_volume"], 300)
        self.assertEqual(result["output"]["weighted_upper_quartile_gap_competitor_count"], 4)
        self.assertEqual(result["output"]["weighted_upper_quartile_support_keyword"], "gap dos")
        self.assertEqual(result["output"]["weighted_upper_quartile_support_search_volume"], 300)

    def test_m315_boundary_is_not_false_positive(self):
        result = run_m315(self.records, {
            "m315_min_gap_search_volume": 100,
            "m315_max_weighted_upper_quartile_gap_competitor_count": 4,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(
            result["reason_code"],
            "COMPETITIVE_GAP_WEIGHTED_UPPER_QUARTILE_PRESSURE_WITHIN_POLICY",
        )

    def test_m315_exact_quartile_target_has_deterministic_threshold_crossing(self):
        records = [
            {"keyword": "uno", "site_ranked": False, "competitor_ranked_count": 1, "search_volume": 100},
            {"keyword": "dos", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "tres", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 100},
            {"keyword": "cuatro", "site_ranked": False, "competitor_ranked_count": 4, "search_volume": 100},
        ]
        result = run_m315(records, {
            "m315_min_gap_search_volume": 100,
            "m315_max_weighted_upper_quartile_gap_competitor_count": 3,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["output"]["weighted_upper_quartile_target_search_volume"], 300)
        self.assertEqual(result["output"]["weighted_upper_quartile_gap_competitor_count"], 3)
        self.assertEqual(result["output"]["weighted_upper_quartile_support_keyword"], "tres")

    def test_m315_returns_insufficient_without_observed_gap_volume(self):
        result = run_m315([
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 5, "search_volume": 500},
        ], self.config)
        self.assertEqual(result["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(result["reason_code"], "INSUFFICIENT_COMPETITIVE_GAP_VOLUME")

    def test_m315_conflicting_duplicate_fails_closed(self):
        result = run_m315([
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 100},
        ], self.config)
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "DUPLICATE_KEYWORD_COVERAGE_CONFLICT")

    def test_m315_malformed_record_fails_closed(self):
        result = run_m315(self.records + [
            {"keyword": "mal", "site_ranked": False, "competitor_ranked_count": -1, "search_volume": 100},
        ], self.config)
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(result["reason_code"], "INVALID_KEYWORD_COVERAGE_RECORDS")
        self.assertEqual(result["output"]["invalid_records_count"], 1)

    def test_m315_invalid_config_fails_closed(self):
        result = run_m315(self.records, {
            "m315_min_gap_search_volume": 0,
            "m315_max_weighted_upper_quartile_gap_competitor_count": 3,
        })
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(result["reason_code"], "INVALID_MODULE_CONFIG")

    def test_m315_is_deterministic_and_config_hash_bound(self):
        first = run_m315(self.records, self.config)
        second = run_m315(self.records, self.config)
        changed = run_m315(self.records, {
            "m315_min_gap_search_volume": 100,
            "m315_max_weighted_upper_quartile_gap_competitor_count": 4,
        })
        self.assertEqual(first, second)
        self.assertIsNotNone(first["raw_input_hash"])
        self.assertIsNotNone(first["normalized_input_hash"])
        self.assertIsNotNone(first["module_config_hash"])
        self.assertIsNotNone(first["evidence_hash"])
        self.assertNotEqual(first["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(first["evidence_hash"], changed["evidence_hash"])

    def test_m315_is_registered_executable_and_gateway_connected_while_m316_is_reserved(self):
        registry = module_registry()
        self.assertIn("M315", IMPLEMENTED_EXTENDED_MODULES)
        self.assertIn("M315", PRE_GATE_MODULES)
        self.assertEqual(registry["M315"]["status"], "IMPLEMENTED_PRODUCTION")
        self.assertTrue(registry["M315"]["executable_here"])
        self.assertEqual(registry["M316"]["status"], "RESERVED")
        self.assertFalse(registry["M316"]["executable_here"])

        result = execute_avengers_1200(
            {"keyword_coverage_records": self.records},
            {"CONFIG_SEO_AVENGERS_1200": True, **self.config},
        )
        self.assertIn("M315", result["receipts"])
        self.assertEqual(result["receipts"]["M315"]["execution_status"], "SUCCESS")
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

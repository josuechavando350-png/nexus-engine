import unittest

from runtime.batch_309_314 import run_m309


class Batch309314Tests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"keyword": "gap uno", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap dos", "site_ranked": False, "competitor_ranked_count": 4, "search_volume": 300},
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 5, "search_volume": 100},
        ]
        self.config = {
            "m309_min_gap_search_volume": 100,
            "m309_max_weighted_gap_competitor_count_milli": 3_000,
        }

    def test_m309_golden_weighted_gap_pressure(self):
        result = run_m309(self.records, self.config)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_PRESSURE_HIGH")
        self.assertEqual(result["output"]["gap_search_volume"], 400)
        self.assertEqual(result["output"]["weighted_gap_competitor_count_milli"], 3_500)
        self.assertEqual([row["keyword"] for row in result["output"]["gap_keywords"]], ["gap dos", "gap uno"])

    def test_m309_boundary_is_not_false_positive(self):
        result = run_m309(self.records, {
            "m309_min_gap_search_volume": 100,
            "m309_max_weighted_gap_competitor_count_milli": 3_500,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_PRESSURE_WITHIN_POLICY")

    def test_m309_insufficient_data_without_real_gap_volume(self):
        result = run_m309([
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 4, "search_volume": 500},
        ], self.config)
        self.assertEqual(result["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(result["reason_code"], "INSUFFICIENT_COMPETITIVE_GAP_VOLUME")

    def test_m309_conflicting_duplicate_fails_closed(self):
        result = run_m309([
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 100},
        ], self.config)
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "DUPLICATE_KEYWORD_COVERAGE_CONFLICT")

    def test_m309_malformed_record_fails_closed(self):
        result = run_m309(self.records + [
            {"keyword": "mal", "site_ranked": False, "competitor_ranked_count": -1, "search_volume": 100},
        ], self.config)
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(result["reason_code"], "INVALID_KEYWORD_COVERAGE_RECORDS")
        self.assertEqual(result["output"]["invalid_records_count"], 1)

    def test_m309_invalid_config_fails_closed(self):
        result = run_m309(self.records, {
            "m309_min_gap_search_volume": 0,
            "m309_max_weighted_gap_competitor_count_milli": 3_000,
        })
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "INVALID_MODULE_CONFIG")

    def test_m309_is_deterministic_and_hash_bound(self):
        first = run_m309(self.records, self.config)
        second = run_m309(self.records, self.config)
        changed = run_m309(self.records, {
            **self.config,
            "m309_max_weighted_gap_competitor_count_milli": 3_500,
        })
        self.assertEqual(first, second)
        self.assertIsNotNone(first["raw_input_hash"])
        self.assertIsNotNone(first["normalized_input_hash"])
        self.assertIsNotNone(first["module_config_hash"])
        self.assertIsNotNone(first["evidence_hash"])
        self.assertNotEqual(first["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(first["evidence_hash"], changed["evidence_hash"])


if __name__ == "__main__":
    unittest.main()

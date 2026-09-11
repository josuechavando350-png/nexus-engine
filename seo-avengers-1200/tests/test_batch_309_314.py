import unittest

from runtime.batch_309_314 import run_m309, run_m310, run_m311, run_m312
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch309314Tests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"keyword": "gap uno", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap dos", "site_ranked": False, "competitor_ranked_count": 4, "search_volume": 300},
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 5, "search_volume": 100},
        ]

    def _audit_cases(self):
        covered_only = [
            {"keyword": "cubierto", "site_ranked": True, "competitor_ranked_count": 4, "search_volume": 500},
        ]
        low_pressure_only = [
            {"keyword": "baja presion", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 500},
        ]
        return [
            (
                "M309", run_m309,
                {"m309_min_gap_search_volume": 100, "m309_max_weighted_gap_competitor_count_milli": 3_000},
                {"m309_min_gap_search_volume": 100, "m309_max_weighted_gap_competitor_count_milli": 3_500},
                {"m309_min_gap_search_volume": 0, "m309_max_weighted_gap_competitor_count_milli": 3_000},
                covered_only, "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            ),
            (
                "M310", run_m310,
                {"m310_min_gap_search_volume": 100, "m310_high_pressure_competitor_count": 4,
                 "m310_max_high_pressure_gap_volume_share_ppm": 700_000},
                {"m310_min_gap_search_volume": 100, "m310_high_pressure_competitor_count": 4,
                 "m310_max_high_pressure_gap_volume_share_ppm": 750_000},
                {"m310_min_gap_search_volume": 100, "m310_high_pressure_competitor_count": 0,
                 "m310_max_high_pressure_gap_volume_share_ppm": 700_000},
                covered_only, "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            ),
            (
                "M311", run_m311,
                {"m311_min_high_pressure_search_volume": 100, "m311_high_pressure_competitor_count": 4,
                 "m311_min_site_coverage_share_ppm": 500_000},
                {"m311_min_high_pressure_search_volume": 100, "m311_high_pressure_competitor_count": 4,
                 "m311_min_site_coverage_share_ppm": 250_000},
                {"m311_min_high_pressure_search_volume": 100, "m311_high_pressure_competitor_count": 0,
                 "m311_min_site_coverage_share_ppm": 500_000},
                low_pressure_only, "INSUFFICIENT_HIGH_PRESSURE_COMPETITIVE_VOLUME",
            ),
            (
                "M312", run_m312,
                {"m312_min_gap_search_volume": 100, "m312_max_gap_pressure_mad_milli": 700},
                {"m312_min_gap_search_volume": 100, "m312_max_gap_pressure_mad_milli": 750},
                {"m312_min_gap_search_volume": 0, "m312_max_gap_pressure_mad_milli": 700},
                covered_only, "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            ),
        ]

    def test_m309_golden_weighted_gap_pressure(self):
        result = run_m309(self.records, {
            "m309_min_gap_search_volume": 100,
            "m309_max_weighted_gap_competitor_count_milli": 3_000,
        })
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
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_PRESSURE_WITHIN_POLICY")

    def test_m310_golden_high_pressure_gap_tail_share(self):
        result = run_m310(self.records, {
            "m310_min_gap_search_volume": 100,
            "m310_high_pressure_competitor_count": 4,
            "m310_max_high_pressure_gap_volume_share_ppm": 700_000,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "HIGH_PRESSURE_GAP_VOLUME_SHARE_HIGH")
        self.assertEqual(result["output"]["gap_search_volume"], 400)
        self.assertEqual(result["output"]["high_pressure_gap_search_volume"], 300)
        self.assertEqual(result["output"]["high_pressure_gap_volume_share_ppm"], 750_000)
        self.assertEqual([row["keyword"] for row in result["output"]["high_pressure_keywords"]], ["gap dos"])

    def test_m310_boundary_is_not_false_positive(self):
        result = run_m310(self.records, {
            "m310_min_gap_search_volume": 100,
            "m310_high_pressure_competitor_count": 4,
            "m310_max_high_pressure_gap_volume_share_ppm": 750_000,
        })
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["reason_code"], "HIGH_PRESSURE_GAP_VOLUME_SHARE_WITHIN_POLICY")

    def test_m311_golden_high_pressure_site_coverage_share(self):
        result = run_m311(self.records, {
            "m311_min_high_pressure_search_volume": 100,
            "m311_high_pressure_competitor_count": 4,
            "m311_min_site_coverage_share_ppm": 500_000,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "HIGH_PRESSURE_SITE_COVERAGE_LOW")
        self.assertEqual(result["output"]["high_pressure_search_volume"], 400)
        self.assertEqual(result["output"]["site_covered_high_pressure_search_volume"], 100)
        self.assertEqual(result["output"]["high_pressure_site_coverage_ppm"], 250_000)
        self.assertEqual(
            [row["keyword"] for row in result["output"]["uncovered_high_pressure_keywords"]],
            ["gap dos"],
        )

    def test_m311_boundary_is_not_false_positive(self):
        result = run_m311(self.records, {
            "m311_min_high_pressure_search_volume": 100,
            "m311_high_pressure_competitor_count": 4,
            "m311_min_site_coverage_share_ppm": 250_000,
        })
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["reason_code"], "HIGH_PRESSURE_SITE_COVERAGE_WITHIN_POLICY")

    def test_m312_golden_weighted_gap_pressure_dispersion(self):
        result = run_m312(self.records, {
            "m312_min_gap_search_volume": 100,
            "m312_max_gap_pressure_mad_milli": 700,
        })
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_PRESSURE_DISPERSION_HIGH")
        self.assertEqual(result["output"]["gap_search_volume"], 400)
        self.assertEqual(result["output"]["gap_keyword_count"], 2)
        self.assertEqual(result["output"]["weighted_gap_competitor_count_milli"], 3_500)
        self.assertEqual(result["output"]["weighted_gap_pressure_mad_milli"], 750)

    def test_m312_boundary_is_not_false_positive(self):
        result = run_m312(self.records, {
            "m312_min_gap_search_volume": 100,
            "m312_max_gap_pressure_mad_milli": 750,
        })
        self.assertEqual(result["finding_status"], "NO_FINDING")
        self.assertEqual(result["reason_code"], "COMPETITIVE_GAP_PRESSURE_DISPERSION_WITHIN_POLICY")

    def test_each_audited_module_returns_insufficient_without_required_real_sample(self):
        for module_id, handler, config, _, _, records, reason_code in self._audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, config)
                self.assertEqual(result["execution_status"], "INSUFFICIENT_DATA")
                self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
                self.assertEqual(result["reason_code"], reason_code)

    def test_each_audited_module_conflicting_duplicate_fails_closed(self):
        records = [
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 2, "search_volume": 100},
            {"keyword": "gap", "site_ranked": False, "competitor_ranked_count": 3, "search_volume": 100},
        ]
        for module_id, handler, config, _, _, _, _ in self._audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, config)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["reason_code"], "DUPLICATE_KEYWORD_COVERAGE_CONFLICT")

    def test_each_audited_module_malformed_record_fails_closed(self):
        records = self.records + [
            {"keyword": "mal", "site_ranked": False, "competitor_ranked_count": -1, "search_volume": 100},
        ]
        for module_id, handler, config, _, _, _, _ in self._audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, config)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
                self.assertEqual(result["reason_code"], "INVALID_KEYWORD_COVERAGE_RECORDS")
                self.assertEqual(result["output"]["invalid_records_count"], 1)

    def test_each_audited_module_invalid_config_fails_closed(self):
        for module_id, handler, _, _, invalid_config, _, _ in self._audit_cases():
            with self.subTest(module=module_id):
                result = handler(self.records, invalid_config)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["reason_code"], "INVALID_MODULE_CONFIG")

    def test_each_audited_module_is_deterministic_and_config_hash_bound(self):
        for module_id, handler, config, changed_config, _, _, _ in self._audit_cases():
            with self.subTest(module=module_id):
                first = handler(self.records, config)
                second = handler(self.records, config)
                changed = handler(self.records, changed_config)
                self.assertEqual(first, second)
                self.assertIsNotNone(first["raw_input_hash"])
                self.assertIsNotNone(first["normalized_input_hash"])
                self.assertIsNotNone(first["module_config_hash"])
                self.assertIsNotNone(first["evidence_hash"])
                self.assertNotEqual(first["module_config_hash"], changed["module_config_hash"])
                self.assertNotEqual(first["evidence_hash"], changed["evidence_hash"])

    def test_promoted_modules_are_executable_and_gateway_connected(self):
        registry = module_registry()
        required = {"M309", "M310", "M311", "M312"}
        self.assertTrue(required.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(required.issubset(set(PRE_GATE_MODULES)))
        for module_id in required:
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])
        self.assertEqual(registry["M313"]["status"], "RESERVED")
        self.assertFalse(registry["M313"]["executable_here"])

        result = execute_avengers_1200(
            {"keyword_coverage_records": self.records},
            {"CONFIG_SEO_AVENGERS_1200": True,
             "m309_min_gap_search_volume": 100,
             "m309_max_weighted_gap_competitor_count_milli": 3_000,
             "m310_min_gap_search_volume": 100,
             "m310_high_pressure_competitor_count": 4,
             "m310_max_high_pressure_gap_volume_share_ppm": 700_000,
             "m311_min_high_pressure_search_volume": 100,
             "m311_high_pressure_competitor_count": 4,
             "m311_min_site_coverage_share_ppm": 500_000,
             "m312_min_gap_search_volume": 100,
             "m312_max_gap_pressure_mad_milli": 700},
        )
        for module_id in required:
            self.assertIn(module_id, result["receipts"])
            self.assertEqual(result["receipts"][module_id]["execution_status"], "SUCCESS")
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

import unittest

from runtime.batch_209_214 import run_m209, run_m210, run_m211, run_m212, run_m213, run_m214
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.service import execute_avengers_1200


class Batch209214Tests(unittest.TestCase):
    def _audit_records(self):
        return [
            {"query": "uno", "page_url": "/a", "clicks": 10, "impressions": 100, "average_position_milli": 10_000},
            {"query": "dos", "page_url": "/a", "clicks": 30, "impressions": 100, "average_position_milli": 20_000},
            {"query": "tres", "page_url": "/a", "clicks": 50, "impressions": 100, "average_position_milli": 30_000},
        ]

    def _module_audit_cases(self):
        return [
            ("M209", run_m209,
             {"m209_min_total_impressions": 1, "m209_max_weighted_average_position_milli": 20_000},
             {"m209_min_total_impressions": 1, "m209_max_weighted_average_position_milli": 25_000},
             {"m209_min_total_impressions": 0}),
            ("M210", run_m210,
             {"m210_min_total_clicks": 1, "m210_max_weighted_average_position_milli": 20_000},
             {"m210_min_total_clicks": 1, "m210_max_weighted_average_position_milli": 25_000},
             {"m210_min_total_clicks": 0}),
            ("M211", run_m211,
             {"m211_min_page_impressions": 1, "m211_min_distinct_queries": 2},
             {"m211_min_page_impressions": 1, "m211_min_distinct_queries": 3},
             {"m211_min_page_impressions": 0, "m211_min_distinct_queries": 2}),
            ("M212", run_m212,
             {"m212_min_page_impressions": 1, "m212_max_zero_click_impression_share_ppm": 500_000},
             {"m212_min_page_impressions": 1, "m212_max_zero_click_impression_share_ppm": 600_000},
             {"m212_min_page_impressions": 0}),
            ("M213", run_m213,
             {"m213_min_total_impressions": 1, "m213_max_weighted_position_mad_milli": 10_000},
             {"m213_min_total_impressions": 1, "m213_max_weighted_position_mad_milli": 20_000},
             {"m213_min_total_impressions": 0}),
            ("M214", run_m214,
             {"m214_min_query_impressions": 1, "m214_min_queries": 2, "m214_max_query_ctr_mad_ppm": 150_000},
             {"m214_min_query_impressions": 1, "m214_min_queries": 2, "m214_max_query_ctr_mad_ppm": 200_000},
             {"m214_min_query_impressions": 0, "m214_min_queries": 2}),
        ]

    def test_m209_impression_weighted_position_uses_explicit_impressions(self):
        result = run_m209(
            [
                {"query": "uno", "page_url": "/a", "clicks": 10, "impressions": 100, "average_position_milli": 10_000},
                {"query": "dos", "page_url": "/b", "clicks": 30, "impressions": 300, "average_position_milli": 30_000},
            ],
            {"m209_min_total_impressions": 100, "m209_max_weighted_average_position_milli": 20_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "IMPRESSION_WEIGHTED_SEARCH_POSITION_HIGH")
        self.assertEqual(result["output"]["weighted_average_position_milli"], 25_000)
        self.assertEqual(result["output"]["total_impressions"], 400)

    def test_m210_click_weighted_position_uses_only_observed_click_weight(self):
        result = run_m210(
            [
                {"query": "uno", "page_url": "/a", "clicks": 10, "impressions": 100, "average_position_milli": 10_000},
                {"query": "dos", "page_url": "/b", "clicks": 30, "impressions": 300, "average_position_milli": 30_000},
            ],
            {"m210_min_total_clicks": 10, "m210_max_weighted_average_position_milli": 20_000},
        )
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["reason_code"], "CLICK_WEIGHTED_SEARCH_POSITION_HIGH")
        self.assertEqual(result["output"]["weighted_average_position_milli"], 25_000)
        self.assertEqual(result["output"]["total_clicks"], 40)

    def test_m211_detects_low_query_breadth_on_material_page(self):
        result = run_m211(
            [
                {"query": "uno", "page_url": "/landing", "clicks": 2, "impressions": 100, "average_position_milli": 5_000},
                {"query": "dos", "page_url": "/landing", "clicks": 3, "impressions": 100, "average_position_milli": 6_000},
            ],
            {"m211_min_page_impressions": 100, "m211_min_distinct_queries": 3},
        )
        self.assertEqual(result["reason_code"], "SEARCH_PAGE_QUERY_BREADTH_LOW")
        finding = result["output"]["low_breadth_pages"][0]
        self.assertEqual(finding["page_url"], "/landing")
        self.assertEqual(finding["distinct_query_count"], 2)
        self.assertEqual(finding["queries"], ["dos", "uno"])

    def test_m212_measures_page_zero_click_impression_share(self):
        result = run_m212(
            [
                {"query": "sin clic", "page_url": "/a", "clicks": 0, "impressions": 80, "average_position_milli": 4_000},
                {"query": "con clic", "page_url": "/a", "clicks": 20, "impressions": 20, "average_position_milli": 3_000},
            ],
            {"m212_min_page_impressions": 100, "m212_max_zero_click_impression_share_ppm": 700_000},
        )
        self.assertEqual(result["reason_code"], "PAGE_ZERO_CLICK_EXPOSURE_SHARE_HIGH")
        finding = result["output"]["high_zero_click_pages"][0]
        self.assertEqual(finding["zero_click_impressions"], 80)
        self.assertEqual(finding["zero_click_impression_share_ppm"], 800_000)

    def test_m213_computes_impression_weighted_position_mad_without_float(self):
        result = run_m213(
            [
                {"query": "uno", "page_url": "/a", "clicks": 5, "impressions": 100, "average_position_milli": 10_000},
                {"query": "dos", "page_url": "/b", "clicks": 5, "impressions": 100, "average_position_milli": 30_000},
            ],
            {"m213_min_total_impressions": 100, "m213_max_weighted_position_mad_milli": 9_000},
        )
        self.assertEqual(result["reason_code"], "SEARCH_POSITION_DISPERSION_HIGH")
        self.assertEqual(result["output"]["weighted_average_position_milli"], 20_000)
        self.assertEqual(result["output"]["weighted_position_mad_milli"], 10_000)

    def test_m214_computes_equal_query_ctr_dispersion(self):
        result = run_m214(
            [
                {"query": "cero", "page_url": "/a", "clicks": 0, "impressions": 100, "average_position_milli": 10_000},
                {"query": "medio", "page_url": "/a", "clicks": 50, "impressions": 100, "average_position_milli": 10_000},
                {"query": "alto", "page_url": "/a", "clicks": 100, "impressions": 100, "average_position_milli": 10_000},
            ],
            {"m214_min_query_impressions": 100, "m214_min_queries": 3, "m214_max_query_ctr_mad_ppm": 300_000},
        )
        self.assertEqual(result["reason_code"], "SEARCH_QUERY_CTR_DISPERSION_HIGH")
        self.assertEqual(result["output"]["mean_query_ctr_ppm"], 500_000)
        self.assertEqual(result["output"]["query_ctr_mad_ppm"], 333_333)

    def test_each_module_fails_closed_on_conflicting_duplicate(self):
        records = [
            {"query": "uno", "page_url": "/a", "clicks": 1, "impressions": 100, "average_position_milli": 10_000},
            {"query": "uno", "page_url": "/a", "clicks": 2, "impressions": 100, "average_position_milli": 10_000},
        ]
        for module_id, handler, config, _, _ in self._module_audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, config)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["reason_code"], "DUPLICATE_SEARCH_OBSERVATION_CONFLICT")

    def test_each_module_fails_closed_on_invalid_record(self):
        records = self._audit_records() + [
            {"query": "malformado", "page_url": "/bad", "clicks": 2, "impressions": 1, "average_position_milli": 5_000},
        ]
        for module_id, handler, config, _, _ in self._module_audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, config)
                self.assertEqual(result["module"], module_id)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["finding_status"], "NOT_APPLICABLE")
                self.assertEqual(result["reason_code"], "INVALID_SEARCH_PERFORMANCE_RECORDS")
                self.assertEqual(result["output"]["invalid_records_count"], 1)

    def test_each_module_rejects_invalid_configuration(self):
        records = self._audit_records()
        for module_id, handler, _, _, invalid_config in self._module_audit_cases():
            with self.subTest(module=module_id):
                result = handler(records, invalid_config)
                self.assertEqual(result["module"], module_id)
                self.assertEqual(result["execution_status"], "ERROR")
                self.assertEqual(result["reason_code"], "INVALID_MODULE_CONFIG")

    def test_each_module_is_deterministic_and_config_hash_bound(self):
        records = self._audit_records()
        for module_id, handler, config, changed_config, _ in self._module_audit_cases():
            with self.subTest(module=module_id):
                first = handler(records, config)
                second = handler(records, config)
                changed = handler(records, changed_config)
                self.assertEqual(first, second)
                self.assertEqual(first["module"], module_id)
                self.assertIsNotNone(first["raw_input_hash"])
                self.assertIsNotNone(first["normalized_input_hash"])
                self.assertIsNotNone(first["module_config_hash"])
                self.assertIsNotNone(first["evidence_hash"])
                self.assertNotEqual(first["module_config_hash"], changed["module_config_hash"])

    def test_each_module_returns_insufficient_data_without_real_sample(self):
        for module_id, handler, config, _, _ in self._module_audit_cases():
            with self.subTest(module=module_id):
                result = handler([], config)
                self.assertEqual(result["module"], module_id)
                self.assertEqual(result["execution_status"], "INSUFFICIENT_DATA")
                self.assertEqual(result["finding_status"], "NOT_APPLICABLE")

    def test_policy_boundaries_do_not_create_false_findings(self):
        position_records = [
            {"query": "uno", "page_url": "/a", "clicks": 10, "impressions": 100, "average_position_milli": 10_000},
            {"query": "dos", "page_url": "/b", "clicks": 30, "impressions": 300, "average_position_milli": 30_000},
        ]
        self.assertEqual(
            run_m209(position_records, {
                "m209_min_total_impressions": 100,
                "m209_max_weighted_average_position_milli": 25_000,
            })["finding_status"],
            "NO_FINDING",
        )
        self.assertEqual(
            run_m210(position_records, {
                "m210_min_total_clicks": 10,
                "m210_max_weighted_average_position_milli": 25_000,
            })["finding_status"],
            "NO_FINDING",
        )

        breadth_records = [
            {"query": "uno", "page_url": "/landing", "clicks": 2, "impressions": 100, "average_position_milli": 5_000},
            {"query": "dos", "page_url": "/landing", "clicks": 3, "impressions": 100, "average_position_milli": 6_000},
        ]
        self.assertEqual(
            run_m211(breadth_records, {
                "m211_min_page_impressions": 100,
                "m211_min_distinct_queries": 2,
            })["finding_status"],
            "NO_FINDING",
        )

        zero_click_records = [
            {"query": "sin clic", "page_url": "/a", "clicks": 0, "impressions": 80, "average_position_milli": 4_000},
            {"query": "con clic", "page_url": "/a", "clicks": 20, "impressions": 20, "average_position_milli": 3_000},
        ]
        self.assertEqual(
            run_m212(zero_click_records, {
                "m212_min_page_impressions": 100,
                "m212_max_zero_click_impression_share_ppm": 800_000,
            })["finding_status"],
            "NO_FINDING",
        )

        dispersion_records = [
            {"query": "uno", "page_url": "/a", "clicks": 5, "impressions": 100, "average_position_milli": 10_000},
            {"query": "dos", "page_url": "/b", "clicks": 5, "impressions": 100, "average_position_milli": 30_000},
        ]
        self.assertEqual(
            run_m213(dispersion_records, {
                "m213_min_total_impressions": 100,
                "m213_max_weighted_position_mad_milli": 10_000,
            })["finding_status"],
            "NO_FINDING",
        )

        ctr_records = [
            {"query": "cero", "page_url": "/a", "clicks": 0, "impressions": 100, "average_position_milli": 10_000},
            {"query": "medio", "page_url": "/a", "clicks": 50, "impressions": 100, "average_position_milli": 10_000},
            {"query": "alto", "page_url": "/a", "clicks": 100, "impressions": 100, "average_position_milli": 10_000},
        ]
        self.assertEqual(
            run_m214(ctr_records, {
                "m214_min_query_impressions": 100,
                "m214_min_queries": 3,
                "m214_max_query_ctr_mad_ppm": 333_333,
            })["finding_status"],
            "NO_FINDING",
        )

    def test_new_search_batch_is_registered_executable_and_gateway_connected(self):
        registry = module_registry()
        required = {"M209", "M210", "M211", "M212", "M213", "M214"}
        self.assertTrue(required.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(required.issubset(set(PRE_GATE_MODULES)))
        for module_id in required:
            self.assertEqual(registry[module_id]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[module_id]["executable_here"])
        self.assertEqual(registry["M215"]["status"], "RESERVED")
        self.assertFalse(registry["M215"]["executable_here"])

        result = execute_avengers_1200({}, {"CONFIG_SEO_AVENGERS_1200": True})
        self.assertEqual(result["reserved_extended_modules"], 1000 - len(IMPLEMENTED_EXTENDED_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

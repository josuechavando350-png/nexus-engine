import copy
import unittest

from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_2000
from test_batch_1601_1800 import fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(1801, 2001))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required", "new_database_required", "new_queue_required",
    "new_secret_required", "new_cloud_resource_required", "new_daemon_required",
)


class Batch18012000Tests(unittest.TestCase):
    def test_fifth_slice_is_exact_unique_whitehat_and_source_bound(self):
        current = {mid: MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current), 200)
        self.assertEqual(len({spec["operation"] for spec in current.values()}), 200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}), 200)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(1801, 1891)}), 90)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(1901, 1991)}), 90)
        for number in range(1801, 2001):
            spec = current[f"M{number}"]
            self.assertEqual(spec["source_module"], f"M{number + 1000}")
            self.assertEqual(spec["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"], "OBSERVE_ONLY")

    def test_exact_1000_range_and_new_200_execute_successfully(self):
        payload, config = fixture()
        receipts = run_batch_1001_2000(payload, config)
        self.assertEqual(tuple(receipts), tuple(f"M{i}" for i in range(1001, 2001)))
        self.assertEqual(len(receipts), 1000)
        self.assertEqual({mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"] == "ERROR"}, {})
        current_non_success = {
            f"M{i}": receipts[f"M{i}"]["reason_code"]
            for i in range(1801, 2001)
            if receipts[f"M{i}"]["execution_status"] != "SUCCESS"
        }
        self.assertEqual(current_non_success, {})

    def test_fifth_batch_receipts_are_deterministic(self):
        payload, config = fixture()
        left = run_batch_1001_2000(payload, config)
        right = run_batch_1001_2000(copy.deepcopy(payload), copy.deepcopy(config))
        self.assertEqual({mid:left[mid] for mid in _CURRENT_MODULES}, {mid:right[mid] for mid in _CURRENT_MODULES})

    def test_demand_frontier_is_first_party_observational_and_non_forecasting(self):
        payload, config = fixture(); receipts = run_batch_1001_2000(payload, config)
        for number in range(1801, 1891):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            output = receipt["output"]
            self.assertTrue(output.get("observe_only"))
            self.assertTrue(output.get("no_google_scraping"))
            self.assertTrue(output.get("not_a_rank_forecast"))
            self.assertTrue(output.get("not_a_revenue_forecast"))
            self.assertTrue(output.get("not_an_indexation_guarantee"))
            self.assertEqual(output.get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")

    def test_counterfactual_is_simulation_only_not_link_scheme_or_pagerank(self):
        payload, config = fixture(); receipts = run_batch_1001_2000(payload, config)
        candidates = []
        for number in range(1901, 1991):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            output = receipt["output"]
            self.assertTrue(output.get("observe_only"))
            self.assertTrue(output.get("no_site_mutation"))
            self.assertTrue(output.get("no_external_link_creation"))
            self.assertTrue(output.get("no_link_scheme"))
            self.assertTrue(output.get("not_google_pagerank"))
            self.assertTrue(output.get("counterfactual_only"))
            self.assertEqual(output.get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
            if output.get("best_candidate") is not None:
                candidates.append(output.get("best_candidate"))
        self.assertTrue(candidates)

    def test_new_analytics_bind_zero_new_infrastructure_contract(self):
        payload, config = fixture(); receipts = run_batch_1001_2000(payload, config)
        for number in list(range(1801, 1891)) + list(range(1901, 1991)):
            receipt = receipts[f"M{number}"]
            contract = receipt["output"].get("runtime_contract")
            self.assertIsInstance(contract, dict)
            for field in _RUNTIME_FALSE_FIELDS:
                self.assertIs(contract.get(field), False)
        self.assertEqual(receipts["M1896"]["finding_status"], "NO_FINDING")
        self.assertEqual(receipts["M1996"]["finding_status"], "NO_FINDING")

    def test_tampered_frontier_receipt_is_rejected_by_hash_guard(self):
        payload, config = fixture(); receipts = run_batch_1001_2000(payload, config)
        context = {"M1800": receipts["M1800"]}
        for number in range(1801, 1891):
            context[f"M{number}"] = copy.deepcopy(receipts[f"M{number}"])
        context["M1801"]["output"]["score_ppm"] = 0
        result = execute_module("M1892", payload, config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertIn("M1801", result["output"]["invalid_receipt_modules"])

    def test_m1900_and_m2000_certify_exact_boundaries(self):
        payload, config = fixture(); receipts = run_batch_1001_2000(payload, config)
        for module_id, expected_end in (("M1900", "M1900"), ("M2000", "M2000")):
            terminal = receipts[module_id]
            self.assertEqual(terminal["execution_status"], "SUCCESS")
            self.assertEqual(terminal["finding_status"], "NO_FINDING")
            self.assertTrue(terminal["output"]["release_safe"])
            self.assertEqual(terminal["output"]["checked_receipt_count"], 10)
            self.assertEqual(terminal["output"]["certified_local_range"], ["M1001", expected_end])
            self.assertEqual(terminal["output"]["policy_status"], "STRICT_WHITE_HAT_ONLY")


if __name__ == "__main__": unittest.main()

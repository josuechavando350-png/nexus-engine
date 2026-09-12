import copy
import unittest

from runtime.catalog import module_registry
from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_2500, suite_state
from test_batch_2201_2400 import fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(2401, 2501))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required", "new_database_required", "new_queue_required",
    "new_secret_required", "new_cloud_resource_required", "new_daemon_required",
)

class Batch24012500Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload, cls.config = fixture()
        cls.receipts = run_batch_1001_2500(cls.payload, cls.config)

    def test_final_slice_is_exact_unique_whitehat_and_source_bound(self):
        current = {mid: MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current), 100)
        self.assertEqual(len({spec["operation"] for spec in current.values()}), 100)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}), 100)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(2401, 2491)}), 90)
        for number in range(2401, 2501):
            spec = current[f"M{number}"]
            self.assertEqual(spec["source_module"], f"M{number + 1000}")
            self.assertEqual(spec["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"], "OBSERVE_ONLY")

    def test_exact_final_local_range_and_registry_have_no_reserved_slots(self):
        self.assertEqual(tuple(self.receipts), tuple(f"M{i}" for i in range(1001, 2501)))
        self.assertEqual(len(self.receipts), 1500)
        registry = module_registry()
        self.assertEqual(tuple(registry), tuple(f"M{i}" for i in range(1, 2501)))
        self.assertNotIn("M2501", registry)
        for number in range(1, 1001):
            self.assertEqual(registry[f"M{number}"]["status"], "DELEGATED_PRODUCTION")
        for number in range(1001, 2501):
            self.assertEqual(registry[f"M{number}"]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[f"M{number}"]["executable_here"])
        self.assertEqual(suite_state()["reserved_not_executable_count"], 0)

    def test_compliance_kernel_is_clean_observational_and_zero_infrastructure(self):
        non_success = {}
        findings = {}
        for number in range(2401, 2491):
            receipt = self.receipts[f"M{number}"]
            if receipt["execution_status"] != "SUCCESS":
                non_success[f"M{number}"] = receipt["reason_code"]
            if receipt["finding_status"] != "NO_FINDING":
                findings[f"M{number}"] = receipt["reason_code"]
            output = receipt["output"]
            self.assertTrue(output.get("observe_only"))
            self.assertTrue(output.get("strict_white_hat_only"))
            self.assertTrue(output.get("no_google_scraping"))
            self.assertTrue(output.get("no_site_mutation"))
            self.assertTrue(output.get("no_page_generation"))
            self.assertTrue(output.get("no_external_link_creation"))
            self.assertTrue(output.get("no_fake_reviews"))
            self.assertTrue(output.get("no_fake_locations"))
            self.assertTrue(output.get("no_cloaking"))
            self.assertEqual(output.get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
            contract = output.get("runtime_contract")
            self.assertIsInstance(contract, dict)
            for field in _RUNTIME_FALSE_FIELDS:
                self.assertIs(contract.get(field), False)
        self.assertEqual(non_success, {})
        self.assertEqual(findings, {})

    def test_global_guards_pass_and_bind_whole_local_history(self):
        for number in range(2491, 2500):
            receipt = self.receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            self.assertEqual(receipt["finding_status"], "NO_FINDING")
            self.assertTrue(receipt["output"].get("global_composition_guard"))
            self.assertEqual(receipt["output"].get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
        self.assertEqual(self.receipts["M2491"]["output"]["checked_receipt_count"], 1490)
        self.assertEqual(self.receipts["M2492"]["output"]["checked_receipt_count"], 1490)
        self.assertEqual(self.receipts["M2496"]["output"]["checked_receipt_count"], 1490)

    def test_m2500_terminal_certifies_exact_composition_contract(self):
        terminal = self.receipts["M2500"]
        self.assertEqual(terminal["execution_status"], "SUCCESS")
        self.assertEqual(terminal["finding_status"], "NO_FINDING")
        output = terminal["output"]
        self.assertTrue(output["release_safe"])
        self.assertEqual(output["suite"], "SEO_AVENGERS_2500")
        self.assertEqual(output["certified_exact_range"], ["M1", "M2500"])
        self.assertEqual(output["delegated_production_range"], ["M1", "M1000"])
        self.assertEqual(output["local_implemented_range"], ["M1001", "M2500"])
        self.assertEqual(output["checked_prior_receipt_count"], 1499)
        self.assertEqual(output["global_guard_range"], ["M2491", "M2499"])
        self.assertEqual(output["blocking_findings"], [])
        self.assertTrue(all(output["composition_checks"].values()))
        self.assertTrue(output["not_a_rank_guarantee"])
        self.assertTrue(output["not_an_indexation_guarantee"])
        self.assertTrue(output["not_a_penalty_immunity_guarantee"])

    def test_global_hash_guard_rejects_tampering(self):
        context = {f"M{i}": copy.deepcopy(self.receipts[f"M{i}"]) for i in range(1001, 2491)}
        context["M1801"]["output"]["score_ppm"] = 0
        result = execute_module("M2492", self.payload, self.config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertIn("M1801", result["output"]["invalid_receipt_modules"])

    def test_terminal_rejects_tampered_guard_context(self):
        context = {f"M{i}": copy.deepcopy(self.receipts[f"M{i}"]) for i in range(1001, 2500)}
        context["M2492"]["output"]["checked_receipt_count"] = 1
        result = execute_module("M2500", self.payload, self.config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertFalse(result["output"]["release_safe"])
        self.assertTrue(result["output"]["blocking_findings"])

    def test_final_receipts_are_deterministic(self):
        second = run_batch_1001_2500(copy.deepcopy(self.payload), copy.deepcopy(self.config))
        self.assertEqual(
            {mid: self.receipts[mid] for mid in _CURRENT_MODULES},
            {mid: second[mid] for mid in _CURRENT_MODULES},
        )

if __name__ == "__main__":
    unittest.main()

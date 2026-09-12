import copy
import unittest

from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_2200
from test_batch_1601_1800 import fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(2001, 2201))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required", "new_database_required", "new_queue_required",
    "new_secret_required", "new_cloud_resource_required", "new_daemon_required",
)


class Batch20012200Tests(unittest.TestCase):
    def test_sixth_slice_is_exact_unique_whitehat_and_source_bound(self):
        current = {mid: MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current), 200)
        self.assertEqual(len({spec["operation"] for spec in current.values()}), 200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}), 200)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(2001, 2091)}), 90)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(2101, 2191)}), 90)
        for number in range(2001, 2201):
            spec = current[f"M{number}"]
            self.assertEqual(spec["source_module"], f"M{number + 1000}")
            self.assertEqual(spec["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"], "OBSERVE_ONLY")

    def test_exact_1200_range_and_new_200_execute_successfully(self):
        payload, config = fixture()
        receipts = run_batch_1001_2200(payload, config)
        self.assertEqual(tuple(receipts), tuple(f"M{i}" for i in range(1001, 2201)))
        self.assertEqual(len(receipts), 1200)
        self.assertEqual({mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"] == "ERROR"}, {})
        current_non_success = {
            f"M{i}": receipts[f"M{i}"]["reason_code"]
            for i in range(2001, 2201)
            if receipts[f"M{i}"]["execution_status"] != "SUCCESS"
        }
        self.assertEqual(current_non_success, {})

    def test_sixth_batch_receipts_are_deterministic(self):
        payload, config = fixture()
        left = run_batch_1001_2200(payload, config)
        right = run_batch_1001_2200(copy.deepcopy(payload), copy.deepcopy(config))
        self.assertEqual({mid:left[mid] for mid in _CURRENT_MODULES}, {mid:right[mid] for mid in _CURRENT_MODULES})

    def test_representation_mesh_is_proof_carrying_and_never_fabricates_schema(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        for number in range(2001, 2091):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            output = receipt["output"]
            self.assertTrue(output.get("observe_only"))
            self.assertTrue(output.get("proof_carrying"))
            self.assertTrue(output.get("no_google_scraping"))
            self.assertTrue(output.get("no_schema_fabrication"))
            self.assertTrue(output.get("no_rich_result_guarantee"))
            self.assertTrue(output.get("no_rank_guarantee"))
            self.assertTrue(output.get("no_site_mutation"))
            self.assertEqual(output.get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
        self.assertGreater(receipts["M2001"]["output"]["score_ppm"], 0)

    def test_entity_graph_is_local_evidence_graph_not_google_private_graph(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        for number in range(2101, 2191):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            output = receipt["output"]
            self.assertTrue(output.get("observe_only"))
            self.assertTrue(output.get("proof_carrying"))
            self.assertTrue(output.get("no_entity_fabrication"))
            self.assertTrue(output.get("no_location_fabrication"))
            self.assertTrue(output.get("no_service_fabrication"))
            self.assertTrue(output.get("no_review_fabrication"))
            self.assertTrue(output.get("not_google_knowledge_graph"))
            self.assertTrue(output.get("not_google_pagerank"))
            self.assertEqual(output.get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
        self.assertEqual(receipts["M2101"]["output"].get("entity_count"), 4)
        self.assertGreater(receipts["M2102"]["output"].get("relation_edges", 0), 0)

    def test_new_analytics_bind_zero_new_infrastructure_contract(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        for number in list(range(2001, 2091)) + list(range(2101, 2191)):
            contract = receipts[f"M{number}"]["output"].get("runtime_contract")
            self.assertIsInstance(contract, dict)
            for field in _RUNTIME_FALSE_FIELDS:
                self.assertIs(contract.get(field), False)
        self.assertEqual(receipts["M2096"]["finding_status"], "NO_FINDING")
        self.assertEqual(receipts["M2196"]["finding_status"], "NO_FINDING")

    def test_tampered_representation_receipt_is_rejected_by_hash_guard(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        context = {"M2000": receipts["M2000"]}
        for number in range(2001, 2091):
            context[f"M{number}"] = copy.deepcopy(receipts[f"M{number}"])
        context["M2001"]["output"]["score_ppm"] = 0
        result = execute_module("M2092", payload, config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertIn("M2001", result["output"]["invalid_receipt_modules"])

    def test_tampered_entity_graph_receipt_is_rejected_by_hash_guard(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        context = {"M2100": receipts["M2100"]}
        for number in range(2101, 2191):
            context[f"M{number}"] = copy.deepcopy(receipts[f"M{number}"])
        context["M2101"]["output"]["entity_count"] = 999
        result = execute_module("M2192", payload, config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertIn("M2101", result["output"]["invalid_receipt_modules"])

    def test_m2100_and_m2200_certify_exact_boundaries(self):
        payload, config = fixture(); receipts = run_batch_1001_2200(payload, config)
        for module_id, expected_end in (("M2100", "M2100"), ("M2200", "M2200")):
            terminal = receipts[module_id]
            self.assertEqual(terminal["execution_status"], "SUCCESS")
            self.assertEqual(terminal["finding_status"], "NO_FINDING")
            self.assertTrue(terminal["output"]["release_safe"])
            self.assertEqual(terminal["output"]["checked_receipt_count"], 10)
            self.assertEqual(terminal["output"]["certified_local_range"], ["M1001", expected_end])
            self.assertEqual(terminal["output"]["policy_status"], "STRICT_WHITE_HAT_ONLY")


if __name__ == "__main__": unittest.main()

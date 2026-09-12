import copy
import unittest

from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_1600
from test_batch_1201_1400 import fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(1401, 1601))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required",
    "new_database_required",
    "new_queue_required",
    "new_secret_required",
    "new_cloud_resource_required",
    "new_daemon_required",
)

class Batch14011600Tests(unittest.TestCase):
    def test_third_slice_is_exact_unique_whitehat_and_source_bound(self):
        current={mid:MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current),200)
        self.assertEqual(len({spec["operation"] for spec in current.values()}),200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}),200)
        for number in range(1401,1601):
            module_id=f"M{number}"
            spec=current[module_id]
            self.assertEqual(spec["source_module"],f"M{number+1000}")
            self.assertEqual(spec["policy_status"],"SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"],"OBSERVE_ONLY")

    def test_exact_600_local_modules_execute_without_error_on_complete_evidence(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        self.assertEqual(tuple(receipts),tuple(f"M{i}" for i in range(1001,1601)))
        self.assertEqual(len(receipts),600)
        errors={mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"]=="ERROR"}
        self.assertEqual(errors,{})

    def test_third_batch_receipts_are_deterministic(self):
        payload,config=fixture()
        left=run_batch_1001_1600(payload,config)
        right=run_batch_1001_1600(copy.deepcopy(payload),copy.deepcopy(config))
        self.assertEqual(
            {mid:left[mid] for mid in _CURRENT_MODULES},
            {mid:right[mid] for mid in _CURRENT_MODULES},
        )

    def test_authority_graph_is_observational_not_pagerank_or_rank_guarantee(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        authority=[receipts[f"M{i}"] for i in range(1401,1501)]
        self.assertEqual(len(authority),100)
        self.assertTrue(any("component" in receipt["operation"] for receipt in authority))
        self.assertTrue(any("service_location_cell" in receipt["operation"] for receipt in authority))
        for receipt in authority:
            text=str(receipt).casefold()
            self.assertNotIn("pagerank",text)
            self.assertNotIn("guaranteed_rank",text)
            self.assertEqual(receipt["action_mode"],"OBSERVE_ONLY")

    def test_conversion_priority_modules_are_explicitly_not_forecasts(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        priorities=[]
        for number in range(1501,1591):
            receipt=receipts[f"M{number}"]
            operation=receipt["operation"]
            if any(token in operation for token in (
                "lead_priority", "close_priority", "conversion_priority",
                "zero_click_lead_priority", "rank_gap_lead_priority", "content_gap_lead_priority",
            )):
                priorities.append(receipt)
        self.assertTrue(priorities)
        for receipt in priorities:
            self.assertEqual(receipt["execution_status"],"SUCCESS")
            self.assertTrue(receipt["output"].get("not_a_revenue_forecast"))
            self.assertNotIn("predicted_clients",receipt["output"])
            self.assertNotIn("predicted_revenue",receipt["output"])

    def test_every_current_success_receipt_binds_zero_new_infrastructure_contract(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        for number in range(1401,1591):
            receipt=receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"],"SUCCESS")
            contract=receipt["output"].get("runtime_contract")
            self.assertIsInstance(contract,dict)
            for field in _RUNTIME_FALSE_FIELDS:
                self.assertIs(contract.get(field),False)
        self.assertEqual(receipts["M1597"]["finding_status"],"NO_FINDING")

    def test_tampered_current_receipt_is_rejected_by_hash_guard(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        guard_context={"M1400":receipts["M1400"]}
        for number in range(1401,1591):
            guard_context[f"M{number}"]=copy.deepcopy(receipts[f"M{number}"])
        guard_context["M1401"]["output"]["score_ppm"]=0
        result=execute_module("M1592",payload,config,prior_receipts=guard_context)
        self.assertEqual(result["execution_status"],"SUCCESS")
        self.assertEqual(result["finding_status"],"FINDING")
        self.assertIn("M1401",result["output"]["invalid_receipt_modules"])

    def test_m1600_certifies_exact_predecessor_and_nine_guards(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        terminal=receipts["M1600"]
        self.assertEqual(receipts["M1400"]["execution_status"],"SUCCESS")
        self.assertEqual(receipts["M1400"]["finding_status"],"NO_FINDING")
        self.assertEqual(terminal["execution_status"],"SUCCESS")
        self.assertEqual(terminal["finding_status"],"NO_FINDING")
        self.assertTrue(terminal["output"]["release_safe"])
        self.assertEqual(terminal["output"]["checked_receipt_count"],10)
        self.assertEqual(terminal["output"]["certified_local_range"],["M1001","M1600"])

    def test_tampered_m1400_blocks_m1600(self):
        payload,config=fixture(); receipts=run_batch_1001_1600(payload,config)
        gate_context={"M1400":copy.deepcopy(receipts["M1400"])}
        gate_context["M1400"]["output"]["release_safe"]=False
        for number in range(1591,1600):
            gate_context[f"M{number}"]=receipts[f"M{number}"]
        terminal=execute_module("M1600",payload,config,prior_receipts=gate_context)
        self.assertEqual(terminal["execution_status"],"SUCCESS")
        self.assertEqual(terminal["finding_status"],"FINDING")
        self.assertFalse(terminal["output"]["release_safe"])

if __name__=="__main__": unittest.main()

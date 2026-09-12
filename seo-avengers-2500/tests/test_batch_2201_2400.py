import copy
import unittest

from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_2400
from test_batch_1601_1800 import fixture as base_fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(2201, 2401))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required", "new_database_required", "new_queue_required",
    "new_secret_required", "new_cloud_resource_required", "new_daemon_required",
)


def fixture():
    payload, config = base_fixture()
    payload["keyword_coverage_records"] = [
        {"keyword":"abogado penal cdmx","site_ranked":True,"competitor_ranked_count":4,"search_volume":1200},
        {"keyword":"defensa penal cdmx","site_ranked":True,"competitor_ranked_count":5,"search_volume":900},
        {"keyword":"abogado fraude cdmx","site_ranked":True,"competitor_ranked_count":3,"search_volume":650},
        {"keyword":"audiencia inicial abogado cdmx","site_ranked":True,"competitor_ranked_count":2,"search_volume":500},
        {"keyword":"defensa penal urgente cdmx","site_ranked":True,"competitor_ranked_count":2,"search_volume":420},
        {"keyword":"consulta abogado penal cdmx","site_ranked":True,"competitor_ranked_count":3,"search_volume":380},
        {"keyword":"que hacer audiencia inicial cdmx","site_ranked":True,"competitor_ranked_count":1,"search_volume":240},
        {"keyword":"abogado penal ciudad de mexico","site_ranked":True,"competitor_ranked_count":4,"search_volume":700},
        {"keyword":"defensa fraude urgente cdmx","site_ranked":False,"competitor_ranked_count":2,"search_volume":260},
        {"keyword":"consulta audiencia inicial ciudad de mexico","site_ranked":False,"competitor_ranked_count":1,"search_volume":180},
        {"keyword":"cano estrategia penal","site_ranked":True,"competitor_ranked_count":1,"search_volume":300},
        {"keyword":"abogado penal cerca de mi","site_ranked":True,"competitor_ranked_count":4,"search_volume":550},
    ]
    payload["traffic_window_records"] = [
        {"entity_id":"/penal-cdmx","baseline_visits":1000,"current_visits":920,"baseline_window_days":28,"current_window_days":28},
        {"entity_id":"/fraude-cdmx","baseline_visits":600,"current_visits":660,"baseline_window_days":28,"current_window_days":28},
        {"entity_id":"/audiencia-inicial-cdmx","baseline_visits":420,"current_visits":390,"baseline_window_days":28,"current_window_days":28},
        {"entity_id":"/contacto","baseline_visits":300,"current_visits":330,"baseline_window_days":28,"current_window_days":28},
    ]
    payload["traffic_series_records"] = [
        {"entity_id":"/penal-cdmx","visits_series":[72,75,74,78,80,77,79,82,80,83,84,86]},
        {"entity_id":"/fraude-cdmx","visits_series":[38,40,42,41,44,46,45,47,49,50,52,54]},
        {"entity_id":"/audiencia-inicial-cdmx","visits_series":[35,34,36,33,32,34,35,36,35,37,38,39]},
        {"entity_id":"/contacto","visits_series":[20,22,21,24,25,23,26,27,28,29,30,31]},
    ]
    payload["content_decay_records"] = [
        {"document_id":"/penal-cdmx","baseline_clicks":100,"current_clicks":82,"baseline_impressions":1000,"current_impressions":900,"baseline_window_days":28,"current_window_days":28},
        {"document_id":"/fraude-cdmx","baseline_clicks":55,"current_clicks":60,"baseline_impressions":650,"current_impressions":710,"baseline_window_days":28,"current_window_days":28},
        {"document_id":"/audiencia-inicial-cdmx","baseline_clicks":45,"current_clicks":39,"baseline_impressions":500,"current_impressions":470,"baseline_window_days":28,"current_window_days":28},
        {"document_id":"/contacto","baseline_clicks":30,"current_clicks":34,"baseline_impressions":300,"current_impressions":320,"baseline_window_days":28,"current_window_days":28},
    ]
    return payload, config


class Batch22012400Tests(unittest.TestCase):
    def test_seventh_slice_is_exact_unique_whitehat_and_source_bound(self):
        current={mid:MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current),200)
        self.assertEqual(len({spec["operation"] for spec in current.values()}),200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}),200)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(2201,2291)}),90)
        self.assertEqual(len({MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(2301,2391)}),90)
        for number in range(2201,2401):
            spec=current[f"M{number}"]
            self.assertEqual(spec["source_module"],f"M{number+1000}")
            self.assertEqual(spec["policy_status"],"SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"],"OBSERVE_ONLY")

    def test_exact_1400_range_and_new_200_execute_successfully(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        self.assertEqual(tuple(receipts),tuple(f"M{i}" for i in range(1001,2401)))
        self.assertEqual(len(receipts),1400)
        self.assertEqual({mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"]=="ERROR"},{})
        current_non_success={f"M{i}":receipts[f"M{i}"]["reason_code"] for i in range(2201,2401) if receipts[f"M{i}"]["execution_status"]!="SUCCESS"}
        self.assertEqual(current_non_success,{})

    def test_seventh_batch_receipts_are_deterministic(self):
        payload,config=fixture(); left=run_batch_1001_2400(payload,config); right=run_batch_1001_2400(copy.deepcopy(payload),copy.deepcopy(config))
        self.assertEqual({mid:left[mid] for mid in _CURRENT_MODULES},{mid:right[mid] for mid in _CURRENT_MODULES})

    def test_traffic_portfolio_is_observational_and_not_a_forecast(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        for number in range(2201,2291):
            output=receipts[f"M{number}"]["output"]
            self.assertTrue(output.get("observe_only")); self.assertTrue(output.get("portfolio_optimization_only"))
            self.assertTrue(output.get("no_google_scraping")); self.assertTrue(output.get("no_page_generation")); self.assertTrue(output.get("no_site_mutation"))
            self.assertTrue(output.get("not_a_rank_forecast")); self.assertTrue(output.get("not_a_revenue_forecast")); self.assertTrue(output.get("not_an_indexation_guarantee"))
            self.assertEqual(output.get("evidence_contract"),"EXISTING_NEXUS_RECORDS_ONLY")

    def test_temporal_observatory_is_not_causal_proof_or_prediction(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        for number in range(2301,2391):
            output=receipts[f"M{number}"]["output"]
            self.assertTrue(output.get("observe_only")); self.assertTrue(output.get("temporal_observation_only")); self.assertTrue(output.get("not_causal_proof"))
            self.assertTrue(output.get("no_google_scraping")); self.assertTrue(output.get("no_site_mutation"))
            self.assertTrue(output.get("not_a_rank_forecast")); self.assertTrue(output.get("not_a_revenue_forecast")); self.assertTrue(output.get("not_an_indexation_guarantee"))
            self.assertEqual(output.get("evidence_contract"),"EXISTING_NEXUS_RECORDS_ONLY")

    def test_new_analytics_bind_zero_new_infrastructure_contract(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        for number in list(range(2201,2291))+list(range(2301,2391)):
            contract=receipts[f"M{number}"]["output"].get("runtime_contract"); self.assertIsInstance(contract,dict)
            for field in _RUNTIME_FALSE_FIELDS:self.assertIs(contract.get(field),False)
        self.assertEqual(receipts["M2296"]["finding_status"],"NO_FINDING")
        self.assertEqual(receipts["M2396"]["finding_status"],"NO_FINDING")

    def test_tampered_portfolio_receipt_is_rejected_by_hash_guard(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        context={"M2200":receipts["M2200"]}
        for number in range(2201,2291):context[f"M{number}"]=copy.deepcopy(receipts[f"M{number}"])
        context["M2201"]["output"]["score_ppm"]=0
        result=execute_module("M2292",payload,config,prior_receipts=context)
        self.assertEqual(result["finding_status"],"FINDING"); self.assertIn("M2201",result["output"]["invalid_receipt_modules"])

    def test_tampered_temporal_receipt_is_rejected_by_hash_guard(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        context={"M2300":receipts["M2300"]}
        for number in range(2301,2391):context[f"M{number}"]=copy.deepcopy(receipts[f"M{number}"])
        context["M2301"]["output"]["records"]=999
        result=execute_module("M2392",payload,config,prior_receipts=context)
        self.assertEqual(result["finding_status"],"FINDING"); self.assertIn("M2301",result["output"]["invalid_receipt_modules"])

    def test_m2300_and_m2400_certify_exact_boundaries(self):
        payload,config=fixture(); receipts=run_batch_1001_2400(payload,config)
        for module_id,expected_end in (("M2300","M2300"),("M2400","M2400")):
            terminal=receipts[module_id]
            self.assertEqual(terminal["execution_status"],"SUCCESS"); self.assertEqual(terminal["finding_status"],"NO_FINDING")
            self.assertTrue(terminal["output"]["release_safe"]); self.assertEqual(terminal["output"]["checked_receipt_count"],10)
            self.assertEqual(terminal["output"]["certified_local_range"],["M1001",expected_end]); self.assertEqual(terminal["output"]["policy_status"],"STRICT_WHITE_HAT_ONLY")


if __name__=="__main__":unittest.main()

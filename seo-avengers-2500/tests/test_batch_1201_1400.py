import copy
import unittest

from runtime.common import make_receipt
from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.runner import run_batch_1001_1400
from runtime.specs_indexation import PROOF_OPERATIONS

def upstream_proofs():
    rows=[]
    for index,(operation,_) in enumerate(PROOF_OPERATIONS, start=1):
        rows.append(make_receipt(
            module_id=f"U{index:03d}", source_module=f"S{index:03d}", operation=operation,
            family="UPSTREAM_VERIFIED_FIXTURE", raw_input={"fixture":index}, normalized_input={"fixture":index},
            module_config={"fixture":index}, execution_status="SUCCESS", finding_status="NO_FINDING",
            reason_code="VERIFIED_FIXTURE_PASS", output={"score_ppm":1_000_000,"violation":False},
        ))
    return rows

def fixture():
    identity="CANO Estrategia Penal Av Reforma 100 CDMX 525512345678"
    docs=[]
    for slug,theme in (("/penal-cdmx","penal defensa"),("/fraude-cdmx","fraude defensa"),("/audiencia-inicial-cdmx","audiencia inicial"),("/contacto","consulta contacto")):
        unique=" ".join(f"{slug.strip('/').replace('-','')}concept{i}" for i in range(280))
        docs.append({"document_id":slug,"text":f"{identity} abogado {theme} ciudad de mexico consulta estrategia derechos proceso pruebas {unique}"})
    queries=[
        ("abogado cdmx","/penal-cdmx",2,90,6000),
        ("abogado penal cdmx","/penal-cdmx",8,300,4500),
        ("defensa penal urgente cdmx","/penal-cdmx",1,140,9000),
        ("necesito abogado defensa penal urgente en cdmx ahora","/penal-cdmx",0,80,12000),
        ("abogado fraude cdmx","/fraude-cdmx",2,220,12500),
        ("fraude abogado ciudad de mexico","/fraude-cdmx",0,120,16000),
        ("audiencia inicial abogado cdmx","/audiencia-inicial-cdmx",3,160,8000),
        ("que hacer audiencia inicial cdmx","/audiencia-inicial-cdmx",1,90,11000),
        ("abogado penal cerca de mi","/penal-cdmx",1,100,9500),
        ("cano estrategia penal","/contacto",20,200,1500),
        ("consulta abogado penal","/contacto",2,80,6000),
        ("defensa penal cdmx","/fraude-cdmx",1,70,13000),
        ("defensa penal cdmx","/penal-cdmx",4,160,7500),
    ]
    payload={
        "search_performance_records":[{"query":q,"page_url":p,"clicks":c,"impressions":i,"average_position_milli":pos} for q,p,c,i,pos in queries],
        "content_documents":docs,
        "local_business_records":[
            {"source_id":"gbp","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432600,"longitude_e6":-99133200},
            {"source_id":"site","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432610,"longitude_e6":-99133210},
            {"source_id":"directory","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432590,"longitude_e6":-99133190},
        ],
        "content_decay_records":[{"document_id":"/penal-cdmx","baseline_clicks":100,"current_clicks":70,"baseline_impressions":1000,"current_impressions":800,"baseline_window_days":28,"current_window_days":28}],
        "revenue_funnel_records":[{"source_id":"organic","sessions":1000,"lead_conversion_ppm":100_000,"close_rate_ppm":200_000,"average_ticket_micros":5_000_000}],
        "upstream_evidence":upstream_proofs(),
    }
    config={
        "local_commercial_terms":["abogado","consulta","defensa"],"local_service_terms":["penal","fraude","audiencia inicial"],
        "local_location_terms":["cdmx","ciudad de mexico"],"local_urgency_terms":["urgente","inmediata"],
        "local_question_terms":["que hacer","como","cuando"],"local_brand_terms":["cano estrategia penal"],
        "local_verified_service_terms":["penal","fraude","audiencia inicial"],"local_verified_location_terms":["cdmx","ciudad de mexico"],
        "local_service_groups":{"penal":["penal","defensa penal"],"fraude":["fraude"],"audiencia":["audiencia inicial"]},
        "local_location_groups":{"cdmx":["cdmx","ciudad de mexico"],"near_me":["cerca de mi"]},
        "organic_funnel_source_ids":["organic"],
    }
    return payload,config

class Batch12011400Tests(unittest.TestCase):
    def test_second_slice_is_exact_and_unique(self):
        second={f"M{i}":MODULE_SPECS[f"M{i}"] for i in range(1201,1401)}
        self.assertEqual(len(second),200)
        self.assertEqual(len({s["operation"] for s in second.values()}),200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in second}),200)
        self.assertEqual([second[f"M{i}"]["source_module"] for i in range(1201,1401)],[f"M{i+1000}" for i in range(1201,1401)])

    def test_exact_400_local_modules_execute_without_error_on_complete_evidence(self):
        payload,config=fixture(); receipts=run_batch_1001_1400(payload,config)
        self.assertEqual(tuple(receipts),tuple(f"M{i}" for i in range(1001,1401)))
        self.assertEqual(len(receipts),400)
        errors={mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"]=="ERROR"}
        self.assertEqual(errors,{})

    def test_second_batch_receipts_are_deterministic(self):
        payload,config=fixture(); left=run_batch_1001_1400(payload,config); right=run_batch_1001_1400(copy.deepcopy(payload),copy.deepcopy(config))
        self.assertEqual({mid:left[mid] for mid in [f"M{i}" for i in range(1201,1401)]},{mid:right[mid] for mid in [f"M{i}" for i in range(1201,1401)]})

    def test_economic_priority_is_explicitly_not_a_revenue_forecast(self):
        payload,config=fixture(); receipts=run_batch_1001_1400(payload,config)
        economic=[r for mid,r in receipts.items() if 1271 <= int(mid[1:]) <= 1290]
        self.assertTrue(economic)
        for receipt in economic:
            self.assertTrue(receipt["output"].get("not_a_revenue_forecast"))

    def test_search_unobserved_semantics_never_claim_unindexed(self):
        payload,config=fixture(); receipts=run_batch_1001_1400(payload,config)
        for module_id in ("M1299","M1300"):
            output=receipts[module_id]["output"]
            text=str(output).casefold()
            self.assertNotIn("'unindexed'",text)
            self.assertNotIn("is_indexed",text)

    def test_corrupt_upstream_proof_fails_closed(self):
        payload,config=fixture(); payload["upstream_evidence"][0]["output"]["score_ppm"]=0
        receipts=run_batch_1001_1400(payload,config)
        self.assertEqual(receipts["M1301"]["execution_status"],"ERROR")
        self.assertEqual(receipts["M1391"]["finding_status"],"FINDING")
        self.assertEqual(receipts["M1400"]["finding_status"],"FINDING")
        self.assertFalse(receipts["M1400"]["output"]["release_safe"])

    def test_clean_proofs_and_whitehat_predecessor_certify_M1400(self):
        payload,config=fixture(); receipts=run_batch_1001_1400(payload,config)
        self.assertEqual(receipts["M1200"]["execution_status"],"SUCCESS")
        self.assertEqual(receipts["M1200"]["finding_status"],"NO_FINDING")
        self.assertTrue(receipts["M1200"]["output"]["release_safe"])
        self.assertEqual(receipts["M1400"]["execution_status"],"SUCCESS")
        self.assertEqual(receipts["M1400"]["finding_status"],"NO_FINDING")
        self.assertTrue(receipts["M1400"]["output"]["release_safe"])
        self.assertEqual(receipts["M1400"]["output"]["checked_receipt_count"],10)

if __name__=="__main__": unittest.main()

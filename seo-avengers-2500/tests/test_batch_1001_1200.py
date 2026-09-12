import ast
import copy
import pathlib
import unittest

from runtime.catalog import module_registry
from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.runner import run_batch_1001_1200

def fixture():
    base=("Cano Estrategia Penal abogado penal defensa penal Ciudad de Mexico CDMX consulta legal audiencia investigacion "
          "CANO Estrategia Penal Av Reforma 100 CDMX 525512345678 derechos pruebas estrategia cliente proceso justicia ")
    docs=[
        {"document_id":"/penal-cdmx","text":base+" "+" ".join(f"penalconcept{i}" for i in range(120))},
        {"document_id":"/fraude-cdmx","text":base+" fraude "+" ".join(f"fraudeconcept{i}" for i in range(120))},
        {"document_id":"/audiencia-inicial-cdmx","text":base+" audiencia inicial "+" ".join(f"audienciaconcept{i}" for i in range(120))},
        {"document_id":"/contacto","text":base+" contacto whatsapp llamada "+" ".join(f"contactconcept{i}" for i in range(120))},
    ]
    queries=[
        ("abogado penal cdmx","/penal-cdmx",8,300,4500),("abogado penal ciudad de mexico","/penal-cdmx",4,180,7000),
        ("defensa penal urgente cdmx","/penal-cdmx",1,140,9000),("abogado fraude cdmx","/fraude-cdmx",2,220,12500),
        ("fraude abogado ciudad de mexico","/fraude-cdmx",0,120,16000),("audiencia inicial abogado cdmx","/audiencia-inicial-cdmx",3,160,8000),
        ("que hacer audiencia inicial cdmx","/audiencia-inicial-cdmx",1,90,11000),("abogado penal cerca de mi","/penal-cdmx",1,100,9500),
        ("cano estrategia penal","/contacto",20,200,1500),("consulta abogado penal","/contacto",2,80,6000),
        ("defensa penal cdmx","/fraude-cdmx",1,70,13000),("defensa penal cdmx","/penal-cdmx",4,160,7500),
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
        "upstream_evidence":[],
    }
    config={
        "local_commercial_terms":["abogado","consulta","defensa"],"local_service_terms":["penal","fraude","audiencia inicial"],
        "local_location_terms":["cdmx","ciudad de mexico"],"local_urgency_terms":["urgente","inmediata"],
        "local_question_terms":["que hacer","como","cuando"],"local_brand_terms":["cano estrategia penal"],
        "local_verified_service_terms":["penal","fraude","audiencia inicial"],"local_verified_location_terms":["cdmx","ciudad de mexico"],
        "local_service_groups":{"penal":["penal","defensa penal"],"fraude":["fraude"],"audiencia":["audiencia inicial"]},
        "local_location_groups":{"cdmx":["cdmx","ciudad de mexico"],"near_me":["cerca de mi"]},
    }
    return payload,config

class Batch10011200Tests(unittest.TestCase):
    def test_first_slice_remains_exact_inside_expanded_manifest(self):
        first={f"M{i}":MODULE_SPECS[f"M{i}"] for i in range(1001,1201)}
        self.assertEqual(len(first),200)
        self.assertEqual(len({s["operation"] for s in first.values()}),200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in first}),200)
        for i in range(1001,1201): self.assertEqual(first[f"M{i}"]["source_module"],f"M{i+1000}")

    def test_first_200_execute_without_error(self):
        payload,config=fixture(); receipts=run_batch_1001_1200(payload,config)
        self.assertEqual(len(receipts),200)
        self.assertEqual({mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"]=="ERROR"},{})

    def test_deterministic_receipts(self):
        payload,config=fixture()
        self.assertEqual(run_batch_1001_1200(payload,config),run_batch_1001_1200(copy.deepcopy(payload),copy.deepcopy(config)))

    def test_registry_marks_only_reviewed_range_executable(self):
        registry=module_registry(); self.assertEqual(len(registry),2500); self.assertNotIn("M2501",registry)
        for i in range(1001,2401): self.assertEqual(registry[f"M{i}"]["status"],"IMPLEMENTED_PRODUCTION")
        for i in range(2401,2501): self.assertEqual(registry[f"M{i}"]["status"],"RESERVED_NOT_EXECUTABLE")

    def test_no_float_literals_or_network_imports(self):
        root=pathlib.Path(__file__).resolve().parents[1]/"runtime"; banned={"requests","httpx","aiohttp","urllib.request","socket"}
        for path in root.glob("*.py"):
            tree=ast.parse(path.read_text(encoding="utf-8"),filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node,ast.Constant) and isinstance(node.value,float): self.fail(f"float literal:{path}:{node.lineno}")
                if isinstance(node,ast.Import):
                    for name in node.names: self.assertNotIn(name.name,banned)
                if isinstance(node,ast.ImportFrom): self.assertNotIn(node.module,banned)

if __name__=="__main__": unittest.main()

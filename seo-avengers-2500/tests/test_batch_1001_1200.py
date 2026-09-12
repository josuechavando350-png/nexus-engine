import ast
import copy
import pathlib
import unittest

from runtime.catalog import module_registry
from runtime.manifest import FINGERPRINTS, MODULE_SPECS, TARGET_MODULES
from runtime.runner import run_batch_1001_1200

def fixture():
    repeated_a = (
        "Cano Estrategia Penal abogado penal defensa penal Ciudad de Mexico CDMX "
        "atencion urgente consulta legal defensa en audiencia investigacion carpeta penal "
        "CANO Estrategia Penal Av Reforma 100 CDMX 525512345678 "
    )
    repeated_b = (
        "Cano Estrategia Penal defensa penal fraude abogado penal CDMX Ciudad de Mexico "
        "consulta inmediata estrategia juridica proceso penal audiencia inicial "
        "CANO Estrategia Penal Av Reforma 100 CDMX 525512345678 "
    )
    docs = [
        {"document_id": "/penal-cdmx", "text": (repeated_a + " evidencia experiencia derechos etapas fiscales ministerio publico ")*5},
        {"document_id": "/fraude-cdmx", "text": (repeated_b + " fraude patrimonial defensa investigacion pruebas asesoria ")*5},
        {"document_id": "/audiencia-inicial-cdmx", "text": (repeated_a + " audiencia inicial juez medidas cautelares defensa tecnica ")*5},
        {"document_id": "/contacto", "text": (repeated_b + " contacto whatsapp llamada consulta ubicacion oficina ")*4},
    ]
    queries = [
        ("abogado penal cdmx","/penal-cdmx",8,300,4500),
        ("abogado penal ciudad de mexico","/penal-cdmx",4,180,7000),
        ("defensa penal urgente cdmx","/penal-cdmx",1,140,9000),
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
    search = [
        {"query": q, "page_url": p, "clicks": c, "impressions": i, "average_position_milli": pos}
        for q,p,c,i,pos in queries
    ]
    local = [
        {"source_id":"gbp","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432600,"longitude_e6":-99133200},
        {"source_id":"site","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432610,"longitude_e6":-99133210},
        {"source_id":"directory","name":"CANO Estrategia Penal","address":"Av Reforma 100 CDMX","phone":"+52 55 1234 5678","latitude_e6":19432590,"longitude_e6":-99133190},
    ]
    payload = {
        "search_performance_records": search,
        "content_documents": docs,
        "local_business_records": local,
        "content_decay_records": [
            {"document_id":"/penal-cdmx","baseline_clicks":100,"current_clicks":70,"baseline_impressions":1000,"current_impressions":800,"baseline_window_days":28,"current_window_days":28}
        ],
        "upstream_evidence": [
            {"module":"M400","policy_status":"SAFE_WHITE_HAT","finding_status":"NO_FINDING","reason_code":"POLICY_SATISFIED"}
        ],
    }
    config = {
        "local_commercial_terms":["abogado","consulta","defensa"],
        "local_service_terms":["penal","fraude","audiencia inicial"],
        "local_location_terms":["cdmx","ciudad de mexico"],
        "local_urgency_terms":["urgente","inmediata"],
        "local_question_terms":["que hacer","como","cuando"],
        "local_brand_terms":["cano estrategia penal"],
        "local_verified_service_terms":["penal","fraude","audiencia inicial"],
        "local_verified_location_terms":["cdmx","ciudad de mexico"],
        "local_service_groups":{
            "penal":["penal","defensa penal"],
            "fraude":["fraude"],
            "audiencia":["audiencia inicial"],
        },
        "local_location_groups":{
            "cdmx":["cdmx","ciudad de mexico"],
            "near_me":["cerca de mi"],
        },
    }
    return payload, config

class Avengers2500Batch10011200Tests(unittest.TestCase):
    def test_exact_batch_manifest_and_fingerprints(self):
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(1001,1201)))
        self.assertEqual(len(MODULE_SPECS), 200)
        self.assertEqual(len(set(FINGERPRINTS.values())), 200)
        self.assertEqual(len({spec["operation"] for spec in MODULE_SPECS.values()}), 200)
        self.assertGreaterEqual(len({spec["kernel"] for spec in MODULE_SPECS.values()}), 40)
        for i in range(1001,1201):
            spec = MODULE_SPECS[f"M{i}"]
            self.assertEqual(spec["source_module"], f"M{i+1000}")
            self.assertEqual(spec["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"], "OBSERVE_ONLY")

    def test_all_200_execute_without_error_on_complete_fixture(self):
        payload, config = fixture()
        receipts = run_batch_1001_1200(payload, config)
        self.assertEqual(tuple(receipts), tuple(f"M{i}" for i in range(1001,1201)))
        self.assertEqual(len(receipts), 200)
        errors = {mid:r["reason_code"] for mid,r in receipts.items() if r["execution_status"]=="ERROR"}
        self.assertEqual(errors, {})
        for mid, receipt in receipts.items():
            self.assertEqual(receipt["module"], mid)
            self.assertEqual(receipt["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(receipt["action_mode"], "OBSERVE_ONLY")
            self.assertTrue(receipt["evidence_hash"].startswith("sha256:"))
            self.assertNotIn("provider", receipt["output"].get("action",""))

    def test_deterministic_receipts(self):
        payload, config = fixture()
        left = run_batch_1001_1200(payload, config)
        right = run_batch_1001_1200(copy.deepcopy(payload), copy.deepcopy(config))
        self.assertEqual(left, right)

    def test_malformed_search_integer_fails_closed_not_bool_as_int(self):
        payload, config = fixture()
        payload["search_performance_records"][0]["impressions"] = True
        receipts = run_batch_1001_1200(payload, config)
        self.assertTrue(all(r["execution_status"] in {"SUCCESS","INSUFFICIENT_DATA"} for r in receipts.values()))

    def test_registry_is_honest_during_incremental_build(self):
        registry = module_registry()
        self.assertEqual(len(registry), 2500)
        self.assertNotIn("M2501", registry)
        for i in range(1,1001):
            self.assertEqual(registry[f"M{i}"]["status"], "DELEGATED_PRODUCTION")
            self.assertFalse(registry[f"M{i}"]["executable_here"])
        for i in range(1001,1201):
            self.assertEqual(registry[f"M{i}"]["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(registry[f"M{i}"]["executable_here"])
        for i in range(1201,2501):
            self.assertEqual(registry[f"M{i}"]["status"], "RESERVED_NOT_EXECUTABLE")
            self.assertFalse(registry[f"M{i}"]["executable_here"])

    def test_no_float_literals_or_network_imports_in_runtime(self):
        root = pathlib.Path(__file__).resolve().parents[1] / "runtime"
        banned_imports={"requests","httpx","aiohttp","urllib.request","socket"}
        for path in root.glob("*.py"):
            tree=ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value,float):
                    self.fail(f"float literal in {path}:{node.lineno}")
                if isinstance(node, ast.Import):
                    for name in node.names:
                        self.assertNotIn(name.name,banned_imports)
                if isinstance(node, ast.ImportFrom):
                    self.assertNotIn(node.module,banned_imports)

    def test_whitehat_gate_is_fail_closed_on_policy_findings(self):
        payload, config = fixture()
        payload["content_documents"].append({"document_id":"/clone-a","text":payload["content_documents"][0]["text"]})
        payload["content_documents"].append({"document_id":"/clone-b","text":payload["content_documents"][0]["text"]})
        receipts=run_batch_1001_1200(payload,config)
        self.assertEqual(receipts["M1176"]["finding_status"],"FINDING")
        self.assertEqual(receipts["M1200"]["execution_status"],"SUCCESS")
        self.assertEqual(receipts["M1200"]["finding_status"],"FINDING")
        self.assertFalse(receipts["M1200"]["output"]["release_safe"])

if __name__ == "__main__":
    unittest.main()

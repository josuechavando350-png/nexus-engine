import unittest

from runtime.catalog import NEW_MODULES, ORIGINAL_MODULES, module_registry
from runtime.mass_lot import run_mass_lot, run_mass_lot_module
from runtime.mass_lot_manifest import SOURCE_SPEC_SHA256
from runtime.mass_lot_runtime_manifest import RUNTIME_MASS_LOT_SPECS, runtime_source_to_target_map
from runtime.service import execute_avengers_400


def complete_payload():
    edge_html = """<!doctype html><html lang='es-MX'><head><meta charset='utf-8'><title>Defensa Penal</title><style data-critical>.used{color:red}</style><link rel='stylesheet' href='/app.css'><link rel='preload' href='/font.woff2' as='font'><link rel='preload' href='/critical.css' as='style'><link rel='preconnect' href='https://cdn.example.com'></head><body><nav aria-label='Principal'><a href='/contacto' target='_blank' rel='noopener'>Contacto</a></nav><main role='main'><h1>Defensa penal empresarial</h1><img src='/hero.webp' decoding='async' loading='eager' fetchpriority='high' width='1200' height='800'><img src='/secondary.webp' decoding='async' loading='lazy' width='600' height='400'><table><thead><tr><th scope='col'>Servicio</th></tr></thead><tbody><tr><td>Defensa</td></tr></tbody></table><svg viewBox='0 0 10 10'><path d='M0 0L1 1'/></svg><code translate='no'>const safe = true;</code><script>const value = 1;</script><script type='application/ld+json'>{\"@type\":\"BreadcrumbList\"}</script><p>Defensa penal estratégica para empresas en México con análisis preventivo y representación especializada.</p></main><footer role='contentinfo'>Nexus</footer></body></html>"""
    entities = [
        {"id":"E1","label":"CANO","type":"ORG","related_ids":["E2"],"salience_ppm":600000,"properties":{"kind":"firm"},"schema_types":{"name":"string"},"language":"es","external_context":{"qid":"Q1"}},
        {"id":"E2","label":"Ciudad de México","type":"GPE","related_ids":["E1"],"parent_id":"E1","taxonomy_parent_id":"E1","salience_ppm":500000,"properties":{"country":"MX"},"schema_types":{"name":"string"},"language":"es","external_context":{"qid":"Q1489"}},
        {"id":"E3","label":"Audiencia","type":"EVENT","related_ids":["E1"],"salience_ppm":400000,"properties":{"scope":"legal"},"schema_types":{"name":"string"},"language":"es","external_context":{"qid":"Q3"}},
        {"id":"E4","label":"Defensa Penal","type":"SERVICE","related_ids":["E1"],"salience_ppm":700000,"properties":{"market":"MX"},"schema_types":{"name":"string"},"language":"es","external_context":{"qid":"Q4"}},
    ]
    hash_a = "sha256:" + "a" * 64
    hash_b = "sha256:" + "b" * 64
    persistence = [
        {"record_id":"db-1","route":"/a","known_routes":["/a","/b"],"lock_key":"lock-a","lock_owner":"worker-a","lock_active":True,"transaction_group":"g1","transaction_state":"COMMITTED","content_hash":hash_a,"vector_versions":["v1","v2"],"expires_at_epoch":2000,"observed_at_epoch":1000,"job_status":"PENDING","json_payload":{"a":1,"b":"x"},"history_partition":"2026-08","primary_key":"pk1","section_id":"s1","parent_section_id":"","schema_version":1,"queue_payload_hash":"q1","grounding_match":True,"grounding_indexed":True,"publication_state":"PUBLISHED","retry_count":1,"next_retry_epoch":2000,"text_value":"México","queue_position":1,"priority":10,"sitemap_hash":"sm1","db_sitemap_hash":"sm1","snapshot_hash":"snap1","expected_snapshot_hash":"snap1","is_temp":True,"updated_at_epoch":900,"grounding_cache_bytes":1000,"config_version":1,"route_query_indexed":True,"broken_refs":[],"table_health":{"index_ok":True,"vacuum_age_seconds":100}},
        {"record_id":"db-2","route":"/b","known_routes":["/a","/b"],"lock_key":"lock-b","lock_owner":"worker-b","lock_active":True,"transaction_group":"g2","transaction_state":"COMMITTED","content_hash":hash_b,"vector_versions":["v2","v3"],"expires_at_epoch":3000,"observed_at_epoch":2000,"job_status":"PENDING","json_payload":{"a":2,"b":"y"},"history_partition":"2026-09","primary_key":"pk2","section_id":"s2","parent_section_id":"s1","schema_version":1,"queue_payload_hash":"q2","grounding_match":True,"grounding_indexed":True,"publication_state":"PUBLISHED","retry_count":1,"next_retry_epoch":3000,"text_value":"Defensa","queue_position":2,"priority":20,"sitemap_hash":"sm2","db_sitemap_hash":"sm2","snapshot_hash":"snap2","expected_snapshot_hash":"snap2","is_temp":True,"updated_at_epoch":1900,"grounding_cache_bytes":1200,"config_version":2,"route_query_indexed":True,"broken_refs":[],"table_health":{"index_ok":True,"vacuum_age_seconds":120}},
    ]
    content_text = "<article><h1>Defensa penal actual para empresa</h1><p>La defensa penal actual para empresa ofrece análisis preventivo, estrategia, acompañamiento, revisión documental, evaluación de riesgos, representación, seguimiento de audiencias, comunicación clara y coordinación jurídica en México.</p><table><tr><td>Comparativa</td></tr></table><ul><li>Diagnóstico</li><li>Estrategia</li></ul><script type='application/ld+json'>{\"@type\":\"FAQPage\"}</script></article>"
    policy_common = {"robots_directives":["index","follow"],"expected_indexable":True,"expected_followable":True,"user_html":"<main>Defensa penal</main>","bot_html":"<main>Defensa penal</main>","response_body":"Temporary response","token_hash":"sha256:token","expected_token_hash":"sha256:token","transform_ms":5,"origin_status_code":200,"target_domain":"example.com","authorized_domains":["example.com"],"url":"https://example.com/defensa-penal","jsonld_types":["WebPage","Organization"],"robots_allowed":True,"expected_robots_allowed":True,"visible_text":"Contenido jurídico original y verificable.","content_type":"text/html; charset=utf-8","transfer_mode":"STREAM","site_id":"probe","expected_site_id":"probe","headings":["Defensa Penal","Estrategia"],"kv_storage_bytes":1000,"device_renders":{"desktop":"<main>Defensa penal</main>","mobile":"<main>Defensa penal</main>"},"html":"<main>Defensa penal segura</main>","closure_checks":{"integrity":True,"policy":True}}
    return {
        "edge_html_records":[{"record_id":"edge-1","html":edge_html,"uri":"/servicios/penal/empresas","author":"CANO","locale":"es-MX","headers":{"cache-control":"public, max-age=3600"}}],
        "semantic_text_records":[{"record_id":"sem-1","text":"CANO ofrece Defensa Penal en Ciudad de México. CANO explica qué es defensa penal y la Audiencia forma parte del proceso.","entities":entities,"locale":"es-MX","entity_cache":{"defensa":["defensa","protección","representación"]},"headings":["h1: Defensa Penal","h2: Audiencia"],"links":[{"anchor":"Defensa Penal"},{"anchor":"Audiencia"}],"intent_labels":["transaccional","informativa"]}],
        "persistence_state_records":persistence,
        "edge_gateway_records":[{"record_id":"gw-1","payload":{"site_id":"probe","source_revision":"rev"},"headers":{"x-nexus-seo-token":"token"},"response_headers":{"content-type":"text/html","cache-control":"public,max-age=600","content-encoding":"gzip"},"status_code":200,"signature":"sig","expected_signature":"sig","fallback_used":False,"latency_ms":100,"kv_key":"seo:probe:page:/","site_id":"probe","worker_schema":{"schema_version":1,"site_id":"probe"},"kv_writes":10,"endpoint":"https://publisher.example.com/publish","snapshot_version":2,"expected_snapshot_version":2,"previous_snapshot_version":1,"fail_open_state":"BASE_RESPONSE","base_status_code":200,"redirect_chain":["/inicio","/destino"],"exclusion_reasons":[],"target_domain":"example.com","expected_target_domain":"example.com","cache_hit":True,"policy_version":"v1","expected_policy_version":"v1","response_bytes":1000,"suite_signature":"suite-v1","health_ok":True}],
        "search_intent_records":[{"record_id":"intent-1","query":"mejor precio actual defensa penal para empresa?","content_text":content_text,"intent_labels":["transaccional","comparativa"],"conversion_synonyms":{"precio":["costo","cotización"]},"title":"Defensa Penal para Empresa | CANO","image_alts":["defensa penal empresa"],"entities":["CANO","Defensa Penal"],"meta_description":"Defensa penal estratégica para empresas en México con análisis preventivo, diagnóstico de riesgos, representación y seguimiento jurídico especializado.","age_days":30,"niche":"penal","outbound_links":[{"anchor":"defensa penal"}],"internal_anchors":["defensa penal para empresas"],"navigation_entities":["cano","defensa penal"],"silo":"penal","internal_link_targets":[{"silo":"penal"}]}],
        "cwv_edge_records":[{"record_id":"cwv-1","html":edge_html,"headers":{"content-encoding":"br","cache-control":"public,max-age=3600","content-security-policy":"default-src 'self'","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","vary":"User-Agent","x-geo-country":"MX"},"assets":[{"kind":"script","bytes":1000,"critical":True}],"url":"https://example.com/servicios/penal","user_agent_variants":{"desktop":edge_html,"mobile":edge_html},"internal_redirect_chain":["/destino"],"response_bytes":len(edge_html.encode("utf-8")),"geo_headers_authorized":True,"latency_ms":100,"device":"mobile","critical_assets":["/critical.css"],"transform_ms":5,"client_render_ms":100}],
        "canonicalization_records":[{"record_id":"canon-1","keyword":"defensa penal","url":"https://example.com/defensa-penal","semantic_key":"defensa-penal","consolidated_to":"/defensa-penal","slug_history":["penal-antiguo"],"internal_inlinks":5,"quality_score_ppm":500000,"excluded_from_index":False,"locale":"es-MX","hreflang":"es-MX","structural_changes_24h":1,"h1":"Defensa Penal","author_id":"author-1","write_lock_key":"canon-lock","write_lock_owner":"worker-1","write_lock_active":True,"inactive_days":10,"archived":False,"sitemap_present":True,"db_present":True,"query_cluster":"defensa","transaction_errors":0,"brand_entity":"CANO","entities":["CANO","Defensa Penal"],"expected_season":"evergreen","content_season":"evergreen","slug":"defensa-penal","integrity_verified":True,"graph_growth_ppm":500000,"purchase_intent":True,"category":"legal","lock_wait_ms":100,"commerce_entities":["Defensa Penal"],"schema_signature":"schema-1"}],
        "policy_audit_records":[{"record_id":"policy-503",**policy_common,"status_code":503,"headers":{"retry-after":"60","x-nexus-seo-suite":"400"}},{"record_id":"policy-301",**policy_common,"status_code":301,"headers":{"location":"/destino","x-nexus-seo-suite":"400"}}],
    }


class Avengers400Tests(unittest.TestCase):
    def test_registry_is_exactly_original_200_plus_new_200(self):
        registry = module_registry()
        self.assertEqual(list(registry), [f"M{i}" for i in range(1, 401)])
        self.assertEqual(len(registry), 400)
        self.assertEqual(len(ORIGINAL_MODULES), 200)
        self.assertEqual(len(NEW_MODULES), 200)
        self.assertNotIn("M401", registry)
        self.assertTrue(all(registry[f"M{i}"]["status"] == "DELEGATED_PRODUCTION" for i in range(1, 201)))
        self.assertTrue(all(not registry[f"M{i}"]["executable_here"] for i in range(1, 201)))
        self.assertTrue(all(registry[f"M{i}"]["status"] == "IMPLEMENTED_PRODUCTION" for i in range(201, 401)))

    def test_source_mapping_is_exactly_sequential(self):
        self.assertEqual(len(RUNTIME_MASS_LOT_SPECS), 200)
        mapping = runtime_source_to_target_map()
        self.assertEqual(mapping, {f"M{1201+i}": f"M{201+i}" for i in range(200)})
        self.assertEqual(SOURCE_SPEC_SHA256, "sha256:16dc5dd3c0834c1e3306add2bb79b00aac072fd5767ce352c31725d2d024e9d1")

    def test_all_new_200_execute_successfully_and_uniquely(self):
        receipts = run_mass_lot(complete_payload(), {})
        self.assertEqual(set(receipts), {f"M{i}" for i in range(201, 401)})
        failures = {m:r["reason_code"] for m,r in receipts.items() if r["execution_status"] != "SUCCESS"}
        self.assertEqual(failures, {})
        self.assertEqual(len({r["algorithm"] for r in receipts.values()}), 200)
        self.assertEqual(len({r["evidence_hash"] for r in receipts.values()}), 200)

    def test_determinism_and_config_binding(self):
        payload = complete_payload()
        self.assertEqual(run_mass_lot(payload, {}), run_mass_lot(payload, {}))
        rows = payload["edge_html_records"]
        a = run_mass_lot_module("M201", rows, {"m201_policy_threshold":0})
        b = run_mass_lot_module("M201", rows, {"m201_policy_threshold":1})
        self.assertNotEqual(a["module_config_hash"], b["module_config_hash"])
        self.assertNotEqual(a["evidence_hash"], b["evidence_hash"])

    def test_fail_closed_and_no_synthetic_evidence(self):
        conflict = run_mass_lot_module("M201", [{"record_id":"x","html":"<html></html>","uri":"/"},{"record_id":"x","html":"<main>x</main>","uri":"/"}], {})
        self.assertEqual((conflict["execution_status"], conflict["finding_status"]), ("ERROR", "FINDING"))
        malformed = run_mass_lot_module("M201", [{"record_id":"x","html":"<html></html>","uri":"/","score":0.5}], {})
        self.assertEqual(malformed["execution_status"], "ERROR")
        insufficient = run_mass_lot_module("M201", [], {})
        self.assertEqual((insufficient["execution_status"], insufficient["finding_status"]), ("INSUFFICIENT_DATA", "NOT_APPLICABLE"))
        invalid_cfg = run_mass_lot_module("M201", complete_payload()["edge_html_records"], {"m201_policy_threshold":-1})
        self.assertEqual(invalid_cfg["reason_code"], "INVALID_MODULE_CONFIG")

    def test_composition_service_is_deny_by_default_and_executes_exact_new_200(self):
        disabled = execute_avengers_400(complete_payload(), {})
        self.assertFalse(disabled["enabled"])
        self.assertEqual(disabled["receipts"], {})
        enabled = execute_avengers_400(complete_payload(), {"CONFIG_SEO_AVENGERS_400":True})
        self.assertTrue(enabled["enabled"])
        self.assertEqual(enabled["total_modules"], 400)
        self.assertEqual(enabled["delegated_original_modules"], 200)
        self.assertEqual(enabled["executed_new_modules"], 200)
        self.assertEqual(set(enabled["receipts"]), {f"M{i}" for i in range(201,401)})


if __name__ == "__main__":
    unittest.main()

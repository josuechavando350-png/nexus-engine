import unittest

from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.mass_lot import run_mass_lot, run_mass_lot_module
from runtime.mass_lot_manifest import SOURCE_SPEC_SHA256
from runtime.mass_lot_runtime_manifest import (
    RUNTIME_MASS_LOT_SOURCE_MODULES,
    RUNTIME_MASS_LOT_SPECS,
    RUNTIME_MASS_LOT_TARGET_MODULES,
    runtime_source_to_target_map,
)
from runtime.service import execute_avengers_1200


def complete_payload():
    edge_html = """<!doctype html><html lang='es-MX'><head><meta charset='utf-8'><title>Defensa Penal</title><style data-critical>.used{color:red}</style><link rel='stylesheet' href='/app.css'><link rel='preload' href='/font.woff2' as='font'><link rel='preload' href='/critical.css' as='style'><link rel='preconnect' href='https://cdn.example.com'></head><body><nav aria-label='Principal'><a href='/contacto' target='_blank' rel='noopener'>Contacto</a></nav><main role='main'><h1>Defensa penal empresarial</h1><img src='/hero.webp' decoding='async' loading='eager' fetchpriority='high' width='1200' height='800'><img src='/secondary.webp' decoding='async' loading='lazy' width='600' height='400'><table><thead><tr><th scope='col'>Servicio</th></tr></thead><tbody><tr><td>Defensa</td></tr></tbody></table><svg viewBox='0 0 10 10'> <path d='M0 0L1 1'/> </svg><code translate='no'>const safe = true;</code><script>const value = 1;</script><script type='application/ld+json'>{\"@type\":\"BreadcrumbList\"}</script><p>Defensa penal estratégica para empresas en México con análisis preventivo y representación especializada.</p></main><footer role='contentinfo'>Nexus</footer></body></html>"""
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
        "policy_audit_records":[{"record_id":"policy-503",**policy_common,"status_code":503,"headers":{"retry-after":"60","x-nexus-seo-suite":"1200"}},{"record_id":"policy-301",**policy_common,"status_code":301,"headers":{"location":"/destino","x-nexus-seo-suite":"1200"}}],
    }


class MassLot200Tests(unittest.TestCase):
    def test_runtime_manifest_is_exactly_200_unique_and_source_bound(self):
        self.assertEqual(len(RUNTIME_MASS_LOT_SPECS), 200)
        self.assertEqual(len(RUNTIME_MASS_LOT_TARGET_MODULES), 200)
        self.assertEqual(len(RUNTIME_MASS_LOT_SOURCE_MODULES), 200)
        self.assertEqual(len(set(RUNTIME_MASS_LOT_SOURCE_MODULES)), 200)
        self.assertEqual(RUNTIME_MASS_LOT_SOURCE_MODULES[0], "M1201")
        self.assertEqual(RUNTIME_MASS_LOT_SOURCE_MODULES[-1], "M1400")
        self.assertEqual(SOURCE_SPEC_SHA256, "sha256:16dc5dd3c0834c1e3306add2bb79b00aac072fd5767ce352c31725d2d024e9d1")
        mapping = runtime_source_to_target_map()
        self.assertEqual(mapping["M1201"], "M216")
        self.assertEqual(mapping["M1400"], "M440")

    def test_all_200_execute_successfully_with_unique_algorithms(self):
        receipts = run_mass_lot(complete_payload(), {})
        self.assertEqual(len(receipts), 200)
        failures = {module: receipt["reason_code"] for module, receipt in receipts.items() if receipt["execution_status"] != "SUCCESS"}
        self.assertEqual(failures, {})
        self.assertEqual(len({receipt["algorithm"] for receipt in receipts.values()}), 200)
        self.assertEqual(len({receipt["evidence_hash"] for receipt in receipts.values()}), 200)
        for module_id, receipt in receipts.items():
            self.assertEqual(receipt["module"], module_id)
            self.assertEqual(receipt["output"]["source_spec_sha256"], SOURCE_SPEC_SHA256)
            self.assertIn(receipt["finding_status"], {"FINDING", "NO_FINDING"})

    def test_mass_lot_is_deterministic(self):
        self.assertEqual(run_mass_lot(complete_payload(), {}), run_mass_lot(complete_payload(), {}))

    def test_config_is_hash_bound_and_invalid_config_fails_closed(self):
        records = complete_payload()["edge_html_records"]
        first = run_mass_lot_module("M216", records, {"m216_policy_threshold":0})
        changed = run_mass_lot_module("M216", records, {"m216_policy_threshold":1})
        invalid = run_mass_lot_module("M216", records, {"m216_policy_threshold":-1})
        self.assertNotEqual(first["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(first["evidence_hash"], changed["evidence_hash"])
        self.assertEqual(invalid["reason_code"], "INVALID_MODULE_CONFIG")

    def test_conflicting_duplicate_fails_closed(self):
        records = [{"record_id":"same","html":"<html></html>","uri":"/a"},{"record_id":"same","html":"<html><main>x</main></html>","uri":"/a"}]
        result = run_mass_lot_module("M216", records, {})
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertEqual(result["reason_code"], "DUPLICATE_MASS_LOT_RECORD_CONFLICT")

    def test_float_or_malformed_record_fails_closed(self):
        result = run_mass_lot_module("M216", [{"record_id":"bad","html":"<html></html>","uri":"/","score":0.5}], {})
        self.assertEqual(result["execution_status"], "ERROR")
        self.assertEqual(result["reason_code"], "INVALID_MASS_LOT_RECORDS")

    def test_missing_real_evidence_is_insufficient_not_synthetic(self):
        result = run_mass_lot_module("M216", [], {})
        self.assertEqual(result["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(result["finding_status"], "NOT_APPLICABLE")

    def test_catalog_promotes_exact_200_and_preserves_historical_sentinels(self):
        registry = module_registry()
        self.assertEqual(len(IMPLEMENTED_EXTENDED_MODULES), 274)
        self.assertEqual(len(PRE_GATE_MODULES), 272)
        self.assertTrue(RUNTIME_MASS_LOT_TARGET_MODULES.issubset(IMPLEMENTED_EXTENDED_MODULES))
        self.assertTrue(all(registry[module]["executable_here"] for module in RUNTIME_MASS_LOT_TARGET_MODULES))
        for sentinel in ("M215", "M317", "M441"):
            self.assertEqual(registry[sentinel]["status"], "RESERVED")
            self.assertFalse(registry[sentinel]["executable_here"])

    def test_service_connects_all_200_to_m1101_and_m1102(self):
        result = execute_avengers_1200(complete_payload(), {"CONFIG_SEO_AVENGERS_1200":True})
        self.assertEqual(sum(1 for module in RUNTIME_MASS_LOT_TARGET_MODULES if module in result["receipts"]), 200)
        self.assertEqual(result["receipts"]["M1101"]["reason_code"], "EDGE_EVIDENCE_INTEGRITY_VERIFIED")
        self.assertEqual(result["receipts"]["M1101"]["output"]["checked_modules_count"], len(PRE_GATE_MODULES))
        self.assertFalse(result["receipts"]["M1102"]["output"]["deployment_halt_recommended"])


if __name__ == "__main__":
    unittest.main()

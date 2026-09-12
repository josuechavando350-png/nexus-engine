import copy
import unittest

from runtime.manifest import FINGERPRINTS, MODULE_SPECS
from runtime.module_runtime import execute_module
from runtime.runner import run_batch_1001_1800
from test_batch_1201_1400 import fixture as base_fixture

_CURRENT_MODULES = tuple(f"M{i}" for i in range(1601, 1801))
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required",
    "new_database_required",
    "new_queue_required",
    "new_secret_required",
    "new_cloud_resource_required",
    "new_daemon_required",
)

def fixture():
    payload, config = base_fixture()
    semantic_text = (
        "CANO Estrategia Penal ofrece defensa penal y defensa por fraude en Ciudad de Mexico. "
        "Una audiencia inicial forma parte del proceso penal y la estrategia depende de evidencia real."
    )
    payload.update({
        "search_intent_records": [{
            "record_id": "intent-1",
            "query": "mejor precio abogado penal cdmx para audiencia inicial?",
            "content_text": semantic_text,
            "intent_labels": ["transaccional", "comparativa", "informativa"],
            "conversion_synonyms": {"precio": ["costo", "cotizacion"]},
            "title": "Abogado Penal en CDMX | CANO Estrategia Penal",
            "image_alts": ["abogado penal en cdmx"],
            "entities": ["CANO Estrategia Penal", "Defensa Penal", "Ciudad de Mexico"],
            "meta_description": "Defensa penal y acompañamiento jurídico de CANO Estrategia Penal en Ciudad de México.",
            "age_days": 30,
            "niche": "penal",
            "outbound_links": [{"anchor": "defensa penal"}],
            "internal_anchors": ["defensa penal", "audiencia inicial"],
            "navigation_entities": ["CANO Estrategia Penal", "Defensa Penal"],
            "silo": "penal",
            "internal_link_targets": [{"silo": "penal"}, {"silo": "fraude"}],
        }],
        "canonicalization_records": [{
            "record_id": "canon-penal",
            "keyword": "abogado defensa penal cdmx",
            "url": "https://canopenal.com/penal-cdmx",
            "semantic_key": "penal-cdmx",
            "consolidated_to": "/penal-cdmx",
            "slug_history": ["defensa-penal-cdmx"],
            "internal_inlinks": 6,
            "quality_score_ppm": 850_000,
            "excluded_from_index": False,
            "locale": "es-MX",
            "hreflang": "es-MX",
            "structural_changes_24h": 1,
            "h1": "Defensa Penal en CDMX",
            "author_id": "cano",
            "write_lock_key": "canon-lock",
            "write_lock_owner": "worker-1",
            "write_lock_active": True,
            "inactive_days": 10,
            "archived": False,
            "sitemap_present": True,
            "db_present": True,
            "query_cluster": "penal",
            "transaction_errors": 0,
            "brand_entity": "CANO Estrategia Penal",
            "entities": ["CANO Estrategia Penal", "Defensa Penal", "Ciudad de Mexico"],
            "expected_season": "evergreen",
            "content_season": "evergreen",
            "slug": "penal-cdmx",
            "integrity_verified": True,
            "graph_growth_ppm": 500_000,
            "purchase_intent": True,
            "category": "legal",
            "lock_wait_ms": 20,
            "commerce_entities": ["Defensa Penal"],
            "schema_signature": "schema-localbusiness-v1",
        }],
        "persistence_state_records": [{
            "record_id": "persist-penal",
            "route": "/penal-cdmx",
            "known_routes": ["/penal-cdmx", "/fraude-cdmx", "/audiencia-inicial-cdmx", "/contacto"],
            "lock_key": "route-lock",
            "lock_owner": "worker-1",
            "lock_active": True,
            "transaction_group": "seo-local",
            "transaction_state": "COMMITTED",
            "content_hash": "sha256:" + "a" * 64,
            "vector_versions": ["v1"],
            "expires_at_epoch": 2_000,
            "observed_at_epoch": 1_000,
            "job_status": "PENDING",
            "json_payload": {"route": "/penal-cdmx"},
            "history_partition": "2026-09",
            "primary_key": "penal-cdmx",
            "section_id": "penal",
            "parent_section_id": "",
            "schema_version": 1,
            "queue_payload_hash": "q-penal",
            "grounding_match": True,
            "grounding_indexed": True,
            "publication_state": "PUBLISHED",
            "retry_count": 1,
            "next_retry_epoch": 2_000,
            "text_value": "Defensa Penal",
            "queue_position": 1,
            "priority": 10,
            "sitemap_hash": "sitemap-v1",
            "db_sitemap_hash": "sitemap-v1",
            "snapshot_hash": "snapshot-v1",
            "expected_snapshot_hash": "snapshot-v1",
            "is_temp": False,
            "updated_at_epoch": 900,
            "grounding_cache_bytes": 2_000,
            "config_version": 1,
            "route_query_indexed": True,
            "broken_refs": [],
            "table_health": {"index_ok": True, "vacuum_age_seconds": 100},
        }],
        "edge_gateway_records": [{
            "record_id": "gateway-1",
            "payload": {"site_id": "cano", "source_revision": "fixture"},
            "headers": {"x-nexus-seo-token": "bound"},
            "response_headers": {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "public,max-age=600",
                "content-encoding": "br",
            },
            "status_code": 200,
            "signature": "sig",
            "expected_signature": "sig",
            "fallback_used": False,
            "latency_ms": 80,
            "kv_key": "seo:cano:page:/penal-cdmx",
            "site_id": "cano",
            "worker_schema": {"schema_version": 1, "site_id": "cano"},
            "kv_writes": 1,
            "endpoint": "https://publisher.canopenal.com/publish",
            "snapshot_version": 2,
            "expected_snapshot_version": 2,
            "previous_snapshot_version": 1,
            "fail_open_state": "BASE_RESPONSE",
            "base_status_code": 200,
            "redirect_chain": ["/penal-cdmx"],
            "exclusion_reasons": [],
            "target_domain": "canopenal.com",
            "expected_target_domain": "canopenal.com",
            "cache_hit": True,
            "policy_version": "v1",
            "expected_policy_version": "v1",
            "response_bytes": 12_000,
            "suite_signature": "seo-avengers",
            "health_ok": True,
        }],
        "cwv_edge_records": [{
            "record_id": "cwv-1",
            "html": "<main>Defensa penal CANO Estrategia Penal</main>",
            "headers": {
                "content-encoding": "br",
                "cache-control": "public,max-age=600",
                "content-security-policy": "default-src 'self'",
                "x-content-type-options": "nosniff",
                "referrer-policy": "strict-origin-when-cross-origin",
                "x-geo-country": "MX",
            },
            "assets": [{"kind": "style", "bytes": 20_000, "critical": True}],
            "url": "https://canopenal.com/penal-cdmx",
            "user_agent_variants": {
                "desktop": "<main>Defensa penal CANO Estrategia Penal</main>",
                "mobile": "<main>Defensa penal CANO Estrategia Penal</main>",
            },
            "internal_redirect_chain": ["/penal-cdmx"],
            "response_bytes": 12_000,
            "geo_headers_authorized": True,
            "latency_ms": 80,
            "device": "mobile",
            "critical_assets": ["/critical.css"],
            "transform_ms": 8,
            "client_render_ms": 120,
        }],
        "policy_audit_records": [{
            "record_id": "policy-1",
            "robots_directives": ["index", "follow"],
            "expected_indexable": True,
            "expected_followable": True,
            "user_html": "<main>Defensa penal CANO</main>",
            "bot_html": "<main>Defensa penal CANO</main>",
            "response_body": "Defensa penal CANO",
            "token_hash": "sha256:token",
            "expected_token_hash": "sha256:token",
            "transform_ms": 8,
            "origin_status_code": 200,
            "target_domain": "canopenal.com",
            "authorized_domains": ["canopenal.com"],
            "url": "https://canopenal.com/penal-cdmx",
            "jsonld_types": ["WebPage", "LegalService", "Organization"],
            "robots_allowed": True,
            "expected_robots_allowed": True,
            "visible_text": "Defensa penal original y verificable de CANO Estrategia Penal.",
            "content_type": "text/html; charset=utf-8",
            "transfer_mode": "STREAM",
            "site_id": "cano",
            "expected_site_id": "cano",
            "headings": ["Defensa Penal", "Estrategia"],
            "kv_storage_bytes": 1_000,
            "device_renders": {"desktop": "same", "mobile": "same"},
            "html": "<main>Defensa penal CANO</main>",
            "closure_checks": {"integrity": True, "policy": True},
            "status_code": 200,
            "headers": {"x-nexus-seo-suite": "2500"},
        }],
        "semantic_text_records": [{
            "record_id": "semantic-1",
            "text": semantic_text,
            "entities": [
                {"id": "E1", "label": "CANO Estrategia Penal", "type": "ORG", "related_ids": ["E2", "E4"], "salience_ppm": 800_000, "properties": {"kind": "firm"}, "schema_types": {"name": "string"}, "language": "es", "external_context": {"source": "project"}},
                {"id": "E2", "label": "Ciudad de Mexico", "type": "GPE", "related_ids": ["E1"], "salience_ppm": 700_000, "properties": {"country": "MX"}, "schema_types": {"name": "string"}, "language": "es", "external_context": {"source": "project"}},
                {"id": "E3", "label": "Audiencia Inicial", "type": "EVENT", "related_ids": ["E4"], "salience_ppm": 600_000, "properties": {"scope": "penal"}, "schema_types": {"name": "string"}, "language": "es", "external_context": {"source": "project"}},
                {"id": "E4", "label": "Defensa Penal", "type": "SERVICE", "related_ids": ["E1", "E3"], "salience_ppm": 900_000, "properties": {"market": "MX"}, "schema_types": {"name": "string"}, "language": "es", "external_context": {"source": "project"}},
            ],
            "locale": "es-MX",
            "entity_cache": {"defensa": ["defensa penal", "representacion"]},
            "headings": ["h1: Defensa Penal", "h2: Audiencia Inicial"],
            "links": [{"anchor": "defensa penal"}, {"anchor": "audiencia inicial"}],
            "intent_labels": ["transaccional", "informativa", "local"],
        }],
    })
    config["project_locale"] = "es-MX"
    return payload, config

class Batch16011800Tests(unittest.TestCase):
    def test_fourth_slice_is_exact_unique_whitehat_and_source_bound(self):
        current = {mid: MODULE_SPECS[mid] for mid in _CURRENT_MODULES}
        self.assertEqual(len(current), 200)
        self.assertEqual(len({spec["operation"] for spec in current.values()}), 200)
        self.assertEqual(len({FINGERPRINTS[mid] for mid in current}), 200)
        discovery_modes = [MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(1601, 1691)]
        topical_modes = [MODULE_SPECS[f"M{i}"]["params"]["mode"] for i in range(1701, 1791)]
        self.assertEqual(len(set(discovery_modes)), 90)
        self.assertEqual(len(set(topical_modes)), 90)
        for number in range(1601, 1801):
            spec = current[f"M{number}"]
            self.assertEqual(spec["source_module"], f"M{number + 1000}")
            self.assertEqual(spec["policy_status"], "SAFE_WHITE_HAT")
            self.assertEqual(spec["action_mode"], "OBSERVE_ONLY")

    def test_exact_800_local_modules_execute_without_error_on_complete_evidence(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        self.assertEqual(tuple(receipts), tuple(f"M{i}" for i in range(1001, 1801)))
        self.assertEqual(len(receipts), 800)
        errors = {mid: r["reason_code"] for mid, r in receipts.items() if r["execution_status"] == "ERROR"}
        insufficient = {mid: r["reason_code"] for mid, r in receipts.items() if r["execution_status"] == "INSUFFICIENT_DATA"}
        self.assertEqual(errors, {})
        self.assertEqual(insufficient, {})

    def test_fourth_batch_receipts_are_deterministic(self):
        payload, config = fixture()
        left = run_batch_1001_1800(payload, config)
        right = run_batch_1001_1800(copy.deepcopy(payload), copy.deepcopy(config))
        self.assertEqual(
            {mid: left[mid] for mid in _CURRENT_MODULES},
            {mid: right[mid] for mid in _CURRENT_MODULES},
        )

    def test_discovery_velocity_never_claims_google_timing_or_index_state(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        for number in range(1601, 1691):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            self.assertTrue(receipt["output"].get("not_a_google_crawl_speed_prediction"))
            self.assertTrue(receipt["output"].get("not_a_google_index_state_claim"))
            text = str(receipt["output"]).casefold()
            self.assertNotIn("guaranteed crawl", text)
            self.assertNotIn("guaranteed index", text)

    def test_topical_lattice_is_observe_only_and_never_generates_doorways(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        for number in range(1701, 1791):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["execution_status"], "SUCCESS")
            self.assertEqual(receipt["action_mode"], "OBSERVE_ONLY")
            self.assertTrue(receipt["output"].get("observe_only"))
            self.assertTrue(receipt["output"].get("no_content_generation"))
            self.assertTrue(receipt["output"].get("no_doorway_generation"))
            self.assertTrue(receipt["output"].get("grounded_in_verified_project_evidence"))

    def test_new_analytics_bind_existing_contract_and_zero_new_infrastructure(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        for number in list(range(1601, 1691)) + list(range(1701, 1791)):
            receipt = receipts[f"M{number}"]
            self.assertEqual(receipt["output"].get("evidence_contract"), "EXISTING_NEXUS_RECORDS_ONLY")
            contract = receipt["output"].get("runtime_contract")
            self.assertIsInstance(contract, dict)
            for field in _RUNTIME_FALSE_FIELDS:
                self.assertIs(contract.get(field), False)
        self.assertEqual(receipts["M1696"]["finding_status"], "NO_FINDING")
        self.assertEqual(receipts["M1796"]["finding_status"], "NO_FINDING")

    def test_tampered_discovery_receipt_is_rejected_by_hash_guard(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        context = {"M1600": receipts["M1600"]}
        for number in range(1601, 1691):
            context[f"M{number}"] = copy.deepcopy(receipts[f"M{number}"])
        context["M1601"]["output"]["score_ppm"] = 0
        result = execute_module("M1692", payload, config, prior_receipts=context)
        self.assertEqual(result["execution_status"], "SUCCESS")
        self.assertEqual(result["finding_status"], "FINDING")
        self.assertIn("M1601", result["output"]["invalid_receipt_modules"])

    def test_m1700_and_m1800_certify_exact_boundaries(self):
        payload, config = fixture()
        receipts = run_batch_1001_1800(payload, config)
        for module_id, expected_end in (("M1700", "M1700"), ("M1800", "M1800")):
            terminal = receipts[module_id]
            self.assertEqual(terminal["execution_status"], "SUCCESS")
            self.assertEqual(terminal["finding_status"], "NO_FINDING")
            self.assertTrue(terminal["output"]["release_safe"])
            self.assertEqual(terminal["output"]["checked_receipt_count"], 10)
            self.assertEqual(terminal["output"]["certified_local_range"], ["M1001", expected_end])
            self.assertEqual(terminal["output"]["policy_status"], "STRICT_WHITE_HAT_ONLY")

if __name__ == "__main__":
    unittest.main()

import json
from pathlib import Path
import unittest

from runtime.runner import run_batch_1001_2500


SCENARIO_PATH = Path(__file__).resolve().parents[1] / "commercial-demand" / "nexus-commercial-demand-v1.json"


def nexus_payload_and_config():
    scenario = json.loads(SCENARIO_PATH.read_text(encoding="utf-8"))
    observed = scenario["observedSearch"]["queryRows"]
    search_rows = [
        {
            "query": row["query"],
            "page_url": row["pageUrl"],
            "clicks": row["clicks"],
            "impressions": row["impressions"],
            "average_position_milli": row["averagePositionMilli"],
        }
        for row in observed
    ]

    # Probe-only documents describe already-known NEXUS service categories.
    # They are deliberately not customer testimonials, case studies, locations,
    # rankings, funnel outcomes, or fabricated provider observations.
    content_documents = [
        {"document_id": "/", "text": "Nexus Bot Studio. Servicios para empresas: web, growth, sales y automation."},
        {"document_id": "/web", "text": "Nexus Web. Diseño y desarrollo web para empresas."},
        {"document_id": "/growth", "text": "Nexus Growth. SEO y crecimiento orgánico para empresas."},
        {"document_id": "/sales", "text": "Nexus Sales. Chatbots y flujos de atención comercial para empresas."},
        {"document_id": "/automation", "text": "Nexus Automation. Automatización de procesos y flujos empresariales."},
    ]

    payload = {
        "search_performance_records": search_rows,
        "content_documents": content_documents,
        "local_business_records": [],
        "search_intent_records": [],
        "canonicalization_records": [],
        "persistence_state_records": [],
        "edge_gateway_records": [],
        "cwv_edge_records": [],
        "policy_audit_records": [],
        "semantic_text_records": [],
        "revenue_funnel_records": [],
        "revenue_attribution_records": [],
        "keyword_coverage_records": [],
        "traffic_window_records": [],
        "traffic_series_records": [],
        "content_decay_records": [],
        "upstream_evidence": [],
    }
    config = {
        "project_locale": "es-MX",
        "local_commercial_terms": ["agencia", "servicios", "cotizacion", "precio", "empresa"],
        "local_service_terms": ["seo", "diseño web", "desarrollo web", "automatizacion", "whatsapp", "chatbot", "software", "ia"],
        "local_location_terms": ["mexico", "cdmx"],
        "local_urgency_terms": ["urgente", "inmediato"],
        "local_question_terms": ["como", "cuanto", "que"],
        "local_brand_terms": ["nexus", "nexus bot studio"],
        "local_verified_service_terms": ["seo", "diseño web", "desarrollo web", "automatizacion", "chatbot", "software"],
        "local_verified_location_terms": ["mexico", "cdmx"],
        "local_service_groups": {
            "seo": ["seo"],
            "web": ["diseño web", "desarrollo web"],
            "automation": ["automatizacion", "whatsapp", "chatbot"],
            "software": ["software", "ia"],
        },
        "local_location_groups": {"mexico": ["mexico"], "cdmx": ["cdmx"]},
        "organic_funnel_source_ids": ["organic-search"],
    }
    return payload, config


class NexusCommercialScenarioProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload, cls.config = nexus_payload_and_config()
        cls.receipts = run_batch_1001_2500(cls.payload, cls.config)

    def test_exact_local_1500_modules_are_exercised_on_nexus_probe(self):
        self.assertEqual(tuple(self.receipts), tuple(f"M{i}" for i in range(1001, 2501)))
        self.assertEqual(len(self.receipts), 1500)
        self.assertTrue(all(receipt.get("action_mode") == "OBSERVE_ONLY" for receipt in self.receipts.values()))

    def test_missing_first_party_funnel_remains_missing_instead_of_being_fabricated(self):
        self.assertEqual(self.payload["revenue_funnel_records"], [])
        insufficient = {
            module_id: receipt["reason_code"]
            for module_id, receipt in self.receipts.items()
            if receipt.get("execution_status") == "INSUFFICIENT_DATA"
        }
        self.assertTrue(insufficient, "evidence-sparse NEXUS probe must expose insufficient-data receipts")

    def test_probe_never_turns_missing_evidence_into_release_safe(self):
        terminal = self.receipts["M2500"]
        self.assertEqual(terminal["execution_status"], "SUCCESS")
        self.assertEqual(terminal["finding_status"], "FINDING")
        self.assertFalse(terminal["output"]["release_safe"])
        self.assertTrue(terminal["output"]["blocking_findings"])

    def test_execution_statuses_are_only_success_insufficient_or_error(self):
        statuses = {receipt.get("execution_status") for receipt in self.receipts.values()}
        self.assertFalse({"SKIP", "SKIPPED", "NOT_TESTED"} & statuses)
        self.assertTrue(statuses <= {"SUCCESS", "INSUFFICIENT_DATA", "ERROR"})


if __name__ == "__main__":
    unittest.main()

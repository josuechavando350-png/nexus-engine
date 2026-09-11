from __future__ import annotations

from typing import Any, Dict

from runtime.manifest import MODULE_SPECS


def _good_value(field: str) -> Any:
    defaults = {
        "bio_text": "Autor con credenciales verificables, experiencia profesional documentada, formación relevante y trayectoria pública. " * 2,
        "trust_entities": ["licencia", "institución", "autor", "cargo", "colegio", "experiencia", "perfil", "fuente"],
        "entity_a": "autor", "entity_b": "organización", "distance": 0,
        "author_bio_tokens": ["seo","autor","entidad","marca","tema","fuente","perfil","sitio","datos","calidad","contenido","experiencia"],
        "page_topic_tokens": ["seo","autor","entidad","marca","tema","fuente","perfil","sitio","datos","calidad","contenido","experiencia"],
        "outbound_links": ["https://trusted.example/a","https://trusted.example/b"], "whitelist_domains": ["trusted.example"],
        "body_text": "contenido técnico verificable sin repetición artificial " * 80, "target_entities": ["entidad_objetivo"],
        "claims": ["claim-a","claim-b"], "scientific_consensus_evidence": [True, True],
        "disclosure_text": "regulación transparencia licencia aviso " * 20, "regulatory_keywords": ["regulación","transparencia","licencia","aviso"],
        "title_entities": ["marca","producto"], "body_entities": ["marca","producto","servicio"],
        "raw_tokens": [f"t{i}" for i in range(20)], "synonym_graph": [[f"t{i}", f"s{i}"] for i in range(20)],
        "content_nodes": ["a","b","c","d","e","f"], "niche_vector": ["a","b","c","d","e"],
        "ner_tokens": ["a","b"], "confidence_ppm": [1_000_000,1_000_000],
        "detected_entities": ["a","b"], "knowledge_graph_snapshot": ["a","b","c"],
        "unique_tokens": 100, "total_tokens": 100, "intent_markers": 10, "total_sentences": 10,
        "informative_verbs": 10, "total_verbs": 10, "question_blocks": ["q1","q2"], "answer_blocks": ["a1","a2"],
        "syllables": 100, "sentences": 10, "words": 100, "positive_tokens": 0, "negative_tokens": 0, "neutral_tokens": 100,
        "paragraph_lengths": [200,200], "stopword_ppm": 0, "location_tokens": ["México","CDMX"], "target_region": "México",
        "h1_tokens": ["seo","técnico"], "h2_tokens": ["seo","técnico"], "h3_tokens": ["seo","técnico"],
        "title_tokens": ["guía","seo"], "clickbait_patterns": ["impactante"],
        "product_description": "producto color tamaño material garantía " * 20, "attribute_matrix": ["color","tamaño","material","garantía"],
        "review_text": "Reseña detallada y verificable de experiencia real.", "metadata_signals": [False,False],
        "local_graph_edges": ["a-b","b-c"], "reference_graph_edges": ["a-b","b-c"],
        "above_fold_images": 10, "high_priority_images": 10, "href_attributes": 10, "double_slash_count": 0,
        "nav_count": 2, "nav_with_role_count": 2, "critical_css_bytes": 100, "total_css_bytes": 100,
        "below_fold_images": 10, "lazy_images": 10, "script_count": 10, "deferred_script_count": 10,
        "dev_comment_count": 0, "html_bytes": 1000, "svg_bytes_before": 100, "svg_bytes_after": 10,
        "third_party_domains": ["cdn.example"], "prefetched_domains": ["cdn.example"], "max_dom_depth": 4, "allowed_dom_depth": 5,
        "class_bytes_before": 100, "class_bytes_after": 10, "head_priority_items": 10, "head_priority_correct": 10,
        "dom_id_count": 10, "unique_dom_id_count": 10, "microdata_items": 10, "jsonld_items": 10,
        "expected_locale": "es-MX", "actual_locale": "es-MX", "critical_fonts": ["font-a"], "preloaded_fonts": ["font-a"],
        "images_requiring_alt": 10, "images_with_verified_alt": 10, "menu_link_count": 20, "allowed_menu_links": 50,
        "expected_cache_directives": ["public","max-age"], "actual_cache_directives": ["public","max-age"],
        "target_blank_links": 10, "safe_rel_links": 10, "server_signature_count": 1, "exposed_signature_count": 0,
        "rtl_blocks": 2, "rtl_blocks_with_dir": 2, "code_blocks": 2, "typed_code_blocks": 2,
        "inline_js_bytes_before": 100, "inline_js_bytes_after": 10, "legacy_images": 10, "picture_images": 10,
        "claimed_googlebot": True, "request_asn": 15169, "dns_verified": True, "user_agent_present": True,
        "ip_reputation_ppm": 1_000_000, "spoof_signature_count": 0, "redirect_chain_count": 2, "repeated_target_count": 0,
        "session_token_present": True, "kv_session_match": True, "server_load_ppm": 900_000, "http_status": 503, "retry_after_present": True,
        "query_signal_count": 1, "body_signal_count": 0, "blocked_signal_count": 1, "execution_time_micros": 100, "budget_micros": 100,
        "origin_status_code": 200, "expected_status_code": 200, "tls_version_code": 13, "minimum_tls_version_code": 12,
        "payload_hash_present": True, "signature_valid": True, "is_internal_search": True, "noindex_present": True,
        "identity_hash": "sha256:test", "compressed_roundtrip_hash_match": True, "microdata_error_count": 0, "microdata_item_count": 10,
        "emergency_mode": True, "robots_restrictive": True, "request_count": 100, "window_seconds": 60, "limit_count": 100,
        "range_request": True, "chunk_alignment_ppm": 1_000_000, "tenant_present": True, "cross_tenant_key_count": 0,
        "control_byte_count": 10, "purged_byte_count": 10, "h2_count": 2, "duplicate_h2_count": 0,
        "subrequest_count": 10, "quota_limit": 100, "timing_metric_count": 5, "timing_header_count": 5,
        "country_present": True, "hreflang_match": True, "mobile_dom_hash": "same", "desktop_dom_hash": "same",
        "query_key_count": 10, "spam_key_count": 0, "open_sockets_before": 5, "open_sockets_after": 0,
        "keyword_count": 10, "canonical_assignment_count": 10, "vector_count": 10, "overlap_conflict_count": 0,
        "edge_attempt_count": 10, "edge_commit_count": 10, "redirect_hops_before": 10, "redirect_hops_after": 0,
        "node_count": 10, "converged_node_count": 10, "observed_value": 100, "capacity_value": 1000, "baseline_value": 100,
        "failure_count": 10, "sample_count": 100, "recovered_count": 10, "max_bucket_value": 100, "median_bucket_value": 100,
        "age_seconds": 0, "max_age_seconds": 100, "blocked_count": 0, "active_count": 100, "valid_count": 100,
        "retry_attempts": 0, "rollback_detected": False,
    }
    if field not in defaults:
        raise KeyError(field)
    return defaults[field]


def rich_payload() -> Dict[str, Any]:
    payload: Dict[str, Any] = {"semantic_eat_records": [], "html_stream_records": [], "edge_gateway_records": [], "neon_relational_records": []}
    for module_id, spec in MODULE_SPECS.items():
        row = {"module_id": module_id}
        for field in spec["input_fields"]:
            row[field] = _good_value(field)
        payload[spec["dataset_key"]].append(row)
    return payload

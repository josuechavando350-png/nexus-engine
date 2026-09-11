from __future__ import annotations
from typing import Any, Dict

SOURCE_RANGE=(1401,1600)
TARGET_RANGE=(401,600)
TOTAL_NEW_MODULES=200

SEMANTIC_OPS = [('author_credential_completeness', ['bio_text', 'trust_entities'], 850000), ('author_entity_proximity', ['entity_a', 'entity_b', 'distance'], 750000), ('author_bio_topic_alignment', ['author_bio_tokens', 'page_topic_tokens'], 780000), ('citation_trusted_source_ratio', ['outbound_links', 'whitelist_domains'], 900000), ('semantic_entity_saturation', ['body_text', 'target_entities'], 650000), ('ymyl_medical_claim_validator', ['claims', 'scientific_consensus_evidence'], 950000), ('financial_transparency_score', ['disclosure_text', 'regulatory_keywords'], 880000), ('brand_coherence_index', ['title_entities', 'body_entities'], 700000), ('entity_synonym_expansion', ['raw_tokens', 'synonym_graph'], 800000), ('topical_authority_coverage', ['content_nodes', 'niche_vector'], 820000), ('spacy_ner_confidence_filter', ['ner_tokens', 'confidence_ppm'], 890000), ('wikipedia_sameas_linker', ['detected_entities', 'knowledge_graph_snapshot'], 920000), ('lexical_diversity_score', ['unique_tokens', 'total_tokens'], 600000), ('intent_commercial_density', ['intent_markers', 'total_sentences'], 720000), ('intent_informational_purity', ['informative_verbs', 'total_verbs'], 800000), ('faq_schema_extractor', ['question_blocks', 'answer_blocks'], 850000), ('text_readability_flesch_es', ['syllables', 'sentences', 'words'], 750000), ('sentiment_neutrality_guard', ['positive_tokens', 'negative_tokens', 'neutral_tokens'], 900000), ('thin_content_vector_check', ['paragraph_lengths', 'stopword_ppm'], 680000), ('geographic_entity_isolation', ['location_tokens', 'target_region'], 850000), ('heading_semantic_progression', ['h1_tokens', 'h2_tokens', 'h3_tokens'], 800000), ('clickbait_headline_filter', ['title_tokens', 'clickbait_patterns'], 930000), ('ecom_product_attribute_extractor', ['product_description', 'attribute_matrix'], 850000), ('user_review_spam_detector', ['review_text', 'metadata_signals'], 940000), ('knowledge_graph_divergence', ['local_graph_edges', 'reference_graph_edges'], 870000)]

HTML_OPS = [('fetchpriority_above_fold', ['above_fold_images', 'high_priority_images'], 920000), ('trailing_slash_normalizer', ['href_attributes', 'double_slash_count'], 950000), ('aria_role_injector', ['nav_count', 'nav_with_role_count'], 880000), ('css_inline_critical_balancer', ['critical_css_bytes', 'total_css_bytes'], 900000), ('lazy_loading_viewport_defer', ['below_fold_images', 'lazy_images'], 850000), ('script_async_defer_rewriter', ['script_count', 'deferred_script_count'], 910000), ('html_comment_stripper', ['dev_comment_count', 'html_bytes'], 990000), ('svg_inline_compressor', ['svg_bytes_before', 'svg_bytes_after'], 800000), ('dns_prefetch_injector', ['third_party_domains', 'prefetched_domains'], 870000), ('dom_nesting_flatten_agent', ['max_dom_depth', 'allowed_dom_depth'], 750000), ('css_utility_class_compactor', ['class_bytes_before', 'class_bytes_after'], 830000), ('head_tag_reordering_validator', ['head_priority_items', 'head_priority_correct'], 960000), ('w3c_duplicate_id_cleaner', ['dom_id_count', 'unique_dom_id_count'], 940000), ('schema_microdata_to_jsonld', ['microdata_items', 'jsonld_items'], 890000), ('html_lang_attribute_guard', ['expected_locale', 'actual_locale'], 990000), ('font_preload_subset_injector', ['critical_fonts', 'preloaded_fonts'], 920000), ('image_semantic_alt_generator', ['images_requiring_alt', 'images_with_verified_alt'], 780000), ('link_farming_menu_limiter', ['menu_link_count', 'allowed_menu_links'], 850000), ('cache_control_header_matching', ['expected_cache_directives', 'actual_cache_directives'], 950000), ('noopener_target_blank_forcer', ['target_blank_links', 'safe_rel_links'], 990000), ('server_signature_remover', ['server_signature_count', 'exposed_signature_count'], 980000), ('rtl_direction_bidi_handler', ['rtl_blocks', 'rtl_blocks_with_dir'], 900000), ('code_block_semantic_wrapper', ['code_blocks', 'typed_code_blocks'], 850000), ('inline_js_minifier_on_fly', ['inline_js_bytes_before', 'inline_js_bytes_after'], 880000), ('responsive_picture_elementizer', ['legacy_images', 'picture_images'], 800000)]

EDGE_OPS = [('asn_googlebot_validator', ['claimed_googlebot', 'request_asn', 'dns_verified'], 999999), ('user_agent_spoof_detector', ['user_agent_present', 'ip_reputation_ppm', 'spoof_signature_count'], 995000), ('loop_redirect_breaker', ['redirect_chain_count', 'repeated_target_count'], 990000), ('cloudflare_kv_session_verifier', ['session_token_present', 'kv_session_match'], 950000), ('retry_after_header_generator', ['server_load_ppm', 'http_status', 'retry_after_present'], 900000), ('xss_injection_perimeter_filter', ['query_signal_count', 'body_signal_count', 'blocked_signal_count'], 980000), ('edge_latency_fail_open_timer', ['execution_time_micros', 'budget_micros'], 990000), ('http_malformed_status_corrector', ['origin_status_code', 'expected_status_code'], 960000), ('tls_version_security_enforcer', ['tls_version_code', 'minimum_tls_version_code'], 990000), ('suite_cryptographic_signer', ['payload_hash_present', 'signature_valid'], 999000), ('search_results_noindex_applier', ['is_internal_search', 'noindex_present'], 930000), ('gzip_brotli_parity_aligner', ['identity_hash', 'compressed_roundtrip_hash_match'], 950000), ('microdata_syntax_preflight', ['microdata_error_count', 'microdata_item_count'], 890000), ('dynamic_robots_txt_override', ['emergency_mode', 'robots_restrictive'], 910000), ('high_velocity_scraper_limiter', ['request_count', 'window_seconds', 'limit_count'], 970000), ('media_streaming_chunk_optimizer', ['range_request', 'chunk_alignment_ppm'], 850000), ('cloudflare_kv_isolation_check', ['tenant_present', 'cross_tenant_key_count'], 999999), ('hidden_control_byte_purger', ['control_byte_count', 'purged_byte_count'], 940000), ('duplicate_h2_url_rewriter', ['h2_count', 'duplicate_h2_count'], 880000), ('worker_subrequest_quota_monitor', ['subrequest_count', 'quota_limit'], 990000), ('metric_execution_header_injector', ['timing_metric_count', 'timing_header_count'], 800000), ('geo_ip_redirect_validator', ['country_present', 'hreflang_match'], 920000), ('mobile_desktop_parity_assert', ['mobile_dom_hash', 'desktop_dom_hash'], 950000), ('url_parameter_spam_scrub', ['query_key_count', 'spam_key_count'], 960000), ('perimeter_session_close_orchestrator', ['open_sockets_before', 'open_sockets_after'], 999000)]

DB_BASE_OPS = [('keyword_cluster_intersection', ['keyword_count', 'canonical_assignment_count'], 950000), ('semantic_vector_overlap_detector', ['vector_count', 'overlap_conflict_count'], 920000), ('interlinking_authority_writer', ['edge_attempt_count', 'edge_commit_count'], 880000), ('slug_history_redirect_consolidator', ['redirect_hops_before', 'redirect_hops_after'], 960000), ('static_pagerank_batch_calculator', ['node_count', 'converged_node_count'], 900000)]

DB_CONCEPTS = ['index_bloat', 'query_plan', 'lock_contention', 'vacuum_trigger', 'partition_split', 'foreign_key_check', 'tuple_density', 'wal_latency', 'transaction_isolation', 'buffer_cache', 'sequence_exhaustion', 'btree_fragmentation', 'hot_standby_sync', 'cascading_delete', 'constraint_validation']

DB_DIMENSIONS = [('utilization', ['observed_value', 'capacity_value'], 'ratio'), ('deviation', ['observed_value', 'baseline_value'], 'deviation'), ('failure_rate', ['failure_count', 'sample_count'], 'ratio'), ('recovery_rate', ['recovered_count', 'failure_count'], 'ratio'), ('skew', ['max_bucket_value', 'median_bucket_value'], 'skew'), ('staleness', ['age_seconds', 'max_age_seconds'], 'ratio'), ('contention', ['blocked_count', 'active_count'], 'ratio'), ('integrity', ['valid_count', 'sample_count'], 'ratio')]

MODULE_SPECS: Dict[str, Dict[str, Any]] = {}

def _add(start: int, rows, family: str, dataset: str) -> None:
    for offset, (operation, fields, threshold_ppm) in enumerate(rows):
        source_number = start + offset
        target_number = source_number - 1000
        MODULE_SPECS[f"M{target_number}"] = {
            "source_module": f"M{source_number}",
            "operation": operation,
            "family": family,
            "dataset_key": dataset,
            "input_fields": tuple(fields),
            "threshold_ppm": threshold_ppm,
        }

_add(1401, SEMANTIC_OPS, "SEMANTIC_EAT", "semantic_eat_records")
_add(1426, HTML_OPS, "HTML_STREAM", "html_stream_records")
_add(1451, EDGE_OPS, "EDGE_GATEWAY", "edge_gateway_records")
_add(1476, DB_BASE_OPS, "NEON_RELATIONAL", "neon_relational_records")

_generated = []
for concept_index, concept in enumerate(DB_CONCEPTS):
    for dimension, fields, formula in DB_DIMENSIONS:
        _generated.append((concept, dimension, tuple(fields), formula, 850000, 980000 - concept_index * 7000))

for offset, (concept, dimension, fields, formula, base_threshold, weight_ppm) in enumerate(_generated[:119]):
    source_number = 1481 + offset
    target_number = source_number - 1000
    MODULE_SPECS[f"M{target_number}"] = {
        "source_module": f"M{source_number}",
        "operation": f"{concept}_{dimension}_audit",
        "family": "NEON_RELATIONAL",
        "dataset_key": "neon_relational_records",
        "input_fields": fields,
        "threshold_ppm": min(999000, base_threshold + (offset % 8) * 15000),
        "concept": concept,
        "dimension": dimension,
        "formula": formula,
        "concept_weight_ppm": weight_ppm,
    }

MODULE_SPECS["M600"] = {
    "source_module": "M1600",
    "operation": "deadlock_retry_budget",
    "family": "NEON_RELATIONAL",
    "dataset_key": "neon_relational_records",
    "input_fields": ("retry_attempts", "rollback_detected"),
    "threshold_ppm": 950000,
    "concept": "deadlock",
    "dimension": "retry_budget",
    "formula": "retry_budget",
}

TARGET_MODULES = tuple(f"M{i}" for i in range(401,601))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1401,1601))

if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("M401-M600 manifest is incomplete or out of order")
if len({spec["source_module"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("source modules must be unique")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("operations must be unique")

def source_to_target_map() -> Dict[str, str]:
    return {spec["source_module"]: target for target, spec in MODULE_SPECS.items()}

from __future__ import annotations
from typing import Any, Dict, Sequence, Tuple

SEMANTIC_OPS = [
    ('entity_cooccurrence_alignment',['entity_hits','entity_opportunities'],920000,'coverage_count'),
    ('longtail_evidence_coverage',['required_longtail_terms','observed_body_terms'],880000,'subset'),
    ('intent_cluster_separation',['cluster_a_terms','cluster_b_terms'],950000,'separation'),
    ('paid_organic_intent_overlap',['paid_intent_terms','organic_body_terms'],900000,'overlap'),
    ('competitor_gap_evidence_coverage',['gap_entities','local_entities'],850000,'subset'),
    ('query_intent_term_coverage',['required_intent_terms','observed_terms'],900000,'subset'),
    ('commercial_modifier_alignment',['expected_modifiers','observed_modifiers'],910000,'subset'),
    ('longtail_specificity_guard',['specific_tokens','total_tokens'],900000,'ratio_score'),
    ('paid_query_body_alignment',['paid_query_terms','body_terms'],900000,'overlap'),
    ('keyword_semantic_collision_guard',['keyword_count','collision_count'],930000,'defect_rate'),
    ('organic_term_distribution',['bucket_counts_ppm'],900000,'ppm_min'),
    ('ad_landing_message_match',['message_terms','landing_terms'],920000,'overlap'),
    ('phrase_variant_coverage',['required_variants','observed_variants'],900000,'subset'),
    ('negative_keyword_collision',['query_count','negative_collision_count'],950000,'defect_rate'),
    ('entity_modifier_coherence',['entity_modifier_pairs','valid_pairs'],900000,'coverage_count'),
    ('conversion_term_context',['conversion_terms','context_terms'],900000,'overlap'),
    ('search_term_cluster_balance',['largest_cluster_count','smallest_cluster_count'],850000,'inverse_balance'),
    ('high_intent_evidence_ratio',['high_intent_count','evidence_count'],900000,'ratio_score'),
    ('semantic_anchor_distribution',['anchor_bucket_ppm'],850000,'ppm_min'),
    ('intent_conflict_detector',['intent_signal_count','conflict_count'],950000,'defect_rate'),
    ('query_body_proximity',['proximity_scores_ppm'],900000,'ppm_mean'),
    ('phrase_repetition_guard',['phrase_count','repeated_phrase_count'],930000,'defect_rate'),
    ('topic_modifier_coverage',['required_topic_modifiers','observed_topic_modifiers'],900000,'subset'),
    ('paid_organic_gap_score',['paid_terms','organic_terms'],850000,'overlap'),
    ('intent_evidence_completeness',['required_evidence','observed_evidence'],900000,'subset'),
]

HTML_OPS = [
    ('viewport_critical_asset_coverage',['critical_assets','prioritized_assets'],980000,'coverage_count'),
    ('snippet_title_context_alignment',['title_terms','h1_terms'],940000,'overlap'),
    ('tenant_layout_isolation',['tenant_nodes','cross_tenant_nodes'],960000,'defect_rate'),
    ('above_fold_preload_coverage',['above_fold_assets','preloaded_assets'],920000,'coverage_count'),
    ('render_budget_guard',['render_cost_units','render_budget_units'],930000,'budget'),
    ('critical_asset_order',['critical_assets','correctly_ordered_assets'],930000,'coverage_count'),
    ('async_script_coverage',['noncritical_scripts','deferred_scripts'],910000,'coverage_count'),
    ('font_display_guard',['font_faces','safe_font_faces'],900000,'coverage_count'),
    ('image_dimension_guard',['content_images','dimensioned_images'],930000,'coverage_count'),
    ('layout_shift_reservation',['layout_media','reserved_media'],940000,'coverage_count'),
    ('viewport_resource_budget',['viewport_bytes','viewport_budget_bytes'],900000,'budget'),
    ('css_rule_scope_coverage',['scoped_rules','total_rules'],900000,'ratio_score'),
    ('html_chunk_size_guard',['chunk_bytes','chunk_budget_bytes'],900000,'budget'),
    ('head_metadata_completeness',['required_meta_keys','observed_meta_keys'],950000,'subset'),
    ('preload_as_match',['preload_count','valid_as_count'],950000,'coverage_count'),
    ('modulepreload_coverage',['module_dependencies','modulepreloaded_dependencies'],900000,'coverage_count'),
    ('stylesheet_media_scope',['stylesheets','media_scoped_stylesheets'],900000,'coverage_count'),
    ('image_decoding_coverage',['decode_candidates','async_decoding_images'],850000,'coverage_count'),
    ('iframe_lazy_coverage',['below_fold_iframes','lazy_iframes'],900000,'coverage_count'),
    ('resource_hint_dedupe',['resource_hint_count','duplicate_resource_hint_count'],950000,'defect_rate'),
    ('duplicate_meta_guard',['meta_tag_count','duplicate_meta_count'],950000,'defect_rate'),
    ('base_href_guard',['expected_base_href','actual_base_href'],990000,'equality'),
    ('form_label_coverage',['form_controls','labelled_controls'],950000,'coverage_count'),
    ('semantic_landmark_coverage',['required_landmarks','observed_landmarks'],900000,'subset'),
    ('hydration_marker_integrity',['hydration_markers','valid_hydration_markers'],950000,'coverage_count'),
]

EDGE_OPS = [
    ('tenant_route_assignment_consistency',['route_assignments','valid_route_assignments'],999950,'coverage_count'),
    ('concurrency_cache_capacity_guard',['concurrency_count','cache_capacity_count'],990000,'budget'),
    ('canonical_assignment_gate',['canonical_checks','valid_canonical_checks'],995000,'coverage_count'),
    ('request_route_table_match',['route_keys','matched_route_keys'],950000,'coverage_count'),
    ('cache_key_tenant_isolation',['cache_key_count','cross_tenant_key_count'],999000,'defect_rate'),
    ('concurrency_backpressure_guard',['active_requests','request_capacity'],950000,'budget'),
    ('retry_budget_guard',['retry_attempts','retry_budget'],950000,'budget'),
    ('redirect_status_guard',['redirect_count','valid_redirect_status_count'],960000,'coverage_count'),
    ('canonical_redirect_target_match',['expected_targets','observed_targets'],980000,'subset'),
    ('header_size_budget',['header_bytes','header_budget_bytes'],950000,'budget'),
    ('request_body_size_guard',['body_bytes','body_budget_bytes'],950000,'budget'),
    ('edge_cache_freshness',['fresh_cache_entries','cache_entries'],900000,'ratio_score'),
    ('origin_timeout_budget',['origin_latency_units','origin_budget_units'],950000,'budget'),
    ('subrequest_budget',['subrequest_count','subrequest_limit'],990000,'budget'),
    ('kv_namespace_isolation',['kv_key_count','cross_namespace_key_count'],999000,'defect_rate'),
    ('path_normalization_guard',['path_count','normalized_path_count'],980000,'coverage_count'),
    ('query_parameter_allowlist',['query_key_count','allowed_query_key_count'],950000,'coverage_count'),
    ('compression_negotiation_guard',['compressible_responses','negotiated_responses'],950000,'coverage_count'),
    ('vary_header_consistency',['vary_checks','valid_vary_checks'],950000,'coverage_count'),
    ('hsts_policy_guard',['https_responses','hsts_responses'],990000,'coverage_count'),
    ('tls_minimum_version',['tls_version_code','minimum_tls_version_code'],990000,'minimum'),
    ('origin_status_preservation',['status_checks','preserved_status_checks'],960000,'coverage_count'),
    ('error_page_symmetry',['user_error_hash','crawler_error_hash'],999000,'equality'),
    ('edge_response_hash_parity',['mobile_response_hash','desktop_response_hash'],950000,'equality'),
]

DB_OPS = [
    ('cooccurrence_matrix_integrity',['matrix_rows','valid_matrix_rows'],960000,'coverage_count'),
    ('roi_weight_evidence_calculator',['click_conversion_weight_ppm','organic_pagerank_ppm'],920000,'ppm_pair_mean'),
    ('tenant_lock_contention_audit',['lock_requests_count','blocked_lock_count'],990000,'defect_rate'),
    ('index_bloat_utilization',['used_pages','allocated_pages'],850000,'ratio_score'),
    ('query_plan_regression',['plan_checks','regressed_plan_count'],930000,'defect_rate'),
    ('lock_contention_rate',['active_transactions','blocked_transactions'],930000,'defect_rate'),
    ('vacuum_debt',['dead_tuple_count','vacuum_threshold_count'],900000,'budget'),
    ('partition_balance',['largest_partition_rows','smallest_partition_rows'],850000,'inverse_balance'),
    ('foreign_key_integrity',['foreign_key_checks','valid_foreign_key_checks'],990000,'coverage_count'),
    ('tuple_density',['live_tuple_count','total_tuple_slots'],850000,'ratio_score'),
    ('wal_latency_budget',['wal_latency_units','wal_latency_budget_units'],950000,'budget'),
    ('transaction_isolation_compliance',['transaction_checks','isolation_compliant_checks'],990000,'coverage_count'),
    ('buffer_cache_hit',['cache_hits','cache_lookups'],900000,'ratio_score'),
    ('index_bloat_recovery',['recovered_pages','bloated_pages'],850000,'ratio_score'),
    ('query_plan_stability',['stable_plan_count','plan_sample_count'],930000,'ratio_score'),
    ('lock_contention_recovery',['recovered_locks','blocked_locks'],900000,'ratio_score'),
    ('vacuum_completion',['vacuum_tasks','completed_vacuum_tasks'],900000,'coverage_count'),
    ('partition_skew',['largest_partition_rows','smallest_partition_rows'],850000,'inverse_balance'),
    ('foreign_key_failure',['foreign_key_checks','foreign_key_failures'],990000,'defect_rate'),
    ('tuple_density_deviation',['observed_density_ppm','baseline_density_ppm','tolerance_ppm'],900000,'delta_ppm'),
    ('wal_latency_deviation',['observed_latency_units','baseline_latency_units','tolerance_units'],900000,'delta_int'),
    ('transaction_retry_rate',['transaction_count','retry_transaction_count'],950000,'defect_rate'),
    ('buffer_cache_staleness',['cache_entry_count','stale_cache_entry_count'],950000,'defect_rate'),
    ('index_bloat_integrity',['index_checks','healthy_index_checks'],900000,'coverage_count'),
    ('query_plan_integrity',['plan_checks','valid_plan_checks'],950000,'coverage_count'),
    ('lock_queue_depth',['lock_queue_depth','lock_queue_limit'],950000,'budget'),
]

FOUNDATION_SPECS: Dict[str, Dict[str, Any]] = {}

def _add(start: int, rows: Sequence[Tuple[str, Sequence[str], int, str]], family: str, dataset_key: str) -> None:
    for offset, (operation, fields, threshold_ppm, formula) in enumerate(rows):
        source_number = start + offset
        target_number = source_number - 1000
        FOUNDATION_SPECS[f'M{target_number}'] = {
            'source_module': f'M{source_number}', 'operation': operation, 'family': family,
            'dataset_key': dataset_key, 'input_fields': tuple(fields), 'threshold_ppm': threshold_ppm, 'formula': formula,
        }

_add(1601, SEMANTIC_OPS, 'SEMANTIC_INTENT', 'intent_semantic_records')
_add(1626, HTML_OPS, 'HTML_FOUNDATION', 'html_foundation_records')
_add(1651, EDGE_OPS, 'EDGE_FOUNDATION', 'edge_foundation_records')
_add(1675, DB_OPS, 'RELATIONAL_FOUNDATION', 'relational_foundation_records')

TARGET_MODULES = tuple(f'M{i}' for i in range(601, 701))
SOURCE_MODULES = tuple(f'M{i}' for i in range(1601, 1701))
if tuple(FOUNDATION_SPECS) != TARGET_MODULES:
    raise RuntimeError('M601-M700 foundation manifest incomplete or out of order')
if len({s['source_module'] for s in FOUNDATION_SPECS.values()}) != 100:
    raise RuntimeError('foundation source modules must be unique')
if len({s['operation'] for s in FOUNDATION_SPECS.values()}) != 100:
    raise RuntimeError('foundation operations must be unique')

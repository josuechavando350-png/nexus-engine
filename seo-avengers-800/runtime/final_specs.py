from __future__ import annotations
from typing import Any, Dict, Sequence, Tuple

EDGE_OPS = [
    ('bayesian_tenant_route_confidence',['route_candidates','high_confidence_routes'],999990,'coverage_count'),
    ('edge_cache_concurrency_health',['active_concurrency','cache_capacity'],995000,'budget'),
    ('canonical_perimeter_parity',['canonical_checks','matching_canonical_checks'],999000,'coverage_count'),
    ('crawler_identity_evidence_guard',['claimed_crawler_requests','verified_identity_requests'],999000,'coverage_count'),
    ('mobile_desktop_dom_hash_parity',['mobile_dom_hash','desktop_dom_hash'],990000,'equality'),
    ('mobile_desktop_status_parity',['status_checks','matching_status_checks'],990000,'coverage_count'),
    ('mobile_desktop_canonical_parity',['mobile_canonical','desktop_canonical'],990000,'equality'),
    ('mobile_desktop_hreflang_coverage',['mobile_hreflang','desktop_hreflang'],950000,'overlap'),
    ('mobile_desktop_schema_parity',['mobile_schema_hash','desktop_schema_hash'],990000,'equality'),
    ('mobile_desktop_title_parity',['mobile_title','desktop_title'],990000,'equality'),
    ('mobile_desktop_description_parity',['mobile_description','desktop_description'],990000,'equality'),
    ('mobile_desktop_heading_overlap',['mobile_headings','desktop_headings'],950000,'overlap'),
    ('mobile_desktop_link_count_balance',['larger_link_count','smaller_link_count'],950000,'inverse_balance'),
    ('mobile_desktop_content_overlap',['mobile_tokens','desktop_tokens'],950000,'overlap'),
    ('mobile_desktop_resource_policy_parity',['mobile_resource_policy_hash','desktop_resource_policy_hash'],990000,'equality'),
    ('mobile_desktop_robots_parity',['mobile_robots','desktop_robots'],999000,'equality'),
    ('mobile_desktop_cache_control_parity',['mobile_cache_control','desktop_cache_control'],990000,'equality'),
    ('mobile_desktop_csp_parity',['mobile_csp_hash','desktop_csp_hash'],990000,'equality'),
    ('mobile_desktop_language_parity',['mobile_locale','desktop_locale'],990000,'equality'),
    ('mobile_desktop_viewport_guard',['viewport_checks','valid_viewport_checks'],950000,'coverage_count'),
    ('mobile_desktop_redirect_parity',['mobile_redirect_hash','desktop_redirect_hash'],990000,'equality'),
    ('mobile_desktop_error_body_parity',['mobile_error_hash','desktop_error_hash'],990000,'equality'),
    ('mobile_desktop_structured_data_balance',['larger_schema_count','smaller_schema_count'],950000,'inverse_balance'),
    ('mobile_desktop_final_response_parity',['mobile_final_hash','desktop_final_hash'],999000,'equality'),
]

DB_OPS = [
    ('bayes_cooccurrence_matrix_integrity',['matrix_rows','valid_matrix_rows'],965000,'coverage_count'),
    ('roi_evidence_weight_consistency',['click_conversion_weight_ppm','organic_pagerank_ppm'],930000,'ppm_pair_mean'),
    ('bayes_index_bloat_risk',['used_pages','allocated_pages'],850000,'ratio_score'),
    ('bayes_query_plan_stability',['stable_plan_count','plan_sample_count'],930000,'ratio_score'),
    ('bayes_lock_contention_risk',['active_transactions','blocked_transactions'],950000,'defect_rate'),
    ('bayes_vacuum_trigger_readiness',['vacuum_candidates','ready_vacuum_candidates'],900000,'coverage_count'),
    ('bayes_partition_split_balance',['largest_partition_rows','smallest_partition_rows'],850000,'inverse_balance'),
    ('bayes_foreign_key_integrity',['foreign_key_checks','valid_foreign_key_checks'],990000,'coverage_count'),
    ('bayes_tuple_density_health',['live_tuple_count','total_tuple_slots'],850000,'ratio_score'),
    ('bayes_wal_latency_health',['wal_latency_units','wal_latency_budget_units'],950000,'budget'),
    ('bayes_transaction_isolation_health',['transaction_checks','isolation_compliant_checks'],990000,'coverage_count'),
    ('bayes_buffer_cache_health',['cache_hits','cache_lookups'],900000,'ratio_score'),
    ('bayes_index_bloat_recovery',['recovered_pages','bloated_pages'],850000,'ratio_score'),
    ('bayes_query_plan_deviation',['plan_observed_cost','plan_baseline_cost','plan_tolerance_cost'],900000,'delta_int'),
    ('bayes_lock_contention_recovery',['recovered_locks','blocked_locks'],900000,'ratio_score'),
    ('bayes_vacuum_staleness',['vacuum_age_units','vacuum_age_budget_units'],900000,'budget'),
    ('bayes_partition_skew',['largest_partition_rows','smallest_partition_rows'],850000,'inverse_balance'),
    ('bayes_foreign_key_failure_rate',['foreign_key_checks','foreign_key_failures'],990000,'defect_rate'),
    ('bayes_tuple_density_deviation',['observed_density_ppm','baseline_density_ppm','tolerance_ppm'],900000,'delta_ppm'),
    ('bayes_wal_latency_deviation',['observed_latency_units','baseline_latency_units','tolerance_units'],900000,'delta_int'),
    ('bayes_transaction_retry_health',['transaction_count','retry_transaction_count'],950000,'defect_rate'),
    ('bayes_buffer_cache_staleness',['cache_entry_count','stale_cache_entry_count'],950000,'defect_rate'),
    ('bayes_index_integrity',['index_checks','healthy_index_checks'],950000,'coverage_count'),
    ('bayes_plan_integrity',['plan_checks','valid_plan_checks'],950000,'coverage_count'),
    ('bayes_lock_queue_budget',['lock_queue_depth','lock_queue_limit'],950000,'budget'),
    ('deadlock_retry_budget',['retry_attempts','retry_limit'],955000,'budget'),
]

FINAL_SPECS: Dict[str, Dict[str, Any]] = {}

def _add(start: int, rows: Sequence[Tuple[str, Sequence[str], int, str]], family: str, dataset_key: str) -> None:
    for offset, (operation, fields, threshold_ppm, formula) in enumerate(rows):
        source_number = start + offset
        target_number = source_number - 1000
        FINAL_SPECS[f'M{target_number}'] = {
            'source_module': f'M{source_number}', 'operation': operation, 'family': family,
            'dataset_key': dataset_key, 'input_fields': tuple(fields), 'threshold_ppm': threshold_ppm, 'formula': formula,
        }

_add(1751, EDGE_OPS, 'EDGE_PARITY', 'edge_parity_records')
_add(1775, DB_OPS, 'RELATIONAL_BAYES', 'relational_bayes_records')

TARGET_MODULES = tuple(f'M{i}' for i in range(751, 801))
SOURCE_MODULES = tuple(f'M{i}' for i in range(1751, 1801))
if tuple(FINAL_SPECS) != TARGET_MODULES:
    raise RuntimeError('M751-M800 final manifest incomplete or out of order')
if len({s['source_module'] for s in FINAL_SPECS.values()}) != 50:
    raise RuntimeError('final source modules must be unique')
if len({s['operation'] for s in FINAL_SPECS.values()}) != 50:
    raise RuntimeError('final operations must be unique')

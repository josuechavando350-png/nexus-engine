from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import InvalidData, normalize_content_documents, normalize_local_records, normalize_search_records
from .kernel_search import (
    _search_band_opportunity, _search_pattern_share, _search_query_page_degree,
    _search_page_query_degree, _search_pareto_frontier, _search_gini,
    _search_tensor, _search_ctr_confidence, _search_lift,
)
from .kernel_local import (
    _nap_content, _local_field_quorum, _local_joint_presence, _query_entity_alignment,
    _local_source_id_uniqueness, _local_source_count, _local_complete_share,
    _local_nap_geo_corroboration, _local_nap_geo_joint_outliers,
    _local_group_geo_disagreement, _local_entity_content_metric,
)
from .kernel_content import (
    _content_term_doc_coverage, _content_term_density, _content_term_gini,
    _content_pair_cooccurrence, _content_pair_proximity, _content_doorway,
    _content_repetition, _content_thin, _content_unique_value, _content_unique_shingle,
    _content_local_fact_support, _content_nap_conflict, _content_allowed_term_guard,
    _query_only_page_risk, _commercial_intent_value, _local_intent_identity,
    _refresh_evidence, _predecessor_policy, _scaled_cardinality, _information_gain,
    _brand_identity_conflict, _phone_identity_conflict, _address_identity_conflict,
    _whitehat_gate,
)
from .kernel_twin import (
    twin_query_content_alignment, twin_longtail_geometry, twin_service_location_portfolio,
    twin_economic_priority, twin_strategic_portfolio,
)
from .kernel_proof import (
    proof_operation_health, proof_bundle_health, search_content_observation_readiness,
    demand_weighted_proof_risk, indexation_readiness_guard, indexation_readiness_release_gate,
)
from .kernel_authority import (
    authority_page_impression_concentration, authority_page_click_concentration,
    authority_query_fragmentation, authority_impression_weighted_fragmentation,
    authority_page_query_breadth, authority_page_intent_mixing,
    authority_demand_orphan_content_gap, authority_query_content_edge_support,
    authority_query_content_jaccard, authority_local_identity_support,
    authority_brand_nonbrand_bridge, authority_zero_click_demand_gap,
    authority_first_page_underclick_gap, authority_position_weighted_visibility,
    authority_page_demand_gini, authority_query_demand_gini,
    authority_pareto_page_efficiency, authority_bipartite_component_health,
    authority_page_pair_query_overlap, authority_service_location_cell_fragmentation,
)
from .kernel_conversion import (
    conversion_impression_share, conversion_click_share, conversion_ctr_health,
    conversion_zero_click_health, conversion_top10_visibility_share, conversion_rank_gap_health,
    conversion_content_support, conversion_identity_support, conversion_page_specialization,
    conversion_landing_concentration_health, conversion_query_breadth_share,
    conversion_longtail_impression_share, conversion_lead_priority, conversion_close_priority,
    conversion_composed_priority, conversion_zero_click_lead_priority,
    conversion_rank_gap_lead_priority, conversion_content_gap_lead_priority,
)
from .kernel_release import growth_release_guard, growth_release_gate

def _normalize_input_for_kernel(spec: Mapping[str, Any], payload: Mapping[str, Any]) -> Any:
    dataset = spec["dataset_key"]
    if dataset == "search_performance_records":
        rows, invalid = normalize_search_records(payload.get(dataset, []))
        return {"records": rows, "invalid_records_count": invalid}
    if dataset == "content_documents":
        rows, invalid = normalize_content_documents(payload.get(dataset, []))
        return {"records": rows, "invalid_records_count": invalid}
    if dataset == "local_business_records":
        rows, invalid = normalize_local_records(payload.get(dataset, []))
        return {"records": rows, "invalid_records_count": invalid}
    if dataset == "upstream_evidence":
        raw = payload.get(dataset, [])
        if not isinstance(raw, list):
            raise InvalidData("upstream_evidence_must_be_list")
        return {"records": list(raw), "invalid_records_count": 0}
    if dataset == "MULTI":
        search, search_invalid = normalize_search_records(payload.get("search_performance_records", []))
        documents, content_invalid = normalize_content_documents(payload.get("content_documents", []))
        local, local_invalid = normalize_local_records(payload.get("local_business_records", []))
        funnel = payload.get("revenue_funnel_records", [])
        decay = payload.get("content_decay_records", [])
        upstream = payload.get("upstream_evidence", [])
        if not isinstance(funnel, list):
            raise InvalidData("revenue_funnel_records_must_be_list")
        if not isinstance(decay, list):
            raise InvalidData("content_decay_records_must_be_list")
        if not isinstance(upstream, list):
            raise InvalidData("upstream_evidence_must_be_list")
        return {
            "search_performance_records": search,
            "content_documents": documents,
            "local_business_records": local,
            "revenue_funnel_records": list(funnel),
            "content_decay_records": list(decay),
            "upstream_evidence_raw": list(upstream),
            "invalid_records_count": search_invalid + content_invalid + local_invalid,
        }
    raw = payload.get(dataset, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{dataset}_must_be_list")
    return {"records": raw, "invalid_records_count": 0}

_DISPATCH = {
    "search_band_opportunity": _search_band_opportunity,
    "search_pattern_share": _search_pattern_share,
    "search_query_page_degree": _search_query_page_degree,
    "search_page_query_degree": _search_page_query_degree,
    "search_pareto_frontier": _search_pareto_frontier,
    "search_gini_concentration": _search_gini,
    "search_service_location_tensor": _search_tensor,
    "search_ctr_confidence": _search_ctr_confidence,
    "search_subset_lift": lambda s,n,c: _search_lift(s,n,c,intersection=False),
    "search_intersection_lift": lambda s,n,c: _search_lift(s,n,c,intersection=True),
    "nap_content_corroboration": _nap_content,
    "local_field_quorum": lambda s,n,c: _local_field_quorum(s,n,c,outliers=False),
    "local_field_outliers": lambda s,n,c: _local_field_quorum(s,n,c,outliers=True),
    "local_joint_presence": _local_joint_presence,
    "query_entity_alignment": _query_entity_alignment,
    "local_source_id_uniqueness": _local_source_id_uniqueness,
    "local_source_count": _local_source_count,
    "local_complete_record_share": _local_complete_share,
    "local_nap_geo_corroboration": _local_nap_geo_corroboration,
    "local_nap_geo_joint_outliers": _local_nap_geo_joint_outliers,
    "local_address_geo_disagreement": lambda s,n,c: _local_group_geo_disagreement(s,n,c,"address"),
    "local_phone_geo_disagreement": lambda s,n,c: _local_group_geo_disagreement(s,n,c,"phone"),
    "local_entity_content_metric": _local_entity_content_metric,
    "content_term_document_coverage": _content_term_doc_coverage,
    "content_term_corpus_density": _content_term_density,
    "content_term_distribution_gini": _content_term_gini,
    "content_pair_cooccurrence": _content_pair_cooccurrence,
    "content_pair_proximity": _content_pair_proximity,
    "content_doorway_similarity_guard": _content_doorway,
    "content_location_swap_guard": lambda s,n,c: _content_doorway(s,n,c,"local_location_terms"),
    "content_service_swap_guard": lambda s,n,c: _content_doorway(s,n,c,"local_service_terms"),
    "content_repetition_guard": _content_repetition,
    "content_thin_value_guard": _content_thin,
    "content_unique_value_guard": _content_unique_value,
    "content_unique_shingle_guard": _content_unique_shingle,
    "content_local_fact_support_guard": _content_local_fact_support,
    "content_nap_conflict_guard": _content_nap_conflict,
    "content_allowed_term_guard": _content_allowed_term_guard,
    "query_only_page_risk_guard": _query_only_page_risk,
    "commercial_intent_value_guard": _commercial_intent_value,
    "local_intent_identity_guard": lambda s,n,c: _local_intent_identity(s,n,c,near_me=False),
    "near_me_location_evidence_guard": lambda s,n,c: _local_intent_identity(s,n,c,near_me=True),
    "refresh_evidence_sufficiency_guard": _refresh_evidence,
    "predecessor_policy_regression_guard": _predecessor_policy,
    "content_scaled_cardinality_guard": _scaled_cardinality,
    "content_information_gain_guard": _information_gain,
    "brand_identity_conflict_guard": _brand_identity_conflict,
    "phone_identity_conflict_guard": _phone_identity_conflict,
    "address_identity_conflict_guard": _address_identity_conflict,
    "twin_query_content_alignment": twin_query_content_alignment,
    "twin_longtail_geometry": twin_longtail_geometry,
    "twin_service_location_portfolio": twin_service_location_portfolio,
    "twin_economic_priority": twin_economic_priority,
    "twin_strategic_portfolio": twin_strategic_portfolio,
    "proof_operation_health": lambda s,n,c: proof_operation_health(s,n["records"],c),
    "proof_bundle_health": lambda s,n,c: proof_bundle_health(s,n["records"],c),
    "search_content_observation_readiness": search_content_observation_readiness,
    "demand_weighted_proof_risk": demand_weighted_proof_risk,
    "authority_page_impression_concentration": authority_page_impression_concentration,
    "authority_page_click_concentration": authority_page_click_concentration,
    "authority_query_fragmentation": authority_query_fragmentation,
    "authority_impression_weighted_fragmentation": authority_impression_weighted_fragmentation,
    "authority_page_query_breadth": authority_page_query_breadth,
    "authority_page_intent_mixing": authority_page_intent_mixing,
    "authority_demand_orphan_content_gap": authority_demand_orphan_content_gap,
    "authority_query_content_edge_support": authority_query_content_edge_support,
    "authority_query_content_jaccard": authority_query_content_jaccard,
    "authority_local_identity_support": authority_local_identity_support,
    "authority_brand_nonbrand_bridge": authority_brand_nonbrand_bridge,
    "authority_zero_click_demand_gap": authority_zero_click_demand_gap,
    "authority_first_page_underclick_gap": authority_first_page_underclick_gap,
    "authority_position_weighted_visibility": authority_position_weighted_visibility,
    "authority_page_demand_gini": authority_page_demand_gini,
    "authority_query_demand_gini": authority_query_demand_gini,
    "authority_pareto_page_efficiency": authority_pareto_page_efficiency,
    "authority_bipartite_component_health": authority_bipartite_component_health,
    "authority_page_pair_query_overlap": authority_page_pair_query_overlap,
    "authority_service_location_cell_fragmentation": authority_service_location_cell_fragmentation,
    "conversion_impression_share": conversion_impression_share,
    "conversion_click_share": conversion_click_share,
    "conversion_ctr_health": conversion_ctr_health,
    "conversion_zero_click_health": conversion_zero_click_health,
    "conversion_top10_visibility_share": conversion_top10_visibility_share,
    "conversion_rank_gap_health": conversion_rank_gap_health,
    "conversion_content_support": conversion_content_support,
    "conversion_identity_support": conversion_identity_support,
    "conversion_page_specialization": conversion_page_specialization,
    "conversion_landing_concentration_health": conversion_landing_concentration_health,
    "conversion_query_breadth_share": conversion_query_breadth_share,
    "conversion_longtail_impression_share": conversion_longtail_impression_share,
    "conversion_lead_priority": conversion_lead_priority,
    "conversion_close_priority": conversion_close_priority,
    "conversion_composed_priority": conversion_composed_priority,
    "conversion_zero_click_lead_priority": conversion_zero_click_lead_priority,
    "conversion_rank_gap_lead_priority": conversion_rank_gap_lead_priority,
    "conversion_content_gap_lead_priority": conversion_content_gap_lead_priority,
}

def evaluate_spec(
    spec: Mapping[str, Any], payload: Mapping[str, Any], config: Mapping[str, Any], *,
    prior_receipts: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[Any, Any, Dict[str, Any]]:
    raw_input = payload if spec["dataset_key"] == "MULTI" else payload.get(spec["dataset_key"], [])
    normalized = _normalize_input_for_kernel(spec, payload)
    kernel = spec["kernel"]
    if kernel == "whitehat_release_gate":
        score, violation, details = _whitehat_gate(spec, normalized, config, prior_receipts)
    elif kernel == "indexation_readiness_guard":
        score, violation, details = indexation_readiness_guard(spec, normalized, config, prior_receipts)
    elif kernel == "indexation_readiness_release_gate":
        score, violation, details = indexation_readiness_release_gate(spec, normalized, config, prior_receipts)
    elif kernel == "growth_release_guard":
        score, violation, details = growth_release_guard(spec, normalized, config, prior_receipts)
    elif kernel == "growth_release_gate":
        score, violation, details = growth_release_gate(spec, normalized, config, prior_receipts)
    else:
        fn = _DISPATCH.get(kernel)
        if fn is None:
            raise InvalidData(f"unsupported_kernel:{kernel}")
        score, violation, details = fn(spec, normalized, config)
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 1_000_000:
        raise InvalidData("kernel_score_out_of_range")
    return raw_input, normalized, {"score_ppm": score, "violation": bool(violation), **details}

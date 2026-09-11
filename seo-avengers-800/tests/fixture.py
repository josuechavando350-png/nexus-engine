from __future__ import annotations

from runtime.manifest import MODULE_SPECS


VALUES = {
    "bayes_inference_topic_linker": {"node_vector_ppm": [1_000_000, 1_000_000], "prior_probability_ppm": 950_000},
    "shannon_entropy_content_scorer": {"token_stream": ["a", "b", "c", "d"], "vocabulary_set": ["a", "b", "c", "d"]},
    "cross_lingual_entity_mapper": {"source_entities": ["abogado", "defensa"], "target_entities": ["lawyer", "defense"], "alignment_pairs": [["abogado", "lawyer"], ["defensa", "defense"]]},
    "temporal_decay_authority_tuner": {"age_seconds": 0, "max_age_seconds": 86_400, "historical_impressions": 100, "impression_reference": 100},
    "sentiment_nuance_lexical_filter": {"adjective_tokens": ["técnico", "preciso"], "bias_lexicon": ["sensacionalista"]},
    "bayes_evidence_posterior_calibrator": {"prior_probability_ppm": 950_000, "evidence_likelihood_ppm": 1_000_000, "counter_likelihood_ppm": 0},
    "topic_prior_smoothing_guard": {"topic_counts": [10, 10, 10, 10], "smoothing_mass": 1},
    "semantic_likelihood_ratio_ranker": {"supporting_evidence_count": 10, "contradicting_evidence_count": 0, "neutral_evidence_count": 0},
    "entity_cooccurrence_posterior_audit": {"prior_probability_ppm": 950_000, "pair_hits": 10, "pair_opportunities": 10},
    "intent_posterior_confidence_gate": {"intent_scores_ppm": [1_000_000, 0, 0]},
    "vocabulary_entropy_balance": {"bucket_token_counts": [10, 10, 10, 10]},
    "lexical_redundancy_guard": {"ngram_hashes": ["h1", "h2", "h3", "h4"]},
    "cross_lingual_bidirectional_coverage": {"forward_aligned_count": 10, "reverse_aligned_count": 8, "source_count": 10, "target_count": 8},
    "evidence_contradiction_guard": {"supported_claims": 10, "contradicted_claims": 0, "unknown_claims": 0},
    "prior_dominance_guard": {"prior_probability_ppm": 950_000, "evidence_count": 10, "minimum_evidence_count": 10},
    "posterior_update_stability": {"posterior_series_ppm": [950_000, 950_000, 950_000]},
    "semantic_cluster_cohesion": {"intra_cluster_similarity_ppm": [1_000_000, 1_000_000, 1_000_000]},
    "entity_transition_consistency": {"valid_transitions": 10, "total_transitions": 10},
    "temporal_evidence_freshness": {"age_seconds_list": [0, 0, 0], "max_age_seconds": 86_400},
    "source_support_coverage": {"claims_total": 10, "claims_with_source": 10},
    "uncertainty_margin_guard": {"top_score_ppm": 1_000_000, "second_score_ppm": 0},
    "claim_posterior_support": {"claim_prior_ppm": 950_000, "support_likelihood_ppm": 1_000_000, "counter_likelihood_ppm": 0},
    "multilingual_term_consistency": {"canonical_terms": ["abogado", "defensa"], "observed_terms": ["lawyer", "defense"], "alignment_pairs": [["abogado", "lawyer"], ["defensa", "defense"]]},
    "semantic_outlier_resistance": {"similarity_scores_ppm": [950_000, 960_000, 970_000], "minimum_inlier_ppm": 900_000},
    "posterior_rank_separation": {"ranked_posterior_ppm": [1_000_000, 700_000, 400_000], "minimum_gap_ppm": 200_000},
    "http3_quic_stream_aligner": {"quic_stream_chunks": 100, "aligned_quic_chunks": 100},
    "path_traversal_double_slash_purger": {"href_buffers": 100, "sanitized_href_buffers": 100},
    "aria_interactive_element_guard": {"interactive_elements": 40, "aria_guarded_elements": 40},
    "critical_css_viewport_splitter": {"viewport_css_rules": 50, "correctly_scoped_rules": 50},
    "lazy_load_noscript_fallback_agent": {"lazy_images_nodes": 20, "noscript_fallbacks": 20},
    "stream_chunk_boundary_validator": {"chunk_boundaries": 64, "valid_chunk_boundaries": 64},
    "partial_head_state_guard": {"head_fragments": 12, "ordered_head_fragments": 12},
    "utf8_boundary_integrity": {"utf8_boundaries": 64, "valid_utf8_boundaries": 64},
    "html_token_resume_guard": {"resume_points": 32, "valid_resume_points": 32},
    "streaming_attribute_quote_guard": {"streamed_attributes": 80, "valid_quoted_attributes": 80},
    "incremental_dom_depth_guard": {"max_observed_depth": 8, "allowed_dom_depth": 10},
    "orphan_closing_tag_detector": {"closing_tags": 100, "orphan_closing_tags": 0},
    "unclosed_element_recovery_audit": {"opened_elements": 100, "closed_elements": 100},
    "progressive_script_order_guard": {"dependency_edges": 20, "respected_dependency_edges": 20},
    "stylesheet_blocking_budget": {"stylesheets": 10, "blocking_stylesheets": 0},
    "preload_consumption_match": {"preload_assets": 8, "consumed_preloads": 8},
    "responsive_srcset_coverage": {"responsive_images": 20, "srcset_images": 20},
    "picture_source_media_guard": {"picture_sources": 20, "media_scoped_sources": 20},
    "html_entity_escape_integrity": {"escapable_tokens": 50, "escaped_tokens": 50},
    "streaming_jsonld_integrity": {"jsonld_blocks": 5, "valid_jsonld_blocks": 5},
    "canonical_head_singleton_guard": {"canonical_tag_count": 1},
    "meta_charset_placement_guard": {"charset_offset_bytes": 100, "max_charset_offset_bytes": 1024},
    "viewport_meta_singleton_guard": {"viewport_tag_count": 1},
    "lang_dir_consistency_guard": {"expected_dir": "ltr", "actual_dir": "ltr"},
    "stream_completion_integrity": {"expected_terminal_tokens": ["html_close", "stream_end"], "observed_terminal_tokens": ["html_close", "stream_end"]},
}


def row_for(module_id: str) -> dict:
    op = MODULE_SPECS[module_id]["operation"]
    row = {"module_id": module_id}
    row.update(VALUES[op])
    return row


def rich_payload() -> dict:
    payload = {"bayesian_semantic_records": [], "html_stream_records": []}
    for module_id, spec in MODULE_SPECS.items():
        payload[spec["dataset_key"]].append(row_for(module_id))
    return payload

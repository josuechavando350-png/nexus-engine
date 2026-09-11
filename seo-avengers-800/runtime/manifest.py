from __future__ import annotations
from typing import Any, Dict, Sequence, Tuple

from .foundation_specs import FOUNDATION_SPECS, SOURCE_MODULES as FOUNDATION_SOURCE_MODULES, TARGET_MODULES as FOUNDATION_TARGET_MODULES
from .final_specs import FINAL_SPECS, SOURCE_MODULES as FINAL_SOURCE_MODULES, TARGET_MODULES as FINAL_TARGET_MODULES

SEMANTIC_SOURCE_RANGE = (1701, 1725)
SEMANTIC_TARGET_RANGE = (701, 725)
HTML_SOURCE_RANGE = (1726, 1750)
HTML_TARGET_RANGE = (726, 750)
TOTAL_IMPLEMENTED_THIS_BATCH = 200

SEMANTIC_DATASET_KEY = "bayesian_semantic_records"
HTML_DATASET_KEY = "html_stream_records"

SEMANTIC_BAYES_OPS = [
    ('bayes_inference_topic_linker', ['node_vector_ppm', 'prior_probability_ppm'], 940000),
    ('shannon_entropy_content_scorer', ['token_stream', 'vocabulary_set'], 880000),
    ('cross_lingual_entity_mapper', ['source_entities', 'target_entities', 'alignment_pairs'], 820000),
    ('temporal_decay_authority_tuner', ['age_seconds', 'max_age_seconds', 'historical_impressions', 'impression_reference'], 910000),
    ('sentiment_nuance_lexical_filter', ['adjective_tokens', 'bias_lexicon'], 950000),
    ('bayes_evidence_posterior_calibrator', ['prior_probability_ppm', 'evidence_likelihood_ppm', 'counter_likelihood_ppm'], 934120),
    ('topic_prior_smoothing_guard', ['topic_counts', 'smoothing_mass'], 934140),
    ('semantic_likelihood_ratio_ranker', ['supporting_evidence_count', 'contradicting_evidence_count', 'neutral_evidence_count'], 934160),
    ('entity_cooccurrence_posterior_audit', ['prior_probability_ppm', 'pair_hits', 'pair_opportunities'], 934180),
    ('intent_posterior_confidence_gate', ['intent_scores_ppm'], 934200),
    ('vocabulary_entropy_balance', ['bucket_token_counts'], 934220),
    ('lexical_redundancy_guard', ['ngram_hashes'], 934240),
    ('cross_lingual_bidirectional_coverage', ['forward_aligned_count', 'reverse_aligned_count', 'source_count', 'target_count'], 934260),
    ('evidence_contradiction_guard', ['supported_claims', 'contradicted_claims', 'unknown_claims'], 934280),
    ('prior_dominance_guard', ['prior_probability_ppm', 'evidence_count', 'minimum_evidence_count'], 934300),
    ('posterior_update_stability', ['posterior_series_ppm'], 934320),
    ('semantic_cluster_cohesion', ['intra_cluster_similarity_ppm'], 934340),
    ('entity_transition_consistency', ['valid_transitions', 'total_transitions'], 934360),
    ('temporal_evidence_freshness', ['age_seconds_list', 'max_age_seconds'], 934380),
    ('source_support_coverage', ['claims_total', 'claims_with_source'], 934400),
    ('uncertainty_margin_guard', ['top_score_ppm', 'second_score_ppm'], 934420),
    ('claim_posterior_support', ['claim_prior_ppm', 'support_likelihood_ppm', 'counter_likelihood_ppm'], 934440),
    ('multilingual_term_consistency', ['canonical_terms', 'observed_terms', 'alignment_pairs'], 934460),
    ('semantic_outlier_resistance', ['similarity_scores_ppm', 'minimum_inlier_ppm'], 934480),
    ('posterior_rank_separation', ['ranked_posterior_ppm', 'minimum_gap_ppm'], 934500),
]

HTML_STREAM_OPS = [
    ('http3_quic_stream_aligner', ['quic_stream_chunks', 'aligned_quic_chunks'], 985000),
    ('path_traversal_double_slash_purger', ['href_buffers', 'sanitized_href_buffers'], 995000),
    ('aria_interactive_element_guard', ['interactive_elements', 'aria_guarded_elements'], 910000),
    ('critical_css_viewport_splitter', ['viewport_css_rules', 'correctly_scoped_rules'], 930000),
    ('lazy_load_noscript_fallback_agent', ['lazy_images_nodes', 'noscript_fallbacks'], 880000),
    ('stream_chunk_boundary_validator', ['chunk_boundaries', 'valid_chunk_boundaries'], 850000),
    ('partial_head_state_guard', ['head_fragments', 'ordered_head_fragments'], 850000),
    ('utf8_boundary_integrity', ['utf8_boundaries', 'valid_utf8_boundaries'], 850000),
    ('html_token_resume_guard', ['resume_points', 'valid_resume_points'], 850000),
    ('streaming_attribute_quote_guard', ['streamed_attributes', 'valid_quoted_attributes'], 850000),
    ('incremental_dom_depth_guard', ['max_observed_depth', 'allowed_dom_depth'], 850000),
    ('orphan_closing_tag_detector', ['closing_tags', 'orphan_closing_tags'], 850000),
    ('unclosed_element_recovery_audit', ['opened_elements', 'closed_elements'], 850000),
    ('progressive_script_order_guard', ['dependency_edges', 'respected_dependency_edges'], 850000),
    ('stylesheet_blocking_budget', ['stylesheets', 'blocking_stylesheets'], 850000),
    ('preload_consumption_match', ['preload_assets', 'consumed_preloads'], 850000),
    ('responsive_srcset_coverage', ['responsive_images', 'srcset_images'], 850000),
    ('picture_source_media_guard', ['picture_sources', 'media_scoped_sources'], 850000),
    ('html_entity_escape_integrity', ['escapable_tokens', 'escaped_tokens'], 850000),
    ('streaming_jsonld_integrity', ['jsonld_blocks', 'valid_jsonld_blocks'], 850000),
    ('canonical_head_singleton_guard', ['canonical_tag_count'], 850000),
    ('meta_charset_placement_guard', ['charset_offset_bytes', 'max_charset_offset_bytes'], 850000),
    ('viewport_meta_singleton_guard', ['viewport_tag_count'], 850000),
    ('lang_dir_consistency_guard', ['expected_dir', 'actual_dir'], 850000),
    ('stream_completion_integrity', ['expected_terminal_tokens', 'observed_terminal_tokens'], 850000),
]

MODULE_SPECS: Dict[str, Dict[str, Any]] = dict(FOUNDATION_SPECS)


def _add_ops(source_start: int, rows: Sequence[Tuple[str, Sequence[str], int]], family: str, dataset_key: str) -> None:
    for offset, (operation, fields, threshold_ppm) in enumerate(rows):
        source_number = source_start + offset
        target_number = source_number - 1000
        MODULE_SPECS[f"M{target_number}"] = {
            "source_module": f"M{source_number}",
            "operation": operation,
            "family": family,
            "dataset_key": dataset_key,
            "input_fields": tuple(fields),
            "threshold_ppm": threshold_ppm,
        }


_add_ops(SEMANTIC_SOURCE_RANGE[0], SEMANTIC_BAYES_OPS, "SEMANTIC_BAYES", SEMANTIC_DATASET_KEY)
_add_ops(HTML_SOURCE_RANGE[0], HTML_STREAM_OPS, "HTML_STREAM_V2", HTML_DATASET_KEY)
MODULE_SPECS.update(FINAL_SPECS)

SEMANTIC_TARGET_MODULES = tuple(f"M{i}" for i in range(SEMANTIC_TARGET_RANGE[0], SEMANTIC_TARGET_RANGE[1] + 1))
SEMANTIC_SOURCE_MODULES = tuple(f"M{i}" for i in range(SEMANTIC_SOURCE_RANGE[0], SEMANTIC_SOURCE_RANGE[1] + 1))
HTML_TARGET_MODULES = tuple(f"M{i}" for i in range(HTML_TARGET_RANGE[0], HTML_TARGET_RANGE[1] + 1))
HTML_SOURCE_MODULES = tuple(f"M{i}" for i in range(HTML_SOURCE_RANGE[0], HTML_SOURCE_RANGE[1] + 1))
TARGET_MODULES = tuple(f"M{i}" for i in range(601, 801))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1601, 1801))

if FOUNDATION_TARGET_MODULES != tuple(f"M{i}" for i in range(601, 701)):
    raise RuntimeError("foundation target range drift")
if FOUNDATION_SOURCE_MODULES != tuple(f"M{i}" for i in range(1601, 1701)):
    raise RuntimeError("foundation source range drift")
if FINAL_TARGET_MODULES != tuple(f"M{i}" for i in range(751, 801)):
    raise RuntimeError("final target range drift")
if FINAL_SOURCE_MODULES != tuple(f"M{i}" for i in range(1751, 1801)):
    raise RuntimeError("final source range drift")
if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("M601-M800 manifest is incomplete or out of order")
if len(MODULE_SPECS) != TOTAL_IMPLEMENTED_THIS_BATCH:
    raise RuntimeError("implemented module cardinality mismatch")
if len({spec["source_module"] for spec in MODULE_SPECS.values()}) != TOTAL_IMPLEMENTED_THIS_BATCH:
    raise RuntimeError("source modules must be unique")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != TOTAL_IMPLEMENTED_THIS_BATCH:
    raise RuntimeError("operations must be unique")
for spec in MODULE_SPECS.values():
    threshold = spec["threshold_ppm"]
    if not isinstance(threshold, int) or isinstance(threshold, bool) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("threshold_ppm out of range")


def source_to_target_map() -> Dict[str, str]:
    return {spec["source_module"]: target for target, spec in MODULE_SPECS.items()}

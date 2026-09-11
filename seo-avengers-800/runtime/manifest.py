from __future__ import annotations
from typing import Any, Dict

SOURCE_RANGE = (1701, 1725)
TARGET_RANGE = (701, 725)
TOTAL_IMPLEMENTED_THIS_SLICE = 25
DATASET_KEY = "bayesian_semantic_records"

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

MODULE_SPECS: Dict[str, Dict[str, Any]] = {}
for offset, (operation, fields, threshold_ppm) in enumerate(SEMANTIC_BAYES_OPS):
    source_number = SOURCE_RANGE[0] + offset
    target_number = source_number - 1000
    MODULE_SPECS[f"M{target_number}"] = {
        "source_module": f"M{source_number}",
        "operation": operation,
        "family": "SEMANTIC_BAYES",
        "dataset_key": DATASET_KEY,
        "input_fields": tuple(fields),
        "threshold_ppm": threshold_ppm,
    }

TARGET_MODULES = tuple(f"M{i}" for i in range(TARGET_RANGE[0], TARGET_RANGE[1] + 1))
SOURCE_MODULES = tuple(f"M{i}" for i in range(SOURCE_RANGE[0], SOURCE_RANGE[1] + 1))

if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("M701-M725 manifest is incomplete or out of order")
if len({spec["source_module"] for spec in MODULE_SPECS.values()}) != TOTAL_IMPLEMENTED_THIS_SLICE:
    raise RuntimeError("source modules must be unique")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != TOTAL_IMPLEMENTED_THIS_SLICE:
    raise RuntimeError("operations must be unique")
for spec in MODULE_SPECS.values():
    threshold = spec["threshold_ppm"]
    if not isinstance(threshold, int) or isinstance(threshold, bool) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("threshold_ppm out of range")

def source_to_target_map() -> Dict[str, str]:
    return {spec["source_module"]: target for target, spec in MODULE_SPECS.items()}

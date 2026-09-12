from __future__ import annotations

from typing import Any, Callable, Dict, Mapping

from .common import (
    PPM,
    InvalidData,
    InsufficientData,
    bounded_ratio_ppm,
    capped_ratio_ppm,
    complement_ppm,
    coverage_ppm,
    distribution_uniformity_ppm,
    exact_text_match_ppm,
    jaccard_ppm,
    mean_ppm,
    min_ppm,
    need_int,
    need_ppm,
    need_ppm_list,
    need_sha256,
    need_str,
    need_str_list,
    positional_match_ppm,
    validate_required_fields,
    vector_stability_ppm,
)
from .semantic_specs import SEMANTIC_SPECS


def _result(score: int, threshold_ppm: int) -> Dict[str, Any]:
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= PPM:
        raise InvalidData("semantic_score_out_of_range")
    if isinstance(threshold_ppm, bool) or not isinstance(threshold_ppm, int) or not 0 <= threshold_ppm <= PPM:
        raise InvalidData("threshold_ppm_out_of_range")
    return {"score_ppm": score, "threshold_ppm": threshold_ppm, "violation": score < threshold_ppm}


def _eval_entity_alignment_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "required_entities"), need_str_list(row, "aligned_entities"))
    return _result(score, threshold_ppm)


def _eval_intent_label_overlap(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = jaccard_ppm(need_str_list(row, "expected_intents"), need_str_list(row, "observed_intents"))
    return _result(score, threshold_ppm)


def _eval_topic_distribution_stability(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = vector_stability_ppm(need_ppm_list(row, "baseline_topic_ppm"), need_ppm_list(row, "current_topic_ppm"))
    return _result(score, threshold_ppm)


def _eval_claim_source_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "sourced_claims", minimum=0), need_int(row, "total_claims", minimum=1))
    return _result(score, threshold_ppm)


def _eval_multilingual_term_alignment(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "source_terms"), need_str_list(row, "aligned_terms"))
    return _result(score, threshold_ppm)


def _eval_embedding_neighbor_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = jaccard_ppm(need_str_list(row, "baseline_neighbors"), need_str_list(row, "current_neighbors"))
    return _result(score, threshold_ppm)


def _eval_canonical_entity_resolution(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "resolved_entities", minimum=0), need_int(row, "observed_entities", minimum=1))
    return _result(score, threshold_ppm)


def _eval_synonym_cluster_cohesion(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = mean_ppm(need_ppm_list(row, "cohesion_scores_ppm"))
    return _result(score, threshold_ppm)


def _eval_ambiguity_margin_strength(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    top = need_ppm(row, "top_intent_ppm")
    second = need_ppm(row, "second_intent_ppm")
    if second > top:
        raise InvalidData("intent_ranking_inverted")
    score = top - second
    return _result(score, threshold_ppm)


def _eval_semantic_digest_match(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    expected = need_sha256(row, "expected_digest")
    observed = need_sha256(row, "observed_digest")
    score = PPM if expected == observed else 0
    return _result(score, threshold_ppm)


def _eval_unicode_normalization_invariance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = exact_text_match_ppm(need_str(row, "source_text"), need_str(row, "normalized_text"))
    return _result(score, threshold_ppm)


def _eval_token_sequence_preservation(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = positional_match_ppm(need_str_list(row, "source_tokens"), need_str_list(row, "observed_tokens"))
    return _result(score, threshold_ppm)


def _eval_entity_transition_validity(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "valid_transitions", minimum=0), need_int(row, "total_transitions", minimum=1))
    return _result(score, threshold_ppm)


def _eval_relation_direction_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "correct_direction_relations", minimum=0), need_int(row, "total_relations", minimum=1))
    return _result(score, threshold_ppm)


def _eval_coreference_resolution_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "resolved_mentions", minimum=0), need_int(row, "coreference_mentions", minimum=1))
    return _result(score, threshold_ppm)


def _eval_predicate_argument_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "complete_argument_count", minimum=0), need_int(row, "predicate_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_taxonomy_parent_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "valid_parent_links", minimum=0), need_int(row, "taxonomy_links", minimum=1))
    return _result(score, threshold_ppm)


def _eval_taxonomy_depth_budget_score(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    observed = need_int(row, "observed_depth", minimum=0)
    allowed = need_int(row, "allowed_depth", minimum=1)
    score = PPM if observed <= allowed else capped_ratio_ppm(allowed, observed)
    return _result(score, threshold_ppm)


def _eval_label_conflict_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    labels = need_int(row, "label_count", minimum=1)
    conflicts = need_int(row, "conflicting_labels", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(conflicts, labels))
    return _result(score, threshold_ppm)


def _eval_unsupported_claim_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    claims = need_int(row, "claim_count", minimum=1)
    unsupported = need_int(row, "unsupported_claims", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(unsupported, claims))
    return _result(score, threshold_ppm)


def _eval_evidence_contradiction_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    claims = need_int(row, "claim_count", minimum=1)
    contradicted = need_int(row, "contradicted_claims", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(contradicted, claims))
    return _result(score, threshold_ppm)


def _eval_posterior_update_stability(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = vector_stability_ppm(need_ppm_list(row, "prior_vector_ppm"), need_ppm_list(row, "posterior_vector_ppm"))
    return _result(score, threshold_ppm)


def _eval_source_diversity_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = capped_ratio_ppm(need_int(row, "unique_source_count", minimum=0), need_int(row, "required_source_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_language_tag_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "expected_language_tags"), need_str_list(row, "observed_language_tags"))
    return _result(score, threshold_ppm)


def _eval_locale_entity_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = jaccard_ppm(need_str_list(row, "canonical_locale_entities"), need_str_list(row, "observed_locale_entities"))
    return _result(score, threshold_ppm)


def _eval_query_document_term_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "query_terms"), need_str_list(row, "document_terms"))
    return _result(score, threshold_ppm)


def _eval_heading_topic_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "required_topics"), need_str_list(row, "heading_topics"))
    return _result(score, threshold_ppm)


def _eval_anchor_entity_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "required_entities"), need_str_list(row, "anchor_entities"))
    return _result(score, threshold_ppm)


def _eval_schema_entity_name_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = exact_text_match_ppm(need_str(row, "schema_entity_name"), need_str(row, "page_entity_name"), casefold=True)
    return _result(score, threshold_ppm)


def _eval_author_identity_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = exact_text_match_ppm(need_str(row, "declared_author_id"), need_str(row, "evidence_author_id"))
    return _result(score, threshold_ppm)


def _eval_publication_time_order_validity(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    published = need_int(row, "published_epoch", minimum=0)
    modified = need_int(row, "modified_epoch", minimum=0)
    score = PPM if published <= modified else 0
    return _result(score, threshold_ppm)


def _eval_freshness_retention_score(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    age = need_int(row, "age_seconds", minimum=0)
    max_age = need_int(row, "max_age_seconds", minimum=1)
    score = 0 if age >= max_age else ((max_age - age) * PPM) // max_age
    return _result(score, threshold_ppm)


def _eval_semantic_duplicate_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    total = need_int(row, "document_count", minimum=1)
    duplicate = need_int(row, "duplicate_document_count", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(duplicate, total))
    return _result(score, threshold_ppm)


def _eval_cluster_outlier_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    total = need_int(row, "cluster_point_count", minimum=1)
    outliers = need_int(row, "outlier_point_count", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(outliers, total))
    return _result(score, threshold_ppm)


def _eval_nearest_neighbor_reciprocity(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "mutual_neighbor_link_count", minimum=0), need_int(row, "neighbor_link_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_semantic_path_reachability(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "reachable_target_count", minimum=0), need_int(row, "required_target_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_intent_confusion_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    total = need_int(row, "classification_count", minimum=1)
    confused = need_int(row, "confused_classification_count", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(confused, total))
    return _result(score, threshold_ppm)


def _eval_entity_alias_resolution(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "resolved_alias_count", minimum=0), need_int(row, "alias_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_abbreviation_expansion_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "expanded_abbreviation_count", minimum=0), need_int(row, "abbreviation_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_negation_scope_consistency(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "correct_scope_count", minimum=0), need_int(row, "negation_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_sentiment_polarity_stability(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    baseline = need_ppm(row, "baseline_polarity_ppm")
    observed = need_ppm(row, "observed_polarity_ppm")
    score = PPM - abs(baseline - observed)
    return _result(score, threshold_ppm)


def _eval_classifier_confidence_floor(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = min_ppm(need_ppm_list(row, "classification_confidence_ppm"))
    return _result(score, threshold_ppm)


def _eval_ranking_separation_strength(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    scores = need_ppm_list(row, "ranked_scores_ppm")
    if len(scores) < 2:
        raise InsufficientData("ranked_scores_requires_two_values")
    if any(scores[index] < scores[index + 1] for index in range(len(scores) - 1)):
        raise InvalidData("ranked_scores_not_descending")
    score = min(scores[index] - scores[index + 1] for index in range(len(scores) - 1))
    return _result(score, threshold_ppm)


def _eval_distribution_uniformity_score(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = distribution_uniformity_ppm(need_ppm_list(row, "bucket_distribution_ppm"))
    return _result(score, threshold_ppm)


def _eval_semantic_field_completeness(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "required_fields"), need_str_list(row, "present_fields"))
    return _result(score, threshold_ppm)


def _eval_structured_claim_key_coverage(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = coverage_ppm(need_str_list(row, "required_claim_keys"), need_str_list(row, "observed_claim_keys"))
    return _result(score, threshold_ppm)


def _eval_lexical_noise_resistance(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    total = need_int(row, "token_count", minimum=1)
    noise = need_int(row, "noise_token_count", minimum=0)
    score = complement_ppm(bounded_ratio_ppm(noise, total))
    return _result(score, threshold_ppm)


def _eval_citation_anchor_match(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = bounded_ratio_ppm(need_int(row, "matched_anchor_count", minimum=0), need_int(row, "citation_count", minimum=1))
    return _result(score, threshold_ppm)


def _eval_source_target_bidirectional_alignment(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    forward = bounded_ratio_ppm(need_int(row, "forward_aligned_count", minimum=0), need_int(row, "source_count", minimum=1))
    reverse = bounded_ratio_ppm(need_int(row, "reverse_aligned_count", minimum=0), need_int(row, "target_count", minimum=1))
    score = min(forward, reverse)
    return _result(score, threshold_ppm)


def _eval_semantic_evidence_quorum(row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    score = capped_ratio_ppm(need_int(row, "confirmed_source_count", minimum=0), need_int(row, "required_source_count", minimum=1))
    return _result(score, threshold_ppm)


EVALUATORS: Dict[str, Callable[[Mapping[str, Any], int], Dict[str, Any]]] = {
    "entity_alignment_coverage": _eval_entity_alignment_coverage,
    "intent_label_overlap": _eval_intent_label_overlap,
    "topic_distribution_stability": _eval_topic_distribution_stability,
    "claim_source_coverage": _eval_claim_source_coverage,
    "multilingual_term_alignment": _eval_multilingual_term_alignment,
    "embedding_neighbor_consistency": _eval_embedding_neighbor_consistency,
    "canonical_entity_resolution": _eval_canonical_entity_resolution,
    "synonym_cluster_cohesion": _eval_synonym_cluster_cohesion,
    "ambiguity_margin_strength": _eval_ambiguity_margin_strength,
    "semantic_digest_match": _eval_semantic_digest_match,
    "unicode_normalization_invariance": _eval_unicode_normalization_invariance,
    "token_sequence_preservation": _eval_token_sequence_preservation,
    "entity_transition_validity": _eval_entity_transition_validity,
    "relation_direction_consistency": _eval_relation_direction_consistency,
    "coreference_resolution_coverage": _eval_coreference_resolution_coverage,
    "predicate_argument_coverage": _eval_predicate_argument_coverage,
    "taxonomy_parent_consistency": _eval_taxonomy_parent_consistency,
    "taxonomy_depth_budget_score": _eval_taxonomy_depth_budget_score,
    "label_conflict_resistance": _eval_label_conflict_resistance,
    "unsupported_claim_resistance": _eval_unsupported_claim_resistance,
    "evidence_contradiction_resistance": _eval_evidence_contradiction_resistance,
    "posterior_update_stability": _eval_posterior_update_stability,
    "source_diversity_coverage": _eval_source_diversity_coverage,
    "language_tag_coverage": _eval_language_tag_coverage,
    "locale_entity_consistency": _eval_locale_entity_consistency,
    "query_document_term_coverage": _eval_query_document_term_coverage,
    "heading_topic_coverage": _eval_heading_topic_coverage,
    "anchor_entity_coverage": _eval_anchor_entity_coverage,
    "schema_entity_name_consistency": _eval_schema_entity_name_consistency,
    "author_identity_consistency": _eval_author_identity_consistency,
    "publication_time_order_validity": _eval_publication_time_order_validity,
    "freshness_retention_score": _eval_freshness_retention_score,
    "semantic_duplicate_resistance": _eval_semantic_duplicate_resistance,
    "cluster_outlier_resistance": _eval_cluster_outlier_resistance,
    "nearest_neighbor_reciprocity": _eval_nearest_neighbor_reciprocity,
    "semantic_path_reachability": _eval_semantic_path_reachability,
    "intent_confusion_resistance": _eval_intent_confusion_resistance,
    "entity_alias_resolution": _eval_entity_alias_resolution,
    "abbreviation_expansion_coverage": _eval_abbreviation_expansion_coverage,
    "negation_scope_consistency": _eval_negation_scope_consistency,
    "sentiment_polarity_stability": _eval_sentiment_polarity_stability,
    "classifier_confidence_floor": _eval_classifier_confidence_floor,
    "ranking_separation_strength": _eval_ranking_separation_strength,
    "distribution_uniformity_score": _eval_distribution_uniformity_score,
    "semantic_field_completeness": _eval_semantic_field_completeness,
    "structured_claim_key_coverage": _eval_structured_claim_key_coverage,
    "lexical_noise_resistance": _eval_lexical_noise_resistance,
    "citation_anchor_match": _eval_citation_anchor_match,
    "source_target_bidirectional_alignment": _eval_source_target_bidirectional_alignment,
    "semantic_evidence_quorum": _eval_semantic_evidence_quorum,
}

REQUIRED_FIELDS = {str(spec["operation"]): tuple(spec["input_fields"]) for spec in SEMANTIC_SPECS.values()}
if set(EVALUATORS) != set(REQUIRED_FIELDS):
    raise RuntimeError("semantic evaluator/spec operation drift")


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    evaluator = EVALUATORS.get(operation)
    if evaluator is None:
        raise InvalidData(f"unsupported_semantic_operation:{operation}")
    validate_required_fields(row, REQUIRED_FIELDS[operation])
    return evaluator(row, threshold_ppm)

from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

SEMANTIC_ROWS: Sequence[Tuple[str, Sequence[str], int]] = (
    ("entity_alignment_coverage", ("required_entities", "aligned_entities"), 900000),
    ("intent_label_overlap", ("expected_intents", "observed_intents"), 850000),
    ("topic_distribution_stability", ("baseline_topic_ppm", "current_topic_ppm"), 900000),
    ("claim_source_coverage", ("total_claims", "sourced_claims"), 950000),
    ("multilingual_term_alignment", ("source_terms", "aligned_terms"), 900000),
    ("embedding_neighbor_consistency", ("baseline_neighbors", "current_neighbors"), 800000),
    ("canonical_entity_resolution", ("observed_entities", "resolved_entities"), 950000),
    ("synonym_cluster_cohesion", ("cohesion_scores_ppm",), 850000),
    ("ambiguity_margin_strength", ("top_intent_ppm", "second_intent_ppm"), 200000),
    ("semantic_digest_match", ("expected_digest", "observed_digest"), 1000000),
    ("unicode_normalization_invariance", ("source_text", "normalized_text"), 1000000),
    ("token_sequence_preservation", ("source_tokens", "observed_tokens"), 900000),
    ("entity_transition_validity", ("total_transitions", "valid_transitions"), 950000),
    ("relation_direction_consistency", ("total_relations", "correct_direction_relations"), 970000),
    ("coreference_resolution_coverage", ("coreference_mentions", "resolved_mentions"), 900000),
    ("predicate_argument_coverage", ("predicate_count", "complete_argument_count"), 900000),
    ("taxonomy_parent_consistency", ("taxonomy_links", "valid_parent_links"), 950000),
    ("taxonomy_depth_budget_score", ("observed_depth", "allowed_depth"), 900000),
    ("label_conflict_resistance", ("label_count", "conflicting_labels"), 950000),
    ("unsupported_claim_resistance", ("claim_count", "unsupported_claims"), 950000),
    ("evidence_contradiction_resistance", ("claim_count", "contradicted_claims"), 970000),
    ("posterior_update_stability", ("prior_vector_ppm", "posterior_vector_ppm"), 750000),
    ("source_diversity_coverage", ("required_source_count", "unique_source_count"), 800000),
    ("language_tag_coverage", ("expected_language_tags", "observed_language_tags"), 900000),
    ("locale_entity_consistency", ("canonical_locale_entities", "observed_locale_entities"), 850000),
    ("query_document_term_coverage", ("query_terms", "document_terms"), 800000),
    ("heading_topic_coverage", ("required_topics", "heading_topics"), 850000),
    ("anchor_entity_coverage", ("required_entities", "anchor_entities"), 850000),
    ("schema_entity_name_consistency", ("schema_entity_name", "page_entity_name"), 1000000),
    ("author_identity_consistency", ("declared_author_id", "evidence_author_id"), 1000000),
    ("publication_time_order_validity", ("published_epoch", "modified_epoch"), 1000000),
    ("freshness_retention_score", ("age_seconds", "max_age_seconds"), 500000),
    ("semantic_duplicate_resistance", ("document_count", "duplicate_document_count"), 950000),
    ("cluster_outlier_resistance", ("cluster_point_count", "outlier_point_count"), 900000),
    ("nearest_neighbor_reciprocity", ("neighbor_link_count", "mutual_neighbor_link_count"), 850000),
    ("semantic_path_reachability", ("required_target_count", "reachable_target_count"), 900000),
    ("intent_confusion_resistance", ("classification_count", "confused_classification_count"), 950000),
    ("entity_alias_resolution", ("alias_count", "resolved_alias_count"), 900000),
    ("abbreviation_expansion_coverage", ("abbreviation_count", "expanded_abbreviation_count"), 900000),
    ("negation_scope_consistency", ("negation_count", "correct_scope_count"), 950000),
    ("sentiment_polarity_stability", ("baseline_polarity_ppm", "observed_polarity_ppm"), 900000),
    ("classifier_confidence_floor", ("classification_confidence_ppm",), 800000),
    ("ranking_separation_strength", ("ranked_scores_ppm",), 50000),
    ("distribution_uniformity_score", ("bucket_distribution_ppm",), 700000),
    ("semantic_field_completeness", ("required_fields", "present_fields"), 950000),
    ("structured_claim_key_coverage", ("required_claim_keys", "observed_claim_keys"), 950000),
    ("lexical_noise_resistance", ("token_count", "noise_token_count"), 900000),
    ("citation_anchor_match", ("citation_count", "matched_anchor_count"), 900000),
    ("source_target_bidirectional_alignment", ("source_count", "forward_aligned_count", "target_count", "reverse_aligned_count"), 850000),
    ("semantic_evidence_quorum", ("required_source_count", "confirmed_source_count"), 900000),
)

SEMANTIC_SPECS: Dict[str, Dict[str, Any]] = {}
for offset, (operation, fields, threshold_ppm) in enumerate(SEMANTIC_ROWS):
    target_number = 801 + offset
    source_number = target_number + 1000
    module_id = f"M{target_number}"
    SEMANTIC_SPECS[module_id] = {
        "module_id": module_id,
        "source_module": f"M{source_number}",
        "family": "SEMANTIC_NLP",
        "operation": operation,
        "dataset_key": "semantic_nlp_records",
        "input_fields": tuple(fields),
        "threshold_ppm": threshold_ppm,
    }

TARGET_MODULES = tuple(f"M{i}" for i in range(801, 851))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1801, 1851))

if tuple(SEMANTIC_SPECS) != TARGET_MODULES:
    raise RuntimeError("semantic target range drift")
if {spec["source_module"] for spec in SEMANTIC_SPECS.values()} != set(SOURCE_MODULES):
    raise RuntimeError("semantic source range drift")
if len({spec["operation"] for spec in SEMANTIC_SPECS.values()}) != 50:
    raise RuntimeError("semantic operation collision")
for target, spec in SEMANTIC_SPECS.items():
    if target != spec["module_id"]:
        raise RuntimeError("semantic key/spec mismatch")
    if int(spec["source_module"][1:]) != int(target[1:]) + 1000:
        raise RuntimeError("semantic source mapping drift")
    threshold = spec["threshold_ppm"]
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("semantic threshold range")
    fields = spec["input_fields"]
    if not fields or len(fields) != len(set(fields)) or any(not isinstance(field, str) or not field for field in fields):
        raise RuntimeError("semantic input field contract invalid")

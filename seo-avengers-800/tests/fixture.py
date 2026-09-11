from __future__ import annotations

from runtime.manifest import MODULE_SPECS


def row_for(module_id: str) -> dict:
    op = MODULE_SPECS[module_id]["operation"]
    row = {"module_id": module_id}
    values = {
        "bayes_inference_topic_linker": {"node_vector_ppm": [1_000_000, 1_000_000], "prior_probability_ppm": 950_000},
        "shannon_entropy_content_scorer": {"token_stream": ["a", "b", "c", "d"], "vocabulary_set": ["a", "b", "c", "d"]},
        "cross_lingual_entity_mapper": {
            "source_entities": ["abogado", "defensa"], "target_entities": ["lawyer", "defense"],
            "alignment_pairs": [["abogado", "lawyer"], ["defensa", "defense"]],
        },
        "temporal_decay_authority_tuner": {
            "age_seconds": 0, "max_age_seconds": 86_400, "historical_impressions": 100, "impression_reference": 100,
        },
        "sentiment_nuance_lexical_filter": {"adjective_tokens": ["técnico", "preciso"], "bias_lexicon": ["sensacionalista"]},
        "bayes_evidence_posterior_calibrator": {
            "prior_probability_ppm": 950_000, "evidence_likelihood_ppm": 1_000_000, "counter_likelihood_ppm": 0,
        },
        "topic_prior_smoothing_guard": {"topic_counts": [10, 10, 10, 10], "smoothing_mass": 1},
        "semantic_likelihood_ratio_ranker": {
            "supporting_evidence_count": 10, "contradicting_evidence_count": 0, "neutral_evidence_count": 0,
        },
        "entity_cooccurrence_posterior_audit": {"prior_probability_ppm": 950_000, "pair_hits": 10, "pair_opportunities": 10},
        "intent_posterior_confidence_gate": {"intent_scores_ppm": [1_000_000, 0, 0]},
        "vocabulary_entropy_balance": {"bucket_token_counts": [10, 10, 10, 10]},
        "lexical_redundancy_guard": {"ngram_hashes": ["h1", "h2", "h3", "h4"]},
        "cross_lingual_bidirectional_coverage": {
            "forward_aligned_count": 10, "reverse_aligned_count": 8, "source_count": 10, "target_count": 8,
        },
        "evidence_contradiction_guard": {"supported_claims": 10, "contradicted_claims": 0, "unknown_claims": 0},
        "prior_dominance_guard": {"prior_probability_ppm": 950_000, "evidence_count": 10, "minimum_evidence_count": 10},
        "posterior_update_stability": {"posterior_series_ppm": [950_000, 950_000, 950_000]},
        "semantic_cluster_cohesion": {"intra_cluster_similarity_ppm": [1_000_000, 1_000_000, 1_000_000]},
        "entity_transition_consistency": {"valid_transitions": 10, "total_transitions": 10},
        "temporal_evidence_freshness": {"age_seconds_list": [0, 0, 0], "max_age_seconds": 86_400},
        "source_support_coverage": {"claims_total": 10, "claims_with_source": 10},
        "uncertainty_margin_guard": {"top_score_ppm": 1_000_000, "second_score_ppm": 0},
        "claim_posterior_support": {
            "claim_prior_ppm": 950_000, "support_likelihood_ppm": 1_000_000, "counter_likelihood_ppm": 0,
        },
        "multilingual_term_consistency": {
            "canonical_terms": ["abogado", "defensa"], "observed_terms": ["lawyer", "defense"],
            "alignment_pairs": [["abogado", "lawyer"], ["defensa", "defense"]],
        },
        "semantic_outlier_resistance": {"similarity_scores_ppm": [950_000, 960_000, 970_000], "minimum_inlier_ppm": 900_000},
        "posterior_rank_separation": {"ranked_posterior_ppm": [1_000_000, 700_000, 400_000], "minimum_gap_ppm": 200_000},
    }
    row.update(values[op])
    return row


def rich_payload() -> dict:
    return {"bayesian_semantic_records": [row_for(module_id) for module_id in MODULE_SPECS]}

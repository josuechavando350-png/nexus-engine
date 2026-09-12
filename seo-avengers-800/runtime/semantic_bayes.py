from __future__ import annotations

from typing import Any, Dict, Mapping, Sequence

from .common import (
    PPM,
    InvalidData,
    InsufficientData,
    clamp_ppm,
    complement_ppm,
    need_int,
    need_int_list,
    need_list,
    need_str_list,
    ratio_ppm,
)

_LOG_FRAC_BITS = 24
_LOG_SCALE = 1 << _LOG_FRAC_BITS


def _need_ppm(row: Mapping[str, Any], key: str) -> int:
    value = need_int(row, key, minimum=0)
    if value > PPM:
        raise InvalidData(f"{key}_above_one_million")
    return value


def _need_ppm_list(row: Mapping[str, Any], key: str) -> list[int]:
    values = need_int_list(row, key, minimum=0)
    if any(value > PPM for value in values):
        raise InvalidData(f"{key}_item_above_one_million")
    return values


def _mean(values: Sequence[int], reason: str) -> int:
    if not values:
        raise InsufficientData(reason)
    return sum(values) // len(values)


def _posterior_ppm(prior_ppm: int, likelihood_ppm: int, counter_likelihood_ppm: int) -> int:
    if not 0 <= prior_ppm <= PPM:
        raise InvalidData("prior_probability_ppm_out_of_range")
    if not 0 <= likelihood_ppm <= PPM:
        raise InvalidData("evidence_likelihood_ppm_out_of_range")
    if not 0 <= counter_likelihood_ppm <= PPM:
        raise InvalidData("counter_likelihood_ppm_out_of_range")
    numerator = prior_ppm * likelihood_ppm
    denominator = numerator + (PPM - prior_ppm) * counter_likelihood_ppm
    if denominator <= 0:
        raise InsufficientData("bayes_denominator_zero")
    return clamp_ppm((numerator * PPM) // denominator)


def _log2_fixed(value: int) -> int:
    """Return log2(value) in Q24 fixed point using integer-only iterative squaring."""
    if value <= 0:
        raise InvalidData("log2_requires_positive_integer")
    integer_part = value.bit_length() - 1
    normalized = (value << _LOG_FRAC_BITS) >> integer_part
    result = integer_part << _LOG_FRAC_BITS
    for bit in range(1, _LOG_FRAC_BITS + 1):
        normalized = (normalized * normalized) >> _LOG_FRAC_BITS
        if normalized >= (2 << _LOG_FRAC_BITS):
            normalized >>= 1
            result |= 1 << (_LOG_FRAC_BITS - bit)
    return result


def _entropy_from_counts_ppm(counts: Sequence[int], max_categories: int | None = None) -> int:
    if not counts:
        raise InsufficientData("entropy_counts_empty")
    if any(count <= 0 for count in counts):
        raise InvalidData("entropy_counts_must_be_positive")
    total = sum(counts)
    categories = len(counts)
    if categories == 1:
        return 0
    if max_categories is None:
        max_categories = categories
    if max_categories < categories:
        raise InvalidData("entropy_max_categories_below_observed")
    if max_categories <= 1:
        return 0
    log_total = _log2_fixed(total)
    weighted_sum = 0
    for count in counts:
        weighted_sum += count * (log_total - _log2_fixed(count))
    entropy_q24 = weighted_sum // total
    max_entropy_q24 = _log2_fixed(max_categories)
    if max_entropy_q24 <= 0:
        return 0
    return clamp_ppm((entropy_q24 * PPM) // max_entropy_q24)


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool,
           healthy_high: bool = True, **extra: Any) -> Dict[str, Any]:
    output: Dict[str, Any] = {
        "metric_name": metric_name,
        "metric_ppm": clamp_ppm(metric_ppm),
        "threshold_ppm": threshold_ppm,
        "policy_direction": "higher_is_healthier" if healthy_high else "lower_is_healthier",
        "violation": bool(violation),
    }
    output.update(extra)
    return output


def _alignment_pairs(row: Mapping[str, Any]) -> list[tuple[str, str]]:
    raw = need_list(row, "alignment_pairs")
    pairs: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, list) or len(item) != 2 or not all(isinstance(v, str) for v in item):
            raise InvalidData("alignment_pairs_invalid")
        pairs.append((item[0], item[1]))
    if not pairs:
        raise InsufficientData("alignment_pairs_empty")
    return pairs


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    if operation == "bayes_inference_topic_linker":
        vector = _need_ppm_list(row, "node_vector_ppm")
        prior = _need_ppm(row, "prior_probability_ppm")
        if len(vector) < 2:
            raise InsufficientData("node_vector_ppm_too_short")
        likelihood = _mean(vector, "node_vector_ppm_empty")
        posterior = _posterior_ppm(prior, likelihood, complement_ppm(likelihood))
        return _score("posterior_probability_ppm", posterior, threshold_ppm, posterior < threshold_ppm,
                      prior_probability_ppm=prior, evidence_likelihood_ppm=likelihood)

    if operation == "shannon_entropy_content_scorer":
        tokens = need_str_list(row, "token_stream")
        vocabulary = need_str_list(row, "vocabulary_set")
        if not tokens:
            raise InsufficientData("token_stream_empty")
        vocab = {token.casefold() for token in vocabulary if token}
        if len(vocab) < 2:
            raise InsufficientData("vocabulary_set_too_small")
        counts: Dict[str, int] = {}
        for token in tokens:
            key = token.casefold()
            if key not in vocab:
                raise InvalidData("token_stream_contains_term_outside_vocabulary")
            counts[key] = counts.get(key, 0) + 1
        score = _entropy_from_counts_ppm(tuple(counts.values()), len(vocab))
        return _score("normalized_shannon_entropy_ppm", score, threshold_ppm, score < threshold_ppm,
                      vocabulary_size=len(vocab), observed_unique_tokens=len(counts))

    if operation == "cross_lingual_entity_mapper":
        source = {value.casefold() for value in need_str_list(row, "source_entities") if value}
        target = {value.casefold() for value in need_str_list(row, "target_entities") if value}
        if not source or not target:
            raise InsufficientData("cross_lingual_entities_empty")
        pairs = _alignment_pairs(row)
        mapped = {(left.casefold(), right.casefold()) for left, right in pairs}
        aligned = sum(1 for left, right in mapped if left in source and right in target)
        denominator = max(len(source), len(target))
        score = ratio_ppm(aligned, denominator)
        return _score("cross_lingual_alignment_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "temporal_decay_authority_tuner":
        age = need_int(row, "age_seconds", minimum=0)
        max_age = need_int(row, "max_age_seconds", minimum=0)
        impressions = need_int(row, "historical_impressions", minimum=0)
        reference = need_int(row, "impression_reference", minimum=0)
        if max_age == 0 or reference == 0:
            raise InsufficientData("temporal_reference_zero")
        freshness = complement_ppm(ratio_ppm(min(age, max_age), max_age))
        impression_support = ratio_ppm(min(impressions, reference), reference)
        score = (freshness + impression_support) // 2
        return _score("temporal_authority_ppm", score, threshold_ppm, score < threshold_ppm,
                      freshness_ppm=freshness, impression_support_ppm=impression_support)

    if operation == "sentiment_nuance_lexical_filter":
        adjectives = need_str_list(row, "adjective_tokens")
        bias = {value.casefold() for value in need_str_list(row, "bias_lexicon") if value}
        if not adjectives:
            raise InsufficientData("adjective_tokens_empty")
        risk = ratio_ppm(sum(1 for token in adjectives if token.casefold() in bias), len(adjectives))
        score = complement_ppm(risk)
        return _score("objectivity_ppm", score, threshold_ppm, score < threshold_ppm, bias_risk_ppm=risk)

    if operation == "bayes_evidence_posterior_calibrator":
        prior = _need_ppm(row, "prior_probability_ppm")
        likelihood = _need_ppm(row, "evidence_likelihood_ppm")
        counter = _need_ppm(row, "counter_likelihood_ppm")
        posterior = _posterior_ppm(prior, likelihood, counter)
        return _score("posterior_calibration_ppm", posterior, threshold_ppm, posterior < threshold_ppm)

    if operation == "topic_prior_smoothing_guard":
        counts = need_int_list(row, "topic_counts", minimum=0)
        smoothing = need_int(row, "smoothing_mass", minimum=0)
        if not counts:
            raise InsufficientData("topic_counts_empty")
        total = sum(counts) + smoothing * len(counts)
        if total <= 0:
            raise InsufficientData("topic_prior_total_zero")
        minimum_share = min((count + smoothing) * PPM // total for count in counts)
        ideal_minimum = PPM // len(counts)
        score = ratio_ppm(minimum_share, ideal_minimum)
        return _score("prior_smoothing_balance_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "semantic_likelihood_ratio_ranker":
        support = need_int(row, "supporting_evidence_count", minimum=0)
        contradict = need_int(row, "contradicting_evidence_count", minimum=0)
        neutral = need_int(row, "neutral_evidence_count", minimum=0)
        total = support + contradict + neutral
        if total == 0:
            raise InsufficientData("semantic_evidence_empty")
        support_score = ratio_ppm(support, total)
        contradiction_penalty = ratio_ppm(contradict, total)
        score = clamp_ppm(support_score - contradiction_penalty)
        return _score("net_likelihood_support_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "entity_cooccurrence_posterior_audit":
        prior = _need_ppm(row, "prior_probability_ppm")
        hits = need_int(row, "pair_hits", minimum=0)
        opportunities = need_int(row, "pair_opportunities", minimum=0)
        if opportunities == 0:
            raise InsufficientData("pair_opportunities_zero")
        if hits > opportunities:
            raise InvalidData("pair_hits_exceed_opportunities")
        likelihood = ratio_ppm(hits, opportunities)
        posterior = _posterior_ppm(prior, likelihood, complement_ppm(likelihood))
        return _score("cooccurrence_posterior_ppm", posterior, threshold_ppm, posterior < threshold_ppm)

    if operation == "intent_posterior_confidence_gate":
        scores = sorted(_need_ppm_list(row, "intent_scores_ppm"), reverse=True)
        if len(scores) < 2:
            raise InsufficientData("intent_scores_ppm_requires_two")
        if sum(scores) == 0:
            raise InsufficientData("intent_scores_ppm_all_zero")
        score = ratio_ppm(scores[0], sum(scores))
        return _score("dominant_intent_confidence_ppm", score, threshold_ppm, score < threshold_ppm,
                      margin_ppm=scores[0] - scores[1])

    if operation == "vocabulary_entropy_balance":
        counts = need_int_list(row, "bucket_token_counts", minimum=0)
        positive = [value for value in counts if value > 0]
        if len(positive) < 2:
            raise InsufficientData("bucket_token_counts_need_two_nonzero")
        score = _entropy_from_counts_ppm(positive, len(counts))
        return _score("bucket_entropy_balance_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "lexical_redundancy_guard":
        hashes = need_str_list(row, "ngram_hashes")
        if len(hashes) < 2:
            raise InsufficientData("ngram_hashes_too_short")
        unique = len(set(hashes))
        redundancy = complement_ppm(ratio_ppm(unique, len(hashes)))
        score = complement_ppm(redundancy)
        return _score("lexical_uniqueness_ppm", score, threshold_ppm, score < threshold_ppm,
                      redundancy_ppm=redundancy)

    if operation == "cross_lingual_bidirectional_coverage":
        forward = need_int(row, "forward_aligned_count", minimum=0)
        reverse = need_int(row, "reverse_aligned_count", minimum=0)
        source_count = need_int(row, "source_count", minimum=0)
        target_count = need_int(row, "target_count", minimum=0)
        if source_count == 0 or target_count == 0:
            raise InsufficientData("cross_lingual_denominator_zero")
        if forward > source_count or reverse > target_count:
            raise InvalidData("aligned_count_exceeds_entity_count")
        score = min(ratio_ppm(forward, source_count), ratio_ppm(reverse, target_count))
        return _score("bidirectional_coverage_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "evidence_contradiction_guard":
        supported = need_int(row, "supported_claims", minimum=0)
        contradicted = need_int(row, "contradicted_claims", minimum=0)
        unknown = need_int(row, "unknown_claims", minimum=0)
        total = supported + contradicted + unknown
        if total == 0:
            raise InsufficientData("claims_evidence_empty")
        contradiction = ratio_ppm(contradicted, total)
        score = complement_ppm(contradiction)
        return _score("evidence_consistency_ppm", score, threshold_ppm, score < threshold_ppm,
                      contradiction_ppm=contradiction)

    if operation == "prior_dominance_guard":
        prior = _need_ppm(row, "prior_probability_ppm")
        evidence_count = need_int(row, "evidence_count", minimum=0)
        minimum = need_int(row, "minimum_evidence_count", minimum=0)
        if minimum == 0:
            raise InsufficientData("minimum_evidence_count_zero")
        evidence_coverage = ratio_ppm(min(evidence_count, minimum), minimum)
        dominance_risk = (prior * complement_ppm(evidence_coverage)) // PPM
        score = complement_ppm(dominance_risk)
        return _score("prior_dominance_safety_ppm", score, threshold_ppm, score < threshold_ppm,
                      dominance_risk_ppm=dominance_risk)

    if operation == "posterior_update_stability":
        series = _need_ppm_list(row, "posterior_series_ppm")
        if len(series) < 2:
            raise InsufficientData("posterior_series_ppm_too_short")
        max_delta = max(abs(right - left) for left, right in zip(series, series[1:]))
        score = complement_ppm(max_delta)
        return _score("posterior_stability_ppm", score, threshold_ppm, score < threshold_ppm,
                      maximum_adjacent_delta_ppm=max_delta)

    if operation == "semantic_cluster_cohesion":
        values = _need_ppm_list(row, "intra_cluster_similarity_ppm")
        score = _mean(values, "intra_cluster_similarity_ppm_empty")
        return _score("cluster_cohesion_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "entity_transition_consistency":
        valid = need_int(row, "valid_transitions", minimum=0)
        total = need_int(row, "total_transitions", minimum=0)
        if total == 0:
            raise InsufficientData("total_transitions_zero")
        if valid > total:
            raise InvalidData("valid_transitions_exceed_total")
        score = ratio_ppm(valid, total)
        return _score("transition_consistency_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "temporal_evidence_freshness":
        ages = need_int_list(row, "age_seconds_list", minimum=0)
        max_age = need_int(row, "max_age_seconds", minimum=0)
        if not ages:
            raise InsufficientData("age_seconds_list_empty")
        if max_age == 0:
            raise InsufficientData("max_age_seconds_zero")
        freshness = [complement_ppm(ratio_ppm(min(age, max_age), max_age)) for age in ages]
        score = sum(freshness) // len(freshness)
        return _score("mean_freshness_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "source_support_coverage":
        total = need_int(row, "claims_total", minimum=0)
        sourced = need_int(row, "claims_with_source", minimum=0)
        if total == 0:
            raise InsufficientData("claims_total_zero")
        if sourced > total:
            raise InvalidData("claims_with_source_exceed_total")
        score = ratio_ppm(sourced, total)
        return _score("source_support_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "uncertainty_margin_guard":
        top = _need_ppm(row, "top_score_ppm")
        second = _need_ppm(row, "second_score_ppm")
        if second > top:
            raise InvalidData("second_score_exceeds_top_score")
        score = top - second
        return _score("uncertainty_margin_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "claim_posterior_support":
        prior = _need_ppm(row, "claim_prior_ppm")
        support = _need_ppm(row, "support_likelihood_ppm")
        counter = _need_ppm(row, "counter_likelihood_ppm")
        posterior = _posterior_ppm(prior, support, counter)
        return _score("claim_posterior_ppm", posterior, threshold_ppm, posterior < threshold_ppm)

    if operation == "multilingual_term_consistency":
        canonical = {value.casefold() for value in need_str_list(row, "canonical_terms") if value}
        observed = {value.casefold() for value in need_str_list(row, "observed_terms") if value}
        if not canonical or not observed:
            raise InsufficientData("multilingual_terms_empty")
        pairs = _alignment_pairs(row)
        mapped = {(left.casefold(), right.casefold()) for left, right in pairs}
        hits = sum(1 for left, right in mapped if left in canonical and right in observed)
        score = ratio_ppm(hits, len(canonical))
        return _score("multilingual_consistency_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "semantic_outlier_resistance":
        scores = _need_ppm_list(row, "similarity_scores_ppm")
        minimum = _need_ppm(row, "minimum_inlier_ppm")
        if not scores:
            raise InsufficientData("similarity_scores_ppm_empty")
        inliers = sum(1 for value in scores if value >= minimum)
        score = ratio_ppm(inliers, len(scores))
        return _score("inlier_coverage_ppm", score, threshold_ppm, score < threshold_ppm)

    if operation == "posterior_rank_separation":
        ranked = _need_ppm_list(row, "ranked_posterior_ppm")
        minimum_gap = _need_ppm(row, "minimum_gap_ppm")
        if len(ranked) < 2:
            raise InsufficientData("ranked_posterior_ppm_too_short")
        if any(left < right for left, right in zip(ranked, ranked[1:])):
            raise InvalidData("ranked_posterior_ppm_not_descending")
        gaps = [left - right for left, right in zip(ranked, ranked[1:])]
        score = ratio_ppm(sum(1 for gap in gaps if gap >= minimum_gap), len(gaps))
        return _score("rank_separation_coverage_ppm", score, threshold_ppm, score < threshold_ppm,
                      minimum_gap_ppm=minimum_gap)

    raise InvalidData(f"unsupported_semantic_bayes_operation:{operation}")

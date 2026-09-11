from __future__ import annotations

from typing import Any, Dict, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, clamp_ppm, complement_ppm,
    need_int, need_int_list, need_list, need_str, need_str_list, overlap_ppm,
    ratio_ppm, subset_coverage_ppm,
)


def _bool_list_ratio(values: Sequence[Any]) -> int:
    if not values:
        raise InsufficientData("boolean_evidence_empty")
    if any(not isinstance(v, bool) for v in values):
        raise InvalidData("boolean_evidence_items_must_be_bool")
    return ratio_ppm(sum(1 for v in values if v), len(values))


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    if operation == "author_credential_completeness":
        bio = need_str(row, "bio_text"); entities = need_str_list(row, "trust_entities")
        if len(bio) < 150: raise InsufficientData("bio_text_too_short")
        score = clamp_ppm(min(PPM, len(bio) * 1200 + len(set(entities)) * 120000))
        return _score("credential_completeness_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "author_entity_proximity":
        need_str(row, "entity_a"); need_str(row, "entity_b"); distance = need_int(row, "distance", minimum=0)
        score = PPM // (distance + 1); return _score("proximity_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "author_bio_topic_alignment":
        bio = need_str_list(row, "author_bio_tokens"); topic = need_str_list(row, "page_topic_tokens")
        if len(bio) < 10: raise InsufficientData("author_bio_tokens_too_short")
        score = overlap_ppm(bio, topic); return _score("topic_overlap_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "citation_trusted_source_ratio":
        links = need_str_list(row, "outbound_links"); trusted = need_str_list(row, "whitelist_domains")
        if not links: raise InsufficientData("outbound_links_empty")
        trusted_set = {x.casefold() for x in trusted}; matched = sum(1 for link in links if any(domain in link.casefold() for domain in trusted_set))
        score = ratio_ppm(matched, len(links)); return _score("trusted_ratio_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "semantic_entity_saturation":
        body = need_str(row, "body_text"); entities = need_str_list(row, "target_entities"); words = [w.casefold() for w in body.split() if w]
        if len(body) < 500 or not entities: raise InsufficientData("semantic_saturation_evidence_insufficient")
        entity_terms = {e.casefold() for e in entities}; risk = ratio_ppm(sum(1 for word in words if word in entity_terms), len(words))
        return _score("saturation_ppm", risk, threshold_ppm, risk > threshold_ppm, healthy_high=False)
    if operation == "ymyl_medical_claim_validator":
        claims = need_list(row, "claims"); evidence = need_list(row, "scientific_consensus_evidence")
        if not claims: raise InsufficientData("claims_empty")
        if len(evidence) != len(claims): raise InvalidData("claims_consensus_length_mismatch")
        score = _bool_list_ratio(evidence); return _score("consensus_alignment_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "financial_transparency_score":
        disclosure = need_str(row, "disclosure_text"); keywords = need_str_list(row, "regulatory_keywords")
        if len(disclosure) < 50 or not keywords: raise InsufficientData("transparency_evidence_insufficient")
        lower = disclosure.casefold(); score = ratio_ppm(sum(1 for k in keywords if k.casefold() in lower), len(keywords))
        return _score("disclosure_match_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "brand_coherence_index":
        title = need_str_list(row, "title_entities"); body = need_str_list(row, "body_entities")
        if not title: raise InsufficientData("title_entities_empty")
        score = subset_coverage_ppm(title, body); return _score("coherence_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "entity_synonym_expansion":
        tokens = need_str_list(row, "raw_tokens"); graph = need_list(row, "synonym_graph")
        if len(tokens) < 20: raise InsufficientData("raw_tokens_too_short")
        for item in graph:
            if not isinstance(item, list) or len(item) != 2 or not all(isinstance(x, str) for x in item): raise InvalidData("synonym_graph_edges_invalid")
        score = ratio_ppm(min(len(graph), len(tokens)), len(tokens)); return _score("expansion_density_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "topical_authority_coverage":
        nodes = need_str_list(row, "content_nodes"); niche = need_str_list(row, "niche_vector")
        if len(nodes) < 5: raise InsufficientData("content_nodes_too_few")
        score = subset_coverage_ppm(niche, nodes); return _score("coverage_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "spacy_ner_confidence_filter":
        tokens = need_str_list(row, "ner_tokens"); conf = need_int_list(row, "confidence_ppm", minimum=0)
        if not tokens: raise InsufficientData("ner_tokens_empty")
        if len(tokens) != len(conf): raise InvalidData("ner_confidence_length_mismatch")
        if any(v > PPM for v in conf): raise InvalidData("confidence_ppm_above_one_million")
        score = sum(conf) // len(conf); return _score("mean_confidence_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "wikipedia_sameas_linker":
        entities = need_str_list(row, "detected_entities"); graph = need_str_list(row, "knowledge_graph_snapshot")
        if not entities: raise InsufficientData("detected_entities_empty")
        score = subset_coverage_ppm(entities, graph); return _score("exact_match_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "lexical_diversity_score":
        unique_tokens = need_int(row, "unique_tokens", minimum=0); total_tokens = need_int(row, "total_tokens", minimum=0)
        if total_tokens < 100: raise InsufficientData("total_tokens_below_100")
        if unique_tokens > total_tokens: raise InvalidData("unique_tokens_exceed_total")
        score = ratio_ppm(unique_tokens, total_tokens); return _score("ttr_ratio_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "intent_commercial_density":
        markers = need_int(row, "intent_markers", minimum=0); sentences = need_int(row, "total_sentences", minimum=0)
        if sentences == 0: raise InsufficientData("total_sentences_zero")
        score = ratio_ppm(min(markers, sentences), sentences); return _score("commercial_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "intent_informational_purity":
        informative = need_int(row, "informative_verbs", minimum=0); total = need_int(row, "total_verbs", minimum=0)
        if total == 0: raise InsufficientData("total_verbs_zero")
        if informative > total: raise InvalidData("informative_verbs_exceed_total")
        score = ratio_ppm(informative, total); return _score("purity_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "faq_schema_extractor":
        questions = need_str_list(row, "question_blocks"); answers = need_str_list(row, "answer_blocks")
        if not questions: raise InsufficientData("question_blocks_empty")
        score = ratio_ppm(min(len(questions), len(answers)), len(questions)); return _score("validation_score_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "text_readability_flesch_es":
        syllables = need_int(row, "syllables", minimum=0); sentences = need_int(row, "sentences", minimum=0); words = need_int(row, "words", minimum=0)
        if sentences == 0 or words == 0: raise InsufficientData("readability_denominator_zero")
        words_per_sentence_ppm = ratio_ppm(words, max(words, sentences * 20)); syllable_density_ppm = ratio_ppm(syllables, max(syllables, words * 2))
        score = complement_ppm(((words_per_sentence_ppm + syllable_density_ppm) // 2) // 2)
        return _score("readability_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "sentiment_neutrality_guard":
        pos = need_int(row, "positive_tokens", minimum=0); neg = need_int(row, "negative_tokens", minimum=0); neutral = need_int(row, "neutral_tokens", minimum=0)
        total = pos + neg + neutral
        if total == 0: raise InsufficientData("sentiment_tokens_empty")
        score = ratio_ppm(neutral, total); return _score("neutrality_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "thin_content_vector_check":
        lengths = need_int_list(row, "paragraph_lengths", minimum=0); stopword = need_int(row, "stopword_ppm", minimum=0)
        if not lengths: raise InsufficientData("paragraph_lengths_empty")
        if stopword > PPM: raise InvalidData("stopword_ppm_above_one_million")
        score = (clamp_ppm((sum(lengths) // len(lengths)) * 5000) + complement_ppm(stopword)) // 2
        return _score("value_density_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "geographic_entity_isolation":
        locations = need_str_list(row, "location_tokens"); region = need_str(row, "target_region")
        if not locations: raise InsufficientData("location_tokens_empty")
        score = PPM if region.casefold() in {x.casefold() for x in locations} else 0
        return _score("geo_alignment_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "heading_semantic_progression":
        h1 = need_str_list(row, "h1_tokens"); h2 = need_str_list(row, "h2_tokens"); h3 = need_str_list(row, "h3_tokens")
        if not h2: raise InsufficientData("h2_tokens_empty")
        s12 = overlap_ppm(h1, h2); s23 = overlap_ppm(h2, h3) if h3 else s12; score = (s12 + s23) // 2
        return _score("progression_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "clickbait_headline_filter":
        title = need_str_list(row, "title_tokens"); patterns = need_str_list(row, "clickbait_patterns")
        if not title: raise InsufficientData("title_tokens_empty")
        pats = {p.casefold() for p in patterns}; risk = ratio_ppm(sum(1 for token in title if token.casefold() in pats), len(title)); score = complement_ppm(risk)
        return _score("safety_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "ecom_product_attribute_extractor":
        description = need_str(row, "product_description"); attrs = need_str_list(row, "attribute_matrix")
        if len(description) < 50 or not attrs: raise InsufficientData("product_attribute_evidence_insufficient")
        lower = description.casefold(); score = ratio_ppm(sum(1 for a in attrs if a.casefold() in lower), len(attrs))
        return _score("extraction_precision_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "user_review_spam_detector":
        review = need_str(row, "review_text"); signals = need_list(row, "metadata_signals")
        if len(review) < 10: raise InsufficientData("review_text_too_short")
        risk = _bool_list_ratio(signals) if signals else 0; score = complement_ppm(risk)
        return _score("legitimacy_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "knowledge_graph_divergence":
        local = need_str_list(row, "local_graph_edges"); reference = need_str_list(row, "reference_graph_edges")
        if not local: raise InsufficientData("local_graph_edges_empty")
        divergence = complement_ppm(overlap_ppm(local, reference))
        return _score("divergence_ppm", divergence, threshold_ppm, divergence > threshold_ppm, healthy_high=False)
    raise InvalidData(f"unsupported_semantic_operation:{operation}")


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool, healthy_high: bool = True) -> Dict[str, Any]:
    return {"metric_name": metric_name, "metric_ppm": clamp_ppm(metric_ppm), "threshold_ppm": threshold_ppm,
            "policy_direction": "higher_is_healthier" if healthy_high else "lower_is_healthier", "violation": bool(violation)}

from __future__ import annotations

from .mass_lot_common import *

def _search_intent(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                   config: Mapping[str, Any]) -> EvalResult:
    queries = [_req_str(row, "query") for row in rows]
    contents = [_req_str(row, "content_text") for row in rows]
    transactional = {"comprar", "precio", "contratar", "cotizar", "presupuesto", "reservar", "costo", "oferta"}
    informational = {"que", "qué", "como", "cómo", "por", "guia", "guía", "tutorial", "explicacion", "explicación"}
    comparative = {"vs", "versus", "mejor", "comparar", "comparativa", "reseña", "review"}
    redundant_adjectives = {"increible", "increíble", "unico", "único", "mejor", "perfecto", "revolucionario", "impresionante"}
    if index == 1:
        value = sum(sum(1 for token in _tokens(query) if token in transactional) for query in queries)
        return _lt_result(module_id, "transactional_modifier_mentions", value, config, 1, {}, "TRANSACTIONAL_MODIFIERS")
    if index == 2:
        gaps = 0
        details: List[Dict[str, Any]] = []
        for query, content in zip(queries, contents):
            qtokens = {token for token in _tokens(query) if len(token) > 2}
            ctokens = set(_tokens(content))
            missing = sorted(qtokens - ctokens)
            if missing:
                gaps += len(missing)
                details.append({"query": query, "missing_terms": missing})
        return _gt_result(module_id, "query_terms_missing_from_content", gaps, config, 0, {"gaps": details}, "INFORMATION_GAPS")
    if index == 3:
        value = sum(sum(1 for token in set(_tokens(query)) if token in transactional | comparative) for query in queries)
        return _lt_result(module_id, "commercial_intent_signals", value, config, 1, {}, "COMMERCIAL_INTENT")
    if index == 4:
        value = sum(len(re.findall(r"\b[\wáéíóúüñ]+\s+(?:de|para|con|por)\s+[\wáéíóúüñ]+\b", query.casefold(), flags=re.UNICODE)) for query in queries)
        return _lt_result(module_id, "prepositional_entity_links", value, config, 1, {}, "PREPOSITIONAL_ENTITY_EXTRACTION")
    if index == 5:
        clusters = set()
        for row, query in zip(rows, queries):
            labels = _list_str(row, "intent_labels")
            if labels:
                clusters.update(label.casefold() for label in labels if label.strip())
            else:
                tokens = [token for token in _tokens(query) if len(token) > 3]
                if tokens:
                    clusters.add(tokens[0])
        if not clusters:
            raise _InsufficientData("intent_clusters")
        return _lt_result(module_id, "semantic_intent_clusters", len(clusters), config, 1, {"clusters": sorted(clusters)}, "SEMANTIC_CLUSTERING")
    if index == 6:
        opportunities = 0
        for query, content in zip(queries, contents):
            if set(_tokens(query)).intersection(comparative) and not re.search(r"<(table|ul|ol)\b", content, flags=re.I):
                opportunities += 1
        return _gt_result(module_id, "comparison_snippet_opportunities", opportunities, config, 0, {}, "COMPARISON_SNIPPETS")
    if index == 7:
        pure = 0
        for query in queries:
            tokens = set(_tokens(query))
            if tokens.intersection(informational) and not tokens.intersection(transactional):
                pure += 1
        return _lt_result(module_id, "pure_informational_queries", pure, config, 1, {}, "INFORMATIONAL_INTENT")
    if index == 8:
        missing = 0
        eligible = 0
        for row, query, content in zip(rows, queries, contents):
            synonyms = _opt_dict(row, "conversion_synonyms")
            if not synonyms:
                continue
            eligible += 1
            qt = set(_tokens(query))
            ct = set(_tokens(content))
            for source, values in synonyms.items():
                if not isinstance(source, str) or not isinstance(values, list) or any(not isinstance(item, str) for item in values):
                    raise _InvalidData("conversion_synonyms")
                if source.casefold() in qt and not any(token.casefold() in ct for token in values):
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("conversion_synonyms")
        return _gt_result(module_id, "missing_conversion_synonym_coverage", missing, config, 0, {"eligible_records": eligible}, "CONVERSION_SYNONYMS")
    if index == 9:
        opportunities = 0
        for query, content in zip(queries, contents):
            enumerative = bool(re.search(r"\b(?:lista|pasos|tipos|formas|opciones|mejores|top)\b", query, flags=re.I))
            if enumerative and not re.search(r"<(ul|ol)\b", content, flags=re.I):
                opportunities += 1
        return _gt_result(module_id, "missing_list_structures", opportunities, config, 0, {}, "SEMANTIC_LIST_STRUCTURE")
    if index == 10:
        opportunities = 0
        for query, content in zip(queries, contents):
            if ("?" in query or set(_tokens(query)).intersection(informational)) and "FAQPage" not in content:
                opportunities += 1
        return _gt_result(module_id, "faq_microsection_opportunities", opportunities, config, 0, {}, "FAQ_MICROSECTIONS")
    if index == 11:
        missing = 0
        for query, content in zip(queries, contents):
            normalized_query = " ".join(_tokens(query))
            normalized_content = " ".join(_tokens(content))
            if normalized_query and normalized_query not in normalized_content:
                missing += 1
        return _gt_result(module_id, "exact_query_phrase_gaps", missing, config, 0, {}, "EXACT_SEARCH_MATCH")
    if index == 12:
        difficult = 0
        averages: List[int] = []
        for content in contents:
            sentences = _sentences(_text_from_html(content))
            if not sentences:
                raise _InsufficientData("sentences")
            avg = sum(len(_tokens(sentence)) for sentence in sentences) // len(sentences)
            averages.append(avg)
            if avg > 25:
                difficult += 1
        return _gt_result(module_id, "hard_to_read_documents", difficult, config, 0, {"average_sentence_words": averages}, "READABILITY")
    if index == 13:
        mismatch = 0
        overlaps: List[int] = []
        for row, query in zip(rows, queries):
            title = _opt_str(row, "title")
            if not title:
                continue
            q = set(_tokens(query))
            t = set(_tokens(title))
            if not q:
                continue
            overlap = _ppm(len(q & t), len(q))
            overlaps.append(overlap)
            if overlap < 300_000:
                mismatch += 1
        if not overlaps:
            raise _InsufficientData("title")
        return _gt_result(module_id, "low_query_title_logic_overlap", mismatch, config, 0, {"overlap_ppm": overlaps}, "CROSS_LOGIC_MATCH")
    if index == 14:
        weak = 0
        eligible = 0
        for query, content in zip(queries, contents):
            if not ("?" in query or set(_tokens(query)).intersection(informational)):
                continue
            eligible += 1
            opening = _tokens(_text_from_html(content)[:320])
            if len(opening) < 20:
                weak += 1
        if eligible == 0:
            raise _InsufficientData("question_queries")
        return _gt_result(module_id, "weak_direct_answer_openings", weak, config, 0, {"eligible_queries": eligible}, "DIRECT_ANSWER_DENSITY")
    if index == 15:
        missing = 0
        eligible = 0
        for row in rows:
            alts = _list_str(row, "image_alts")
            if not alts:
                continue
            eligible += 1
            missing += sum(1 for alt in alts if not _tokens(alt))
        if eligible == 0:
            raise _InsufficientData("image_alts")
        return _gt_result(module_id, "empty_image_semantic_identifiers", missing, config, 0, {"eligible_records": eligible}, "IMAGE_SEMANTIC_IDENTIFIERS")
    if index == 16:
        gaps = 0
        eligible = 0
        for row in rows:
            title = _opt_str(row, "title")
            entities = _list_str(row, "entities")
            if not title or not entities:
                continue
            eligible += 1
            title_tokens = set(_tokens(title))
            if not any(set(_tokens(entity)).intersection(title_tokens) for entity in entities):
                gaps += 1
        if eligible == 0:
            raise _InsufficientData("title_entities")
        return _gt_result(module_id, "titles_without_entity_coverage", gaps, config, 0, {"eligible_records": eligible}, "ENTITY_RICH_TITLES")
    if index == 17:
        bad = 0
        eligible = 0
        lengths: List[int] = []
        for row in rows:
            desc = _opt_str(row, "meta_description")
            title = _opt_str(row, "title")
            if not desc:
                continue
            eligible += 1
            lengths.append(len(desc))
            if len(desc) < 70 or len(desc) > 160 or (title and desc.casefold() == title.casefold()):
                bad += 1
        if eligible == 0:
            raise _InsufficientData("meta_description")
        return _gt_result(module_id, "meta_description_quality_issues", bad, config, 0, {"lengths": lengths}, "META_DESCRIPTION_RESTRUCTURE")
    if index == 18:
        value = sum(sum(1 for token in _tokens(content) if token in redundant_adjectives) for content in contents)
        return _gt_result(module_id, "redundant_adjective_mentions", value, config, 3, {}, "ANTI_SPAM_ADJECTIVE_FILTER")
    if index == 19:
        stale = 0
        eligible = 0
        for row, query in zip(rows, queries):
            if "age_days" not in row:
                continue
            age = _req_int(row, "age_days", 100_000)
            temporal = bool(re.search(r"\b(?:202[0-9]|actual|hoy|este\s+año|reciente|nuevo)\b", query, flags=re.I))
            if temporal:
                eligible += 1
                if age > 365:
                    stale += 1
        if eligible == 0:
            raise _InsufficientData("temporal_queries")
        return _gt_result(module_id, "stale_temporal_content", stale, config, 0, {"eligible_records": eligible}, "CONTENT_FRESHNESS")
    if index == 20:
        categories = set()
        for row in rows:
            category = _opt_str(row, "niche")
            if category:
                categories.add(category.casefold())
        if not categories:
            raise _InsufficientData("niche")
        value = len(categories)
        return _gt_result(module_id, "niche_entity_groups", value, config, 12, {"groups": sorted(categories)}, "NICHE_ENTITY_GROUPING")
    if index == 21:
        irrelevant = 0
        eligible = 0
        for row, content in zip(rows, contents):
            links = _opt_list(row, "outbound_links")
            content_tokens = set(_tokens(_text_from_html(content)))
            for link in links:
                if not isinstance(link, dict):
                    raise _InvalidData("outbound_links")
                anchor = link.get("anchor")
                if not isinstance(anchor, str):
                    raise _InvalidData("outbound_link.anchor")
                eligible += 1
                if not content_tokens.intersection(_tokens(anchor)):
                    irrelevant += 1
        if eligible == 0:
            raise _InsufficientData("outbound_links")
        return _gt_result(module_id, "irrelevant_outbound_links", irrelevant, config, 0, {"eligible_links": eligible}, "OUTBOUND_LINK_RELEVANCE")
    if index == 22:
        missing = 0
        eligible = 0
        for row, query in zip(rows, queries):
            anchors = _list_str(row, "internal_anchors")
            if not anchors:
                continue
            eligible += 1
            q = set(_tokens(query))
            if q and not any(q.intersection(_tokens(anchor)) for anchor in anchors):
                missing += 1
        if eligible == 0:
            raise _InsufficientData("internal_anchors")
        return _gt_result(module_id, "queries_without_relevant_internal_anchor", missing, config, 0, {"eligible_records": eligible}, "INTERNAL_ANCHOR_OPTIMIZATION")
    if index == 23:
        orphan = 0
        eligible = 0
        for row in rows:
            entities = set(entity.casefold() for entity in _list_str(row, "entities"))
            nav = set(entity.casefold() for entity in _list_str(row, "navigation_entities"))
            if not entities:
                continue
            eligible += 1
            orphan += len(entities - nav)
        if eligible == 0:
            raise _InsufficientData("entities")
        return _gt_result(module_id, "orphan_navigation_entities", orphan, config, 0, {"eligible_records": eligible}, "NAVIGATION_ENTITY_COVERAGE")
    if index == 24:
        cross = 0
        eligible = 0
        for row in rows:
            silo = _opt_str(row, "silo")
            links = _opt_list(row, "internal_link_targets")
            if not silo or not links:
                continue
            eligible += 1
            for link in links:
                if not isinstance(link, dict):
                    raise _InvalidData("internal_link_targets")
                target_silo = link.get("silo")
                if not isinstance(target_silo, str):
                    raise _InvalidData("target_silo")
                if target_silo.casefold() != silo.casefold():
                    cross += 1
        if eligible == 0:
            raise _InsufficientData("silo")
        return _gt_result(module_id, "cross_silo_internal_links", cross, config, 2, {"eligible_records": eligible}, "SILO_ARCHITECTURE")
    if index == 25:
        coverage: List[int] = []
        for row, query, content in zip(rows, queries, contents):
            topic = set(_tokens(query))
            body = set(_tokens(_text_from_html(content)))
            if topic:
                coverage.append(_ppm(len(topic & body), len(topic)))
        if not coverage:
            raise _InsufficientData("topic_tokens")
        value = sum(coverage) // len(coverage)
        return _lt_result(module_id, "topical_authority_coverage_ppm", value, config, 700_000, {"document_coverage_ppm": coverage}, "TOPICAL_AUTHORITY", PPM)
    raise _InvalidData("UNKNOWN_SEARCH_INTENT_OPERATION")

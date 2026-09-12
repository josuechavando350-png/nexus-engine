from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm,
    config_phrases, contains_any_phrase, gini_ppm, jaccard_ppm,
    normalize_text, phrase_tokens, tokens,
)

SEMANTIC = "LOCAL_TOPICAL_COVERAGE_DIAGNOSTIC_NOT_RANKING_MANIPULATION"
EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"

def _rows(normalized: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    if not raw:
        raise InsufficientData(f"{key}_empty")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out

def _score_rows(rows: Sequence[Mapping[str, Any]], predicate, *, label: str) -> tuple[int, dict[str, Any]]:
    if not rows:
        raise InsufficientData(f"{label}_empty")
    healthy = sum(1 for row in rows if predicate(row))
    return bounded_ratio_ppm(healthy, len(rows)), {"eligible_records": len(rows), "healthy_records": healthy}

def _phrase_set(config: Mapping[str, Any], key: str) -> tuple[tuple[str, ...], ...]:
    return config_phrases(config, key)

def _has(seq: Sequence[str], phrases: Sequence[Sequence[str]]) -> bool:
    return contains_any_phrase(seq, phrases)

def _text_tokens(value: Any) -> list[str]:
    return tokens(value if isinstance(value, str) else "")

def _query_tokens(row: Mapping[str, Any]) -> list[str]:
    if isinstance(row.get("query_tokens"), list):
        return [str(v) for v in row.get("query_tokens", [])]
    return _text_tokens(row.get("query"))

def _content_map(normalized: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    rows = normalized.get("content_documents", [])
    if not isinstance(rows, list):
        raise InvalidData("content_documents_must_be_list")
    if not rows:
        raise InsufficientData("content_documents_empty")
    return {str(row.get("document_id")): row for row in rows if isinstance(row, Mapping) and row.get("document_id")}

def _local_identity_tokens(normalized: Mapping[str, Any]) -> tuple[set[str], set[str], set[str]]:
    rows = normalized.get("local_business_records", [])
    if not isinstance(rows, list) or not rows:
        raise InsufficientData("local_business_records_empty")
    names: set[str] = set()
    addresses: set[str] = set()
    phones: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            raise InvalidData("local_business_record_not_mapping")
        names.update(tokens(row.get("name")))
        addresses.update(tokens(row.get("address")))
        phone = row.get("phone")
        if isinstance(phone, str) and phone:
            phones.add(phone)
    return names, addresses, phones

def _entity_rows(semantic_rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    out: list[Mapping[str, Any]] = []
    for row in semantic_rows:
        entities = row.get("entities")
        if not isinstance(entities, list):
            continue
        for entity in entities:
            if isinstance(entity, Mapping):
                out.append(entity)
    return out

def _intent_metric(mode: str, normalized: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    if not mode.startswith((
        "intent_", "transactional_", "informational_", "comparative_", "query_title_",
        "meta_description_", "image_alt_", "internal_anchor_", "navigation_entity_",
        "silo_", "internal_link_target_", "niche_", "conversion_synonym_",
    )):
        return None
    rows = _rows(normalized, "search_intent_records")
    transactional = {"comprar", "precio", "contratar", "cotizar", "presupuesto", "reservar", "costo", "consulta", "abogado", "defensa"}
    informational = {"que", "qué", "como", "cómo", "cuando", "cuándo", "por", "guia", "guía", "explicacion", "explicación"}
    comparative = {"vs", "versus", "mejor", "comparar", "comparativa", "reseña", "review"}
    if mode == "intent_label_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("intent_labels"), list) and bool(r.get("intent_labels")), label=mode)
    if mode == "transactional_signal_coverage":
        return _score_rows(rows, lambda r: bool(set(_text_tokens(r.get("query"))) & transactional), label=mode)
    if mode == "informational_signal_coverage":
        return _score_rows(rows, lambda r: bool(set(_text_tokens(r.get("query"))) & informational) or "?" in str(r.get("query") or ""), label=mode)
    if mode == "comparative_signal_coverage":
        return _score_rows(rows, lambda r: bool(set(_text_tokens(r.get("query"))) & comparative), label=mode)
    if mode == "query_title_alignment":
        def aligned(r):
            q = set(_text_tokens(r.get("query")))
            t = set(_text_tokens(r.get("title")))
            if not q or not t:
                return False
            return bounded_ratio_ppm(len(q & t), len(q)) >= 200_000
        return _score_rows(rows, aligned, label=mode)
    if mode == "meta_description_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("meta_description"), str) and bool(r.get("meta_description", "").strip()), label=mode)
    if mode == "intent_entity_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("entities"), list) and bool(r.get("entities")), label=mode)
    if mode == "image_alt_presence":
        def image_alt(r):
            alts = r.get("image_alts")
            return isinstance(alts, list) and bool(alts) and all(isinstance(v, str) and bool(v.strip()) for v in alts)
        return _score_rows(rows, image_alt, label=mode)
    if mode == "internal_anchor_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("internal_anchors"), list) and bool(r.get("internal_anchors")), label=mode)
    if mode == "navigation_entity_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("navigation_entities"), list) and bool(r.get("navigation_entities")), label=mode)
    if mode == "silo_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("silo"), str) and bool(r.get("silo", "").strip()), label=mode)
    if mode == "internal_link_target_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("internal_link_targets"), list) and bool(r.get("internal_link_targets")), label=mode)
    if mode == "intent_freshness":
        return _score_rows(rows, lambda r: isinstance(r.get("age_days"), int) and not isinstance(r.get("age_days"), bool) and 0 <= r.get("age_days") <= 365, label=mode)
    if mode == "niche_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("niche"), str) and bool(r.get("niche", "").strip()), label=mode)
    if mode == "conversion_synonym_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("conversion_synonyms"), Mapping) and bool(r.get("conversion_synonyms")), label=mode)
    return None

def _semantic_metric(mode: str, normalized: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    if not mode.startswith("semantic_"):
        return None
    rows = _rows(normalized, "semantic_text_records")
    if mode == "semantic_entity_graph":
        return _score_rows(rows, lambda r: isinstance(r.get("entities"), list) and bool(r.get("entities")), label=mode)
    if mode in {"semantic_org_entity", "semantic_geo_entity", "semantic_service_entity", "semantic_event_entity"}:
        expected = {
            "semantic_org_entity": {"ORG", "ORGANIZATION"},
            "semantic_geo_entity": {"GPE", "LOCATION", "PLACE"},
            "semantic_service_entity": {"SERVICE", "PRODUCT"},
            "semantic_event_entity": {"EVENT", "PROCESS"},
        }[mode]
        return _score_rows(rows, lambda r: any(str(e.get("type") or "").upper() in expected for e in _entity_rows([r])), label=mode)
    if mode == "semantic_related_edges":
        return _score_rows(rows, lambda r: any(isinstance(e.get("related_ids"), list) and bool(e.get("related_ids")) for e in _entity_rows([r])), label=mode)
    if mode == "semantic_entity_salience":
        return _score_rows(rows, lambda r: any(isinstance(e.get("salience_ppm"), int) and not isinstance(e.get("salience_ppm"), bool) and e.get("salience_ppm") >= 300_000 for e in _entity_rows([r])), label=mode)
    if mode == "semantic_language_consistency":
        expected_locale = config.get("project_locale")
        if isinstance(expected_locale, str) and expected_locale.strip():
            return _score_rows(rows, lambda r: normalize_text(r.get("locale")) == normalize_text(expected_locale), label=mode)
        return _score_rows(rows, lambda r: isinstance(r.get("locale"), str) and bool(r.get("locale", "").strip()), label=mode)
    if mode == "semantic_heading_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("headings"), list) and bool(r.get("headings")), label=mode)
    if mode == "semantic_link_anchor_presence":
        def links(r):
            raw = r.get("links")
            return isinstance(raw, list) and any(isinstance(v, Mapping) and isinstance(v.get("anchor"), str) and bool(v.get("anchor", "").strip()) for v in raw)
        return _score_rows(rows, links, label=mode)
    if mode == "semantic_intent_presence":
        return _score_rows(rows, lambda r: isinstance(r.get("intent_labels"), list) and bool(r.get("intent_labels")), label=mode)
    if mode == "semantic_external_context":
        return _score_rows(rows, lambda r: any(isinstance(e.get("external_context"), Mapping) and bool(e.get("external_context")) for e in _entity_rows([r])), label=mode)
    if mode == "semantic_entity_properties":
        return _score_rows(rows, lambda r: any(isinstance(e.get("properties"), Mapping) and bool(e.get("properties")) for e in _entity_rows([r])), label=mode)
    if mode == "semantic_schema_types":
        return _score_rows(rows, lambda r: any(isinstance(e.get("schema_types"), Mapping) and bool(e.get("schema_types")) for e in _entity_rows([r])), label=mode)
    if mode == "semantic_entity_cache":
        return _score_rows(rows, lambda r: isinstance(r.get("entity_cache"), Mapping) and bool(r.get("entity_cache")), label=mode)
    raise InvalidData(f"unsupported_semantic_topical_mode:{mode}")

def _phrase_metric(mode: str, normalized: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    key_map = {
        "content_service_coverage": ("local_verified_service_terms", "content"),
        "content_location_coverage": ("local_verified_location_terms", "content"),
        "content_commercial_coverage": ("local_commercial_terms", "content"),
        "content_urgency_coverage": ("local_urgency_terms", "content"),
        "content_question_coverage": ("local_question_terms", "content"),
        "content_brand_coverage": ("local_brand_terms", "content"),
        "query_service_coverage": ("local_verified_service_terms", "query"),
        "query_location_coverage": ("local_verified_location_terms", "query"),
        "query_commercial_coverage": ("local_commercial_terms", "query"),
        "query_urgency_coverage": ("local_urgency_terms", "query"),
        "query_question_coverage": ("local_question_terms", "query"),
        "query_brand_coverage": ("local_brand_terms", "query"),
    }
    if mode in key_map:
        key, source = key_map[mode]
        phrases = _phrase_set(config, key)
        if source == "content":
            docs = list(_content_map(normalized).values())
            return _score_rows(docs, lambda r: _has(r.get("tokens", []), phrases), label=mode)
        search = normalized.get("search_performance_records", [])
        if not isinstance(search, list) or not search:
            raise InsufficientData("search_performance_records_empty")
        return _score_rows(search, lambda r: _has(_query_tokens(r), phrases), label=mode)
    if mode == "query_longtail_support":
        search = normalized.get("search_performance_records", [])
        if not isinstance(search, list) or not search:
            raise InsufficientData("search_performance_records_empty")
        docs = _content_map(normalized)
        longtail = [r for r in search if len(_query_tokens(r)) >= 4]
        if not longtail:
            raise InsufficientData("longtail_search_records_empty")
        return _score_rows(longtail, lambda r: str(r.get("page_url")) in docs, label=mode)
    if mode in {"query_service_location_joint", "query_commercial_location_joint"}:
        search = normalized.get("search_performance_records", [])
        if not isinstance(search, list) or not search:
            raise InsufficientData("search_performance_records_empty")
        left_key = "local_verified_service_terms" if mode == "query_service_location_joint" else "local_commercial_terms"
        left = _phrase_set(config, left_key)
        right = _phrase_set(config, "local_verified_location_terms")
        return _score_rows(search, lambda r: _has(_query_tokens(r), left) and _has(_query_tokens(r), right), label=mode)
    return None

def _joint_metric(mode: str, normalized: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    definitions = {
        "lattice_service_commercial_content": ("content", "local_verified_service_terms", "local_commercial_terms"),
        "lattice_service_location_content": ("content", "local_verified_service_terms", "local_verified_location_terms"),
        "lattice_service_urgency_content": ("content", "local_verified_service_terms", "local_urgency_terms"),
        "lattice_service_question_content": ("content", "local_verified_service_terms", "local_question_terms"),
        "lattice_brand_service_content": ("content", "local_brand_terms", "local_verified_service_terms"),
        "lattice_brand_location_content": ("content", "local_brand_terms", "local_verified_location_terms"),
        "lattice_service_commercial_query": ("query", "local_verified_service_terms", "local_commercial_terms"),
        "lattice_service_location_query": ("query", "local_verified_service_terms", "local_verified_location_terms"),
        "lattice_service_urgency_query": ("query", "local_verified_service_terms", "local_urgency_terms"),
        "lattice_service_question_query": ("query", "local_verified_service_terms", "local_question_terms"),
        "lattice_brand_service_query": ("query", "local_brand_terms", "local_verified_service_terms"),
        "lattice_brand_location_query": ("query", "local_brand_terms", "local_verified_location_terms"),
    }
    if mode in definitions:
        source, left_key, right_key = definitions[mode]
        left = _phrase_set(config, left_key)
        right = _phrase_set(config, right_key)
        if source == "content":
            rows = list(_content_map(normalized).values())
            return _score_rows(rows, lambda r: _has(r.get("tokens", []), left) and _has(r.get("tokens", []), right), label=mode)
        rows = normalized.get("search_performance_records", [])
        if not isinstance(rows, list) or not rows:
            raise InsufficientData("search_performance_records_empty")
        return _score_rows(rows, lambda r: _has(_query_tokens(r), left) and _has(_query_tokens(r), right), label=mode)

    if mode == "lattice_service_location_specialization":
        service = _phrase_set(config, "local_verified_service_terms")
        location = _phrase_set(config, "local_verified_location_terms")
        search = normalized.get("search_performance_records", [])
        if not isinstance(search, list) or not search:
            raise InsufficientData("search_performance_records_empty")
        docs = _content_map(normalized)
        eligible = [r for r in search if _has(_query_tokens(r), service) and _has(_query_tokens(r), location)]
        if not eligible:
            raise InsufficientData("service_location_search_empty")
        healthy = 0
        for row in eligible:
            doc = docs.get(str(row.get("page_url")))
            if doc and _has(doc.get("tokens", []), service) and _has(doc.get("tokens", []), location):
                healthy += 1
        return bounded_ratio_ppm(healthy, len(eligible)), {"eligible_records": len(eligible), "healthy_records": healthy}

    if mode in {"lattice_service_location_cells", "lattice_service_location_single_owner"}:
        raw_services = config.get("local_service_groups")
        raw_locations = config.get("local_location_groups")
        if not isinstance(raw_services, Mapping) or not isinstance(raw_locations, Mapping):
            raise InsufficientData("service_location_groups_missing")
        service_groups = {
            normalize_text(name): tuple(phrase_tokens(v) for v in values if phrase_tokens(v))
            for name, values in raw_services.items()
            if isinstance(name, str) and isinstance(values, list)
        }
        location_groups = {
            normalize_text(name): tuple(phrase_tokens(v) for v in values if phrase_tokens(v))
            for name, values in raw_locations.items()
            if isinstance(name, str) and isinstance(values, list)
        }
        if not service_groups or not location_groups:
            raise InsufficientData("service_location_groups_empty")
        search = normalized.get("search_performance_records", [])
        if not isinstance(search, list) or not search:
            raise InsufficientData("search_performance_records_empty")
        cells: dict[tuple[str, str], set[str]] = defaultdict(set)
        for row in search:
            qt = _query_tokens(row)
            services = [name for name, phrases in service_groups.items() if phrases and _has(qt, phrases)]
            locations = [name for name, phrases in location_groups.items() if phrases and _has(qt, phrases)]
            for service in services:
                for location in locations:
                    cells[(service, location)].add(str(row.get("page_url")))
        total_possible = len(service_groups) * len(location_groups)
        if mode == "lattice_service_location_cells":
            score = bounded_ratio_ppm(min(len(cells), total_possible), total_possible)
            return score, {"observed_cells": len(cells), "possible_cells": total_possible}
        if not cells:
            raise InsufficientData("service_location_observed_cells_empty")
        healthy = sum(1 for pages in cells.values() if len(pages) == 1)
        return bounded_ratio_ppm(healthy, len(cells)), {"observed_cells": len(cells), "single_owner_cells": healthy}
    return None

def _topology_metric(mode: str, normalized: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    if not mode.startswith("topology_"):
        return None
    docs = list(_content_map(normalized).values())
    search = normalized.get("search_performance_records", [])
    if not isinstance(search, list) or not search:
        raise InsufficientData("search_performance_records_empty")
    intents = _rows(normalized, "search_intent_records")
    canon = _rows(normalized, "canonicalization_records")
    semantic = _rows(normalized, "semantic_text_records")

    if mode == "topology_content_differentiation":
        if len(docs) < 2:
            raise InsufficientData("content_pair_requires_two_documents")
        comparisons = 0
        healthy = 0
        strongest = 0
        for index, left in enumerate(docs):
            for right in docs[index + 1:]:
                similarity = jaccard_ppm(set(left.get("tokens", [])), set(right.get("tokens", [])))
                strongest = max(strongest, similarity)
                comparisons += 1
                if similarity < 700_000:
                    healthy += 1
        return bounded_ratio_ppm(healthy, comparisons), {"pair_count": comparisons, "differentiated_pairs": healthy, "strongest_similarity_ppm": strongest}

    if mode == "topology_unique_token_share":
        corpus_counts = Counter(token for doc in docs for token in set(doc.get("tokens", [])))
        healthy = 0
        details = []
        for doc in docs:
            unique = {token for token in set(doc.get("tokens", [])) if corpus_counts[token] == 1}
            total = set(doc.get("tokens", []))
            share = bounded_ratio_ppm(len(unique), len(total)) if total else 0
            details.append({"document_id": doc.get("document_id"), "unique_token_share_ppm": share})
            if share >= 50_000:
                healthy += 1
        return bounded_ratio_ppm(healthy, len(docs)), {"document_metrics": details, "healthy_records": healthy}

    if mode == "topology_page_query_specialization":
        by_page: dict[str, list[set[str]]] = defaultdict(list)
        for row in search:
            by_page[str(row.get("page_url"))].append(set(_query_tokens(row)))
        healthy = 0
        for query_sets in by_page.values():
            counts = Counter(token for query_set in query_sets for token in query_set)
            repeated = {token for token, count in counts.items() if count >= 2}
            union = set().union(*query_sets) if query_sets else set()
            if union and bounded_ratio_ppm(len(repeated), len(union)) >= 100_000:
                healthy += 1
        return bounded_ratio_ppm(healthy, len(by_page)), {"page_count": len(by_page), "specialized_pages": healthy}

    if mode == "topology_query_single_owner":
        pages: dict[str, set[str]] = defaultdict(set)
        for row in search:
            pages[str(row.get("query"))].add(str(row.get("page_url")))
        healthy = sum(1 for values in pages.values() if len(values) == 1)
        return bounded_ratio_ppm(healthy, len(pages)), {"query_count": len(pages), "single_owner_queries": healthy}

    if mode == "topology_page_query_overlap":
        by_page: dict[str, set[str]] = defaultdict(set)
        for row in search:
            by_page[str(row.get("page_url"))].add(str(row.get("query")))
        page_items = sorted(by_page.items())
        if len(page_items) < 2:
            raise InsufficientData("page_query_overlap_requires_two_pages")
        comparisons = 0
        healthy = 0
        strongest = 0
        for index, (_, left) in enumerate(page_items):
            for _, right in page_items[index + 1:]:
                overlap = jaccard_ppm(left, right) if left or right else 0
                strongest = max(strongest, overlap)
                comparisons += 1
                if overlap < 500_000:
                    healthy += 1
        return bounded_ratio_ppm(healthy, comparisons), {"pair_count": comparisons, "healthy_pairs": healthy, "strongest_overlap_ppm": strongest}

    if mode == "topology_query_cluster_breadth":
        clusters = {normalize_text(row.get("query_cluster")) for row in canon if isinstance(row.get("query_cluster"), str) and row.get("query_cluster", "").strip()}
        return bounded_ratio_ppm(len(clusters), len(canon)), {"canonical_records": len(canon), "distinct_query_clusters": len(clusters)}

    if mode == "topology_silo_cluster_coherence":
        clusters = {normalize_text(row.get("query_cluster")) for row in canon if isinstance(row.get("query_cluster"), str)}
        healthy = sum(1 for row in intents if normalize_text(row.get("silo")) in clusters and normalize_text(row.get("silo")))
        return bounded_ratio_ppm(healthy, len(intents)), {"intent_records": len(intents), "coherent_silo_records": healthy}

    if mode in {"topology_internal_same_silo", "topology_internal_cross_silo"}:
        healthy = 0
        for row in intents:
            silo = normalize_text(row.get("silo"))
            targets = row.get("internal_link_targets")
            if not silo or not isinstance(targets, list):
                continue
            target_silos = {normalize_text(target.get("silo")) for target in targets if isinstance(target, Mapping)}
            if mode == "topology_internal_same_silo" and silo in target_silos:
                healthy += 1
            if mode == "topology_internal_cross_silo" and any(target and target != silo for target in target_silos):
                healthy += 1
        return bounded_ratio_ppm(healthy, len(intents)), {"intent_records": len(intents), "healthy_records": healthy}

    if mode == "topology_navigation_entity_coverage":
        entity_labels = {normalize_text(entity.get("label")) for entity in _entity_rows(semantic) if isinstance(entity.get("label"), str)}
        total = 0
        matched = 0
        for row in intents:
            nav = row.get("navigation_entities")
            if not isinstance(nav, list):
                continue
            for item in nav:
                if not isinstance(item, str):
                    continue
                total += 1
                if normalize_text(item) in entity_labels:
                    matched += 1
        if total == 0:
            raise InsufficientData("navigation_entity_items_empty")
        return bounded_ratio_ppm(matched, total), {"navigation_entities": total, "semantic_entity_matches": matched}

    if mode == "topology_canonical_cluster_coverage":
        return _score_rows(canon, lambda r: isinstance(r.get("query_cluster"), str) and bool(r.get("query_cluster", "").strip()), label=mode)

    if mode == "topology_canonical_entity_coverage":
        return _score_rows(canon, lambda r: isinstance(r.get("entities"), list) and bool(r.get("entities")), label=mode)

    if mode == "topology_gini_balance":
        raw_groups = config.get("local_service_groups")
        if not isinstance(raw_groups, Mapping):
            raise InsufficientData("local_service_groups_missing")
        weights = []
        for _, values in sorted(raw_groups.items()):
            if not isinstance(values, list):
                continue
            phrases = tuple(phrase_tokens(v) for v in values if phrase_tokens(v))
            weight = sum(int(row.get("impressions", 0)) for row in search if phrases and _has(_query_tokens(row), phrases))
            weights.append(weight)
        if not any(weights):
            raise InsufficientData("service_group_impressions_empty")
        inequality = gini_ppm(weights)
        return complement_ppm(inequality), {"service_group_count": len(weights), "gini_ppm": inequality}

    if mode == "topology_pareto_balance":
        by_page: dict[str, int] = defaultdict(int)
        for row in search:
            by_page[str(row.get("page_url"))] += int(row.get("impressions", 0))
        total = sum(by_page.values())
        if total <= 0:
            raise InsufficientData("search_impressions_empty")
        target = (total * 800_000 + PPM - 1) // PPM
        running = 0
        needed = 0
        for _, weight in sorted(by_page.items(), key=lambda kv: (-kv[1], kv[0])):
            needed += 1
            running += weight
            if running >= target:
                break
        return bounded_ratio_ppm(needed, len(by_page)), {"page_count": len(by_page), "pages_for_80pct_impressions": needed}

    if mode == "topology_mixed_intent_review":
        families = (
            ("commercial", _phrase_set(config, "local_commercial_terms")),
            ("service", _phrase_set(config, "local_verified_service_terms")),
            ("location", _phrase_set(config, "local_verified_location_terms")),
            ("urgency", _phrase_set(config, "local_urgency_terms")),
            ("question", _phrase_set(config, "local_question_terms")),
            ("brand", _phrase_set(config, "local_brand_terms")),
        )
        page_families: dict[str, set[str]] = defaultdict(set)
        for row in search:
            qt = _query_tokens(row)
            for name, phrases in families:
                if _has(qt, phrases):
                    page_families[str(row.get("page_url"))].add(name)
        healthy = sum(1 for values in page_families.values() if len(values) <= 4)
        return bounded_ratio_ppm(healthy, len(page_families)), {"page_count": len(page_families), "review_safe_pages": healthy}
    raise InvalidData(f"unsupported_topology_mode:{mode}")

def _local_metric(mode: str, normalized: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    if not mode.startswith(("local_", "verified_", "unsupported_", "topical_whitehat_")):
        return None
    docs = list(_content_map(normalized).values())
    search = normalized.get("search_performance_records", [])
    if not isinstance(search, list) or not search:
        raise InsufficientData("search_performance_records_empty")
    semantic = _rows(normalized, "semantic_text_records")
    names, addresses, phones = _local_identity_tokens(normalized)
    service = _phrase_set(config, "local_verified_service_terms")
    location = _phrase_set(config, "local_verified_location_terms")
    brand = _phrase_set(config, "local_brand_terms")

    def identity_in_doc(doc):
        doc_tokens = set(doc.get("tokens", []))
        name_ok = bool(names and names.intersection(doc_tokens))
        address_ok = bool(addresses and addresses.intersection(doc_tokens))
        text_digits = "".join(ch for ch in str(doc.get("text") or "") if ch.isdecimal())
        phone_ok = any(phone and phone in text_digits for phone in phones)
        return name_ok or address_ok or phone_ok

    if mode == "local_name_content_corroboration":
        return _score_rows(docs, lambda d: bool(names.intersection(set(d.get("tokens", [])))), label=mode)
    if mode == "local_address_content_corroboration":
        return _score_rows(docs, lambda d: bool(addresses.intersection(set(d.get("tokens", [])))), label=mode)
    if mode == "local_phone_content_corroboration":
        return _score_rows(docs, lambda d: any(phone and phone in "".join(ch for ch in str(d.get("text") or "") if ch.isdecimal()) for phone in phones), label=mode)
    if mode == "local_service_identity_joint":
        return _score_rows(docs, lambda d: _has(d.get("tokens", []), service) and identity_in_doc(d), label=mode)
    if mode == "local_location_identity_joint":
        return _score_rows(docs, lambda d: _has(d.get("tokens", []), location) and identity_in_doc(d), label=mode)
    if mode == "local_brand_identity_joint":
        return _score_rows(docs, lambda d: _has(d.get("tokens", []), brand) and identity_in_doc(d), label=mode)

    entity_rows = _entity_rows(semantic)
    service_entities = [e for e in entity_rows if str(e.get("type") or "").upper() in {"SERVICE", "PRODUCT"}]
    geo_entities = [e for e in entity_rows if str(e.get("type") or "").upper() in {"GPE", "LOCATION", "PLACE"}]
    service_entity_tokens = {token for entity in service_entities for token in tokens(entity.get("label"))}
    geo_entity_tokens = {token for entity in geo_entities for token in tokens(entity.get("label"))}

    if mode == "local_service_semantic_entity_joint":
        semantic_texts = [tokens(row.get("text")) for row in semantic]
        healthy = sum(1 for seq in semantic_texts if _has(seq, service) and service_entity_tokens.intersection(seq))
        return bounded_ratio_ppm(healthy, len(semantic_texts)), {"semantic_records": len(semantic_texts), "healthy_records": healthy}
    if mode == "local_location_semantic_entity_joint":
        semantic_texts = [tokens(row.get("text")) for row in semantic]
        healthy = sum(1 for seq in semantic_texts if _has(seq, location) and geo_entity_tokens.intersection(seq))
        return bounded_ratio_ppm(healthy, len(semantic_texts)), {"semantic_records": len(semantic_texts), "healthy_records": healthy}
    if mode == "local_service_query_entity_joint":
        service_queries = [row for row in search if _has(_query_tokens(row), service)]
        if not service_queries:
            raise InsufficientData("service_queries_empty")
        score = PPM if service_entities else 0
        return score, {"service_query_count": len(service_queries), "semantic_service_entity_count": len(service_entities)}
    if mode == "local_location_query_entity_joint":
        location_queries = [row for row in search if _has(_query_tokens(row), location)]
        if not location_queries:
            raise InsufficientData("location_queries_empty")
        score = PPM if geo_entities else 0
        return score, {"location_query_count": len(location_queries), "semantic_geo_entity_count": len(geo_entities)}

    if mode in {"verified_service_vocabulary", "unsupported_service_absence"}:
        broad = {phrase for phrase in _phrase_set(config, "local_service_terms")}
        verified = {phrase for phrase in service}
        score = bounded_ratio_ppm(len(broad & verified), len(broad)) if broad else PPM
        return score, {"configured_phrase_count": len(broad), "verified_phrase_count": len(broad & verified), "unsupported_phrase_count": len(broad - verified)}
    if mode in {"verified_location_vocabulary", "unsupported_location_absence"}:
        broad = {phrase for phrase in _phrase_set(config, "local_location_terms")}
        verified = {phrase for phrase in location}
        score = bounded_ratio_ppm(len(broad & verified), len(broad)) if broad else PPM
        return score, {"configured_phrase_count": len(broad), "verified_phrase_count": len(broad & verified), "unsupported_phrase_count": len(broad - verified)}

    if mode == "topical_whitehat_value_density":
        service_docs = sum(1 for d in docs if _has(d.get("tokens", []), service))
        location_docs = sum(1 for d in docs if _has(d.get("tokens", []), location))
        identity_docs = sum(1 for d in docs if identity_in_doc(d))
        coverage = (
            bounded_ratio_ppm(service_docs, len(docs))
            + bounded_ratio_ppm(location_docs, len(docs))
            + bounded_ratio_ppm(identity_docs, len(docs))
        ) // 3
        if len(docs) < 2:
            differentiation = PPM
        else:
            pair_scores = []
            for index, left in enumerate(docs):
                for right in docs[index + 1:]:
                    pair_scores.append(jaccard_ppm(set(left.get("tokens", [])), set(right.get("tokens", []))))
            max_similarity = max(pair_scores) if pair_scores else 0
            differentiation = complement_ppm(max_similarity)
        score = (coverage + differentiation) // 2
        return score, {"coverage_ppm": coverage, "differentiation_ppm": differentiation, "verified_service_terms_required": True, "verified_location_terms_required": True}
    raise InvalidData(f"unsupported_local_topical_mode:{mode}")

def topical_lattice_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    mode = str(spec.get("params", {}).get("mode") or "")
    result = _intent_metric(mode, normalized)
    if result is None:
        result = _semantic_metric(mode, normalized, config)
    if result is None:
        result = _phrase_metric(mode, normalized, config)
    if result is None:
        result = _joint_metric(mode, normalized, config)
    if result is None:
        result = _topology_metric(mode, normalized, config)
    if result is None:
        result = _local_metric(mode, normalized, config)
    if result is None:
        raise InvalidData(f"unsupported_topical_lattice_mode:{mode}")
    score, details = result
    threshold = int(spec.get("threshold_ppm", 500_000))
    violation = score < threshold
    return score, violation, {
        **details,
        "metric_mode": mode,
        "policy_threshold_ppm": threshold,
        "semantic": SEMANTIC,
        "evidence_contract": EVIDENCE_CONTRACT,
        "observe_only": True,
        "no_content_generation": True,
        "no_doorway_generation": True,
        "grounded_in_verified_project_evidence": True,
    }

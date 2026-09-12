from __future__ import annotations

from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm,
    config_phrases, contains_any_phrase, gini_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "FIRST_PARTY_SEARCH_DEMAND_FRONTIER_NOT_RANKING_OR_REVENUE_FORECAST"


def _rows(normalized: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    if not raw and not allow_empty:
        raise InsufficientData(f"{key}_empty")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out


def _share(rows: Sequence[Mapping[str, Any]], predicate, field: str = "impressions") -> int:
    total = sum(int(row.get(field, 0)) for row in rows)
    if total <= 0:
        return 0
    matched = sum(int(row.get(field, 0)) for row in rows if predicate(row))
    return bounded_ratio_ppm(matched, total)


def _ctr(rows: Sequence[Mapping[str, Any]], predicate=lambda row: True) -> int:
    subset = [row for row in rows if predicate(row)]
    impressions = sum(int(row.get("impressions", 0)) for row in subset)
    clicks = sum(int(row.get("clicks", 0)) for row in subset)
    return bounded_ratio_ppm(clicks, impressions) if impressions > 0 else 0


def _position(row: Mapping[str, Any]) -> int:
    value = row.get("average_position_milli")
    return value if isinstance(value, int) and not isinstance(value, bool) else 1_000_000


def _groups(config: Mapping[str, Any], key: str) -> dict[str, tuple[tuple[str, ...], ...]]:
    raw = config.get(key)
    if not isinstance(raw, Mapping) or not raw:
        raise InsufficientData(f"{key}_missing")
    result: dict[str, tuple[tuple[str, ...], ...]] = {}
    for name, values in raw.items():
        if not isinstance(name, str) or not isinstance(values, list):
            raise InvalidData(f"{key}_invalid")
        phrases = sorted({tuple(tokens(value)) for value in values if tuple(tokens(value))})
        if phrases:
            result[normalize_text(name)] = tuple(phrases)
    if not result:
        raise InsufficientData(f"{key}_empty")
    return result


def _matches_group(query_tokens: Sequence[str], phrases: Sequence[Sequence[str]]) -> bool:
    return contains_any_phrase(query_tokens, phrases)


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if value.startswith("/"):
        return value.split("?", 1)[0]
    marker = value.find("://")
    if marker >= 0:
        tail = value[marker + 3:]
        slash = tail.find("/")
        return "/" if slash < 0 else tail[slash:].split("?", 1)[0]
    return value.split("?", 1)[0]


def _canon_terms(row: Mapping[str, Any]) -> set[str]:
    out: set[str] = set()
    for key in ("keyword", "semantic_key", "slug", "query_cluster", "brand_entity"):
        out.update(tokens(row.get(key)))
    entities = row.get("entities")
    if isinstance(entities, list):
        for entity in entities:
            out.update(tokens(entity))
    return out


def _concentration(values: Sequence[int]) -> int:
    total = sum(values)
    if total <= 0:
        return 0
    numerator = sum(value * value for value in values if value > 0)
    return min(PPM, (numerator * PPM) // (total * total))


def _pareto_top_share(weights: Mapping[str, int]) -> int:
    if not weights:
        return 0
    ordered = sorted(weights.values(), reverse=True)
    count = max(1, (len(ordered) + 4) // 5)
    total = sum(ordered)
    return bounded_ratio_ppm(sum(ordered[:count]), total) if total else 0


def _feature_map(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    search = _rows(normalized, "search_performance_records")
    docs = {str(row.get("document_id")): row for row in _rows(normalized, "content_documents", allow_empty=True)}
    canon = _rows(normalized, "canonicalization_records", allow_empty=True)
    intents = _rows(normalized, "search_intent_records", allow_empty=True)
    semantic = _rows(normalized, "semantic_text_records", allow_empty=True)
    local = _rows(normalized, "local_business_records", allow_empty=True)
    phrases = {
        "brand": config_phrases(config, "local_brand_terms"),
        "commercial": config_phrases(config, "local_commercial_terms"),
        "service": config_phrases(config, "local_service_terms"),
        "location": config_phrases(config, "local_location_terms"),
        "urgency": config_phrases(config, "local_urgency_terms"),
        "question": config_phrases(config, "local_question_terms"),
    }
    service_groups = _groups(config, "local_service_groups")
    location_groups = _groups(config, "local_location_groups")

    def has(row: Mapping[str, Any], key: str) -> bool:
        return contains_any_phrase(row.get("query_tokens", []), phrases[key])

    def longtail(row: Mapping[str, Any]) -> bool:
        return len(row.get("query_tokens", [])) >= 5

    def content_match(row: Mapping[str, Any]) -> bool:
        return _path(row.get("page_url")) in docs

    def content_support(row: Mapping[str, Any]) -> bool:
        doc = docs.get(_path(row.get("page_url")))
        return bool(doc and set(row.get("query_tokens", [])).intersection(set(doc.get("tokens", []))))

    def canon_for(row: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        page = _path(row.get("page_url"))
        q = set(row.get("query_tokens", []))
        out = []
        for item in canon:
            if page and page in {_path(item.get("url")), _path(item.get("consolidated_to"))}:
                out.append(item)
            elif q.intersection(_canon_terms(item)):
                out.append(item)
        return out

    def canon_prop(row: Mapping[str, Any], key: str, predicate) -> bool:
        matches = canon_for(row)
        return bool(matches) and any(predicate(item.get(key)) for item in matches)

    def intent_support(row: Mapping[str, Any], field: str) -> bool:
        q = set(row.get("query_tokens", []))
        for intent in intents:
            if not q.intersection(tokens(intent.get("query"))):
                continue
            value = intent.get(field)
            if field == "internal_anchors" and isinstance(value, list):
                return any(q.intersection(tokens(anchor)) for anchor in value)
            if field == "navigation_entities" and isinstance(value, list):
                return any(q.intersection(tokens(entity)) for entity in value)
            return True
        return False

    def semantic_support(row: Mapping[str, Any]) -> bool:
        q = set(row.get("query_tokens", []))
        for record in semantic:
            entities = record.get("entities")
            if isinstance(entities, list):
                for entity in entities:
                    if isinstance(entity, Mapping) and q.intersection(tokens(entity.get("label"))):
                        return True
        return False

    identity_tokens: set[str] = set()
    for record in local:
        identity_tokens.update(tokens(record.get("name")))
        identity_tokens.update(tokens(record.get("address")))

    def identity_support(row: Mapping[str, Any]) -> bool:
        return bool(set(row.get("query_tokens", [])).intersection(identity_tokens)) or (has(row, "location") and bool(local))

    total_impressions = sum(int(row["impressions"]) for row in search)
    total_clicks = sum(int(row["clicks"]) for row in search)
    record_count = len(search)
    page_weights: dict[str, int] = {}
    page_clicks: dict[str, int] = {}
    query_weights: dict[str, int] = {}
    query_clicks: dict[str, int] = {}
    query_pages: dict[str, set[str]] = {}
    page_queries: dict[str, set[str]] = {}
    for row in search:
        q = str(row["query"]); p = str(row["page_url"])
        page_weights[p] = page_weights.get(p, 0) + int(row["impressions"])
        page_clicks[p] = page_clicks.get(p, 0) + int(row["clicks"])
        query_weights[q] = query_weights.get(q, 0) + int(row["impressions"])
        query_clicks[q] = query_clicks.get(q, 0) + int(row["clicks"])
        query_pages.setdefault(q, set()).add(p)
        page_queries.setdefault(p, set()).add(q)

    top3 = lambda row: _position(row) <= 3_000
    top10 = lambda row: _position(row) <= 10_000
    p11_20 = lambda row: 10_000 < _position(row) <= 20_000
    p21 = lambda row: _position(row) > 20_000
    zero_click = _share(search, lambda row: int(row["clicks"]) == 0)
    high_floor = max(1, total_impressions // record_count)
    low_ctr = lambda row: int(row["impressions"]) > 0 and (int(row["clicks"]) * PPM) // int(row["impressions"]) < 20_000
    local_high = lambda row: has(row, "location") and (has(row, "service") or has(row, "commercial") or has(row, "urgency"))

    service_seen: set[str] = set(); location_seen: set[str] = set(); cells: set[tuple[str, str]] = set(); cell_rows = []
    for row in search:
        services = [name for name, group in service_groups.items() if _matches_group(row.get("query_tokens", []), group)]
        locations = [name for name, group in location_groups.items() if _matches_group(row.get("query_tokens", []), group)]
        service_seen.update(services); location_seen.update(locations)
        for service_name in services:
            for location_name in locations:
                cells.add((service_name, location_name)); cell_rows.append(row)
    total_cells = len(service_groups) * len(location_groups)

    page_gini = gini_ppm(list(page_weights.values())) if page_weights else 0
    query_gini = gini_ppm(list(query_weights.values())) if query_weights else 0
    page_click_gini = gini_ppm(list(page_clicks.values())) if any(page_clicks.values()) else 0
    query_click_gini = gini_ppm(list(query_clicks.values())) if any(query_clicks.values()) else 0
    page_hhi = _concentration(list(page_weights.values())); query_hhi = _concentration(list(query_weights.values()))

    weighted_position = 0
    for row in search:
        health = 0 if _position(row) >= 100_000 else ((100_000 - _position(row)) * PPM) // 100_000
        weighted_position += int(row["impressions"]) * health
    weighted_position = weighted_position // total_impressions if total_impressions else 0

    multipage_impressions = sum(query_weights[q] for q, pages in query_pages.items() if len(pages) > 1)
    multipage_health = complement_ppm(bounded_ratio_ppm(multipage_impressions, total_impressions)) if total_impressions else PPM
    max_breadth = max((len(values) for values in page_queries.values()), default=1)
    breadth_health = PPM if max_breadth <= 8 else max(0, PPM - ((max_breadth - 8) * PPM) // max_breadth)
    brand_share = _share(search, lambda row: has(row, "brand"))
    brand_balance = max(0, PPM - min(PPM, abs(brand_share - 500_000) * 2))

    evidence_flags = [bool(search), bool(docs), bool(canon), bool(local), bool(intents), bool(semantic)]
    evidence_breadth = bounded_ratio_ppm(sum(1 for flag in evidence_flags if flag), len(evidence_flags))

    features: dict[str, tuple[int, dict[str, Any]]] = {}
    def put(name: str, score: int, **details: Any) -> None:
        features[name] = (max(0, min(PPM, score)), details)
    def gap(predicate) -> int:
        return complement_ppm(_share(search, predicate))

    put("observed_query_coverage", bounded_ratio_ppm(len(query_weights), record_count), unique_queries=len(query_weights))
    put("observed_landing_coverage", bounded_ratio_ppm(len(page_weights), record_count), unique_landings=len(page_weights))
    put("impression_evidence_density", PPM if total_impressions else 0, total_impressions=total_impressions)
    clicked = sum(1 for row in search if int(row["clicks"]) > 0)
    put("click_evidence_density", bounded_ratio_ppm(clicked, record_count), clicked_observations=clicked)
    put("overall_ctr_health", _ctr(search), ctr_ppm=_ctr(search))
    put("zero_click_impression_health", complement_ppm(zero_click), zero_click_share_ppm=zero_click)
    put("top3_impression_share", _share(search, top3), share_ppm=_share(search, top3))
    put("top10_impression_share", _share(search, top10), share_ppm=_share(search, top10))
    put("position_11_20_share", _share(search, p11_20), share_ppm=_share(search, p11_20))
    put("position_21_plus_share", _share(search, p21), share_ppm=_share(search, p21))
    put("weighted_position_health", weighted_position, weighted_position_health_ppm=weighted_position)
    single_page_queries = sum(1 for pages in query_pages.values() if len(pages) == 1)
    put("query_to_page_specialization", bounded_ratio_ppm(single_page_queries, len(query_weights)), single_page_queries=single_page_queries)
    put("multi_page_query_health", multipage_health, multipage_impressions=multipage_impressions)
    put("landing_query_breadth_health", breadth_health, max_queries_per_landing=max_breadth)
    put("brand_impression_balance", brand_balance, brand_share_ppm=brand_share)

    category_specs = (
        ("nonbrand", lambda row: not has(row, "brand")), ("commercial", lambda row: has(row, "commercial")),
        ("service", lambda row: has(row, "service")), ("location", lambda row: has(row, "location")),
        ("urgency", lambda row: has(row, "urgency")), ("longtail", lambda row: len(row.get("query_tokens", [])) >= 5),
        ("question", lambda row: has(row, "question")),
    )
    for name, predicate in category_specs:
        put(f"{name}_impression_share", _share(search, predicate), share_ppm=_share(search, predicate))
    put("service_location_impression_share", _share(search, lambda row: has(row,"service") and has(row,"location")), share_ppm=_share(search, lambda row: has(row,"service") and has(row,"location")))
    put("commercial_location_impression_share", _share(search, lambda row: has(row,"commercial") and has(row,"location")), share_ppm=_share(search, lambda row: has(row,"commercial") and has(row,"location")))
    put("urgency_location_impression_share", _share(search, lambda row: has(row,"urgency") and has(row,"location")), share_ppm=_share(search, lambda row: has(row,"urgency") and has(row,"location")))

    ctr_specs = (("brand",lambda row:has(row,"brand")),) + category_specs + (("top10",top10),("position_11_20",p11_20),("position_21_plus",p21))
    for name, predicate in ctr_specs:
        put(f"{name}_ctr_health", _ctr(search, predicate), ctr_ppm=_ctr(search, predicate))

    put("demand_canonical_match_share", _share(search, lambda row: bool(canon_for(row))), share_ppm=_share(search, lambda row: bool(canon_for(row))))
    put("demand_content_document_match_share", _share(search, content_match), share_ppm=_share(search, content_match))
    put("demand_sitemap_backing_share", _share(search, lambda row: canon_prop(row,"sitemap_present",lambda value:value is True)), share_ppm=_share(search, lambda row: canon_prop(row,"sitemap_present",lambda value:value is True)))
    put("demand_internal_inlink_backing_share", _share(search, lambda row: canon_prop(row,"internal_inlinks",lambda value:isinstance(value,int) and not isinstance(value,bool) and value>0)), share_ppm=_share(search, lambda row: canon_prop(row,"internal_inlinks",lambda value:isinstance(value,int) and not isinstance(value,bool) and value>0)))
    put("demand_content_token_support_share", _share(search, content_support), share_ppm=_share(search, content_support))
    put("intent_record_query_alignment_share", _share(search, lambda row:intent_support(row,"query")), share_ppm=_share(search, lambda row:intent_support(row,"query")))
    put("internal_anchor_query_alignment_share", _share(search, lambda row:intent_support(row,"internal_anchors")), share_ppm=_share(search, lambda row:intent_support(row,"internal_anchors")))
    put("navigation_entity_query_alignment_share", _share(search, lambda row:intent_support(row,"navigation_entities")), share_ppm=_share(search, lambda row:intent_support(row,"navigation_entities")))
    put("semantic_entity_query_alignment_share", _share(search, semantic_support), share_ppm=_share(search, semantic_support))
    put("local_identity_corroborated_demand_share", _share(search, identity_support), share_ppm=_share(search, identity_support))
    put("canonical_entity_corroborated_demand_share", _share(search, lambda row: canon_prop(row,"entities",lambda value:isinstance(value,list) and bool(value))), share_ppm=_share(search, lambda row: canon_prop(row,"entities",lambda value:isinstance(value,list) and bool(value))))
    put("query_cluster_corroborated_demand_share", _share(search, lambda row: canon_prop(row,"query_cluster",lambda value:isinstance(value,str) and bool(value.strip()))), share_ppm=_share(search, lambda row: canon_prop(row,"query_cluster",lambda value:isinstance(value,str) and bool(value.strip()))))
    put("service_group_coverage", bounded_ratio_ppm(len(service_seen), len(service_groups)), observed_groups=sorted(service_seen))
    put("location_group_coverage", bounded_ratio_ppm(len(location_seen), len(location_groups)), observed_groups=sorted(location_seen))
    put("service_location_cell_coverage", bounded_ratio_ppm(len(cells), total_cells), observed_cells=len(cells), total_cells=total_cells)
    put("service_location_zero_click_health", complement_ppm(_share(cell_rows, lambda row:int(row["clicks"])==0)) if cell_rows else 0, observed_rows=len(cell_rows))
    put("service_location_top10_share", _share(cell_rows, top10) if cell_rows else 0, observed_rows=len(cell_rows))
    put("service_location_ctr_health", _ctr(cell_rows) if cell_rows else 0, observed_rows=len(cell_rows))
    put("page_impression_gini_health", complement_ppm(page_gini), gini_ppm=page_gini)
    put("page_click_gini_health", complement_ppm(page_click_gini), gini_ppm=page_click_gini)
    put("query_impression_gini_health", complement_ppm(query_gini), gini_ppm=query_gini)
    put("query_click_gini_health", complement_ppm(query_click_gini), gini_ppm=query_click_gini)
    put("page_hhi_health", complement_ppm(page_hhi), hhi_ppm=page_hhi)
    put("query_hhi_health", complement_ppm(query_hhi), hhi_ppm=query_hhi)
    page_minmax = bounded_ratio_ppm(min(page_weights.values()), max(page_weights.values())) if page_weights else 0
    query_minmax = bounded_ratio_ppm(min(query_weights.values()), max(query_weights.values())) if query_weights else 0
    put("page_diversity_index", page_minmax, min_to_max_ppm=page_minmax)
    put("query_diversity_index", query_minmax, min_to_max_ppm=query_minmax)
    page_pareto = _pareto_top_share(page_weights); click_pareto = _pareto_top_share(page_clicks)
    put("page_pareto_20_share_health", complement_ppm(page_pareto) if page_pareto>800_000 else PPM, pareto_share_ppm=page_pareto)
    put("click_pareto_20_share_health", complement_ppm(click_pareto) if click_pareto>800_000 else PPM, pareto_share_ppm=click_pareto)
    put("position_4_20_opportunity_health", gap(lambda row:3_000<_position(row)<=20_000), risk_share_ppm=_share(search,lambda row:3_000<_position(row)<=20_000))
    put("top10_zero_click_opportunity_health", gap(lambda row:top10(row) and int(row["clicks"])==0), risk_share_ppm=_share(search,lambda row:top10(row) and int(row["clicks"])==0))
    put("high_impression_low_ctr_health", gap(lambda row:int(row["impressions"])>=high_floor and low_ctr(row)), risk_share_ppm=_share(search,lambda row:int(row["impressions"])>=high_floor and low_ctr(row)))
    put("first_page_underclick_health", gap(lambda row:top10(row) and low_ctr(row)), risk_share_ppm=_share(search,lambda row:top10(row) and low_ctr(row)))
    put("rank_gap_11_20_health", gap(p11_20), risk_share_ppm=_share(search,p11_20))
    put("deep_gap_21_plus_health", gap(p21), risk_share_ppm=_share(search,p21))
    put("local_high_intent_gap_health", gap(lambda row:local_high(row) and not top10(row)), risk_share_ppm=_share(search,lambda row:local_high(row) and not top10(row)))
    put("commercial_high_intent_gap_health", gap(lambda row:has(row,"commercial") and not top10(row)), risk_share_ppm=_share(search,lambda row:has(row,"commercial") and not top10(row)))
    put("urgent_gap_health", gap(lambda row:has(row,"urgency") and not top10(row)), risk_share_ppm=_share(search,lambda row:has(row,"urgency") and not top10(row)))
    put("longtail_gap_health", gap(lambda row:longtail(row) and not top10(row)), risk_share_ppm=_share(search,lambda row:longtail(row) and not top10(row)))
    put("question_gap_health", gap(lambda row:has(row,"question") and not top10(row)), risk_share_ppm=_share(search,lambda row:has(row,"question") and not top10(row)))
    put("content_supported_zero_click_health", gap(lambda row:content_support(row) and int(row["clicks"])==0), risk_share_ppm=_share(search,lambda row:content_support(row) and int(row["clicks"])==0))
    put("content_unsupported_demand_health", gap(lambda row:local_high(row) and not content_match(row)), risk_share_ppm=_share(search,lambda row:local_high(row) and not content_match(row)))
    put("canonical_unbacked_demand_health", gap(lambda row:local_high(row) and not canon_for(row)), risk_share_ppm=_share(search,lambda row:local_high(row) and not canon_for(row)))
    put("no_internal_inlink_demand_health", gap(lambda row:top10(row) and not canon_prop(row,"internal_inlinks",lambda value:isinstance(value,int) and not isinstance(value,bool) and value>0)), risk_share_ppm=_share(search,lambda row:top10(row) and not canon_prop(row,"internal_inlinks",lambda value:isinstance(value,int) and not isinstance(value,bool) and value>0)))
    put("no_sitemap_demand_health", gap(lambda row:int(row["impressions"])>=high_floor and not canon_prop(row,"sitemap_present",lambda value:value is True)), risk_share_ppm=_share(search,lambda row:int(row["impressions"])>=high_floor and not canon_prop(row,"sitemap_present",lambda value:value is True)))
    put("semantic_mismatch_demand_health", gap(lambda row:local_high(row) and not content_support(row)), risk_share_ppm=_share(search,lambda row:local_high(row) and not content_support(row)))
    put("identity_mismatch_local_demand_health", gap(lambda row:has(row,"location") and not identity_support(row)), risk_share_ppm=_share(search,lambda row:has(row,"location") and not identity_support(row)))
    max_landing_share = max(page_weights.values()) * PPM // total_impressions if total_impressions else 0
    put("landing_concentration_health", complement_ppm(max_landing_share) if max_landing_share>850_000 else PPM, max_landing_share_ppm=max_landing_share)
    put("brand_dependency_health", complement_ppm(brand_share) if brand_share>700_000 else PPM, brand_share_ppm=brand_share)
    service_weights = [sum(int(row["impressions"]) for row in search if _matches_group(row.get("query_tokens",[]),group)) for group in service_groups.values()]
    location_weights = [sum(int(row["impressions"]) for row in search if _matches_group(row.get("query_tokens",[]),group)) for group in location_groups.values()]
    cell_weights = [sum(int(row["impressions"]) for row in search if _matches_group(row.get("query_tokens",[]),sg) and _matches_group(row.get("query_tokens",[]),lg)) for sg in service_groups.values() for lg in location_groups.values()]
    put("service_coverage_gap_health", complement_ppm(_concentration(service_weights)), missing_groups=sorted(set(service_groups)-service_seen))
    put("location_coverage_gap_health", complement_ppm(_concentration(location_weights)), missing_groups=sorted(set(location_groups)-location_seen))
    put("service_location_gap_health", complement_ppm(_concentration(cell_weights)), missing_cell_count=total_cells-len(cells))
    core = [_ctr(search),_share(search,top10),_share(search,content_match),_share(search,lambda row:bool(canon_for(row))),evidence_breadth,complement_ppm(zero_click)]
    composite = sum(core)//len(core)
    put("demand_frontier_composite_health", composite, component_scores_ppm=core)
    put("evidence_breadth_health", evidence_breadth, evidence_sources_present=sum(1 for flag in evidence_flags if flag))
    readiness = (composite+weighted_position+multipage_health+breadth_health)//4
    put("decision_readiness_health", readiness, component_scores_ppm=[composite,weighted_position,multipage_health,breadth_health])
    return features


def demand_frontier_metric(spec, normalized, config):
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("demand_frontier_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str):
        raise InvalidData("demand_frontier_mode_invalid")
    features = _feature_map(normalized, config)
    if mode not in features:
        raise InvalidData(f"unsupported_demand_frontier_mode:{mode}")
    score, details = features[mode]
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise InvalidData("threshold_ppm_invalid")
    return score, score < threshold, {
        **details,
        "metric": mode,
        "evidence_contract": EVIDENCE_CONTRACT,
        "semantic_boundary": SEMANTIC,
        "observe_only": True,
        "no_google_scraping": True,
        "not_a_rank_forecast": True,
        "not_a_revenue_forecast": True,
        "not_an_indexation_guarantee": True,
    }

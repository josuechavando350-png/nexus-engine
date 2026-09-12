from __future__ import annotations

from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm,
    config_phrases, contains_any_phrase, gini_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "FIRST_PARTY_LOCAL_TRAFFIC_PORTFOLIO_OPTIMIZATION_NOT_RANK_OR_REVENUE_FORECAST"


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


def _keyword_rows(normalized: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = _rows(normalized, "keyword_coverage_records")
    seen: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(raw):
        keyword = normalize_text(row.get("keyword"))
        site_ranked = row.get("site_ranked")
        competitors = row.get("competitor_ranked_count")
        volume = row.get("search_volume")
        if not keyword or type(site_ranked) is not bool:
            raise InvalidData(f"keyword_coverage_identity_invalid:{index}")
        if isinstance(competitors, bool) or not isinstance(competitors, int) or competitors < 0:
            raise InvalidData(f"keyword_coverage_competitor_count_invalid:{index}")
        if isinstance(volume, bool) or not isinstance(volume, int) or volume < 0:
            raise InvalidData(f"keyword_coverage_volume_invalid:{index}")
        item = {
            "keyword": keyword,
            "keyword_tokens": tokens(keyword),
            "site_ranked": site_ranked,
            "competitor_ranked_count": competitors,
            "search_volume": volume,
        }
        prior = seen.get(keyword)
        if prior is not None and prior != item:
            raise InvalidData(f"conflicting_keyword_coverage:{keyword}")
        seen[keyword] = item
    return [seen[key] for key in sorted(seen)]


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw = value.split("?", 1)[0]
    if raw.startswith("/"):
        return raw
    marker = raw.find("://")
    if marker >= 0:
        tail = raw[marker + 3:]
        slash = tail.find("/")
        return "/" if slash < 0 else tail[slash:]
    return raw


def _share(good: int, total: int) -> int:
    return bounded_ratio_ppm(good, total) if total > 0 else 0


def _weighted_share(rows: Sequence[Mapping[str, Any]], predicate, field: str) -> int:
    total = sum(int(row.get(field, 0)) for row in rows)
    if total <= 0:
        return 0
    good = sum(int(row.get(field, 0)) for row in rows if predicate(row))
    return bounded_ratio_ppm(good, total)


def _average(values: Sequence[int]) -> int:
    return sum(values) // len(values) if values else 0


def _phrase_match(row: Mapping[str, Any], phrases: Sequence[Sequence[str]], key: str) -> bool:
    seq = row.get(key, [])
    return isinstance(seq, list) and contains_any_phrase(seq, phrases)


def _pareto_focus(weights: Sequence[int]) -> int:
    positive = sorted((value for value in weights if value > 0), reverse=True)
    if not positive:
        return PPM
    total = sum(positive)
    cumulative = 0
    count = 0
    target = (total * 800_000 + PPM - 1) // PPM
    for value in positive:
        cumulative += value
        count += 1
        if cumulative >= target:
            break
    # High score means the useful 80% is distributed across more of the portfolio rather than one fragile item.
    return bounded_ratio_ppm(count, len(positive))


def _greedy_cover(
    page_queries: Mapping[str, set[str]],
    query_weights: Mapping[str, int],
) -> tuple[list[str], list[int]]:
    uncovered = {q for q, weight in query_weights.items() if weight > 0}
    selected: list[str] = []
    gains: list[int] = []
    while uncovered:
        best_page = ""
        best_gain = -1
        for page in sorted(page_queries):
            if page in selected:
                continue
            gain = sum(query_weights.get(query, 0) for query in page_queries[page] if query in uncovered)
            if gain > best_gain:
                best_page = page
                best_gain = gain
        if not best_page or best_gain <= 0:
            break
        selected.append(best_page)
        gains.append(best_gain)
        uncovered.difference_update(page_queries[best_page])
    return selected, gains


def _feature_map(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    keywords = _keyword_rows(normalized)
    search = _rows(normalized, "search_performance_records")
    docs = _rows(normalized, "content_documents", allow_empty=True)
    canon = _rows(normalized, "canonicalization_records", allow_empty=True)
    semantic = _rows(normalized, "semantic_text_records", allow_empty=True)
    local = _rows(normalized, "local_business_records", allow_empty=True)
    intents = _rows(normalized, "search_intent_records", allow_empty=True)
    funnel = _rows(normalized, "revenue_funnel_records", allow_empty=True)

    phrases = {
        "service": config_phrases(config, "local_service_terms"),
        "location": config_phrases(config, "local_location_terms"),
        "commercial": config_phrases(config, "local_commercial_terms"),
        "urgency": config_phrases(config, "local_urgency_terms"),
        "question": config_phrases(config, "local_question_terms"),
        "brand": config_phrases(config, "local_brand_terms"),
    }
    service_groups = config.get("local_service_groups")
    location_groups = config.get("local_location_groups")
    if not isinstance(service_groups, Mapping) or not isinstance(location_groups, Mapping):
        raise InsufficientData("portfolio_service_location_groups_missing")

    features: dict[str, tuple[int, dict[str, Any]]] = {}
    def put(name: str, score: int, **details: Any) -> None:
        features[name] = (max(0, min(PPM, score)), details)

    total_volume = sum(row["search_volume"] for row in keywords)
    ranked = [row for row in keywords if row["site_ranked"]]
    gaps = [row for row in keywords if not row["site_ranked"] and row["competitor_ranked_count"] > 0]
    ranked_volume = sum(row["search_volume"] for row in ranked)
    gap_volume = sum(row["search_volume"] for row in gaps)
    put("keyword_universe_evidence_coverage", PPM if keywords else 0, keyword_count=len(keywords), tracked_search_volume=total_volume)
    put("site_ranked_keyword_share", _share(len(ranked), len(keywords)), ranked_keywords=len(ranked))
    put("search_volume_weighted_site_coverage", _share(ranked_volume, total_volume) if total_volume else 0, ranked_search_volume=ranked_volume)
    put("competitor_only_keyword_health", complement_ppm(_share(gap_volume, total_volume)) if total_volume else PPM, competitor_gap_volume=gap_volume)
    multi_gap_volume = sum(row["search_volume"] for row in gaps if row["competitor_ranked_count"] >= 2)
    put("multi_competitor_gap_health", complement_ppm(_share(multi_gap_volume, total_volume)) if total_volume else PPM, multi_competitor_gap_volume=multi_gap_volume)
    volumes = sorted(row["search_volume"] for row in keywords)
    median_volume = volumes[(len(volumes)-1)//2] if volumes else 0
    high_gap_volume = sum(row["search_volume"] for row in gaps if row["search_volume"] >= median_volume and row["search_volume"] > 0)
    put("high_volume_gap_health", complement_ppm(_share(high_gap_volume, total_volume)) if total_volume else PPM, median_search_volume=median_volume, high_gap_volume=high_gap_volume)
    low_comp_opportunity = sum(row["search_volume"] for row in gaps if row["competitor_ranked_count"] == 1)
    put("low_competition_opportunity_evidence", _share(low_comp_opportunity, gap_volume) if gap_volume else PPM, low_competition_gap_volume=low_comp_opportunity)

    def category_rows(key: str) -> list[dict[str, Any]]:
        return [row for row in keywords if contains_any_phrase(row["keyword_tokens"], phrases[key])]
    def coverage_for(rows: Sequence[Mapping[str, Any]]) -> int:
        volume = sum(int(row.get("search_volume", 0)) for row in rows)
        covered = sum(int(row.get("search_volume", 0)) for row in rows if row.get("site_ranked") is True)
        return _share(covered, volume) if volume else PPM
    for key in ("service", "location", "commercial", "urgency", "question", "brand"):
        subset = category_rows(key)
        put(f"{key}_keyword_coverage", coverage_for(subset), eligible_keywords=len(subset))
    nonbrand = [row for row in keywords if not contains_any_phrase(row["keyword_tokens"], phrases["brand"])]
    put("nonbrand_keyword_coverage", coverage_for(nonbrand), eligible_keywords=len(nonbrand))
    service_location = [row for row in keywords if contains_any_phrase(row["keyword_tokens"], phrases["service"]) and contains_any_phrase(row["keyword_tokens"], phrases["location"])]
    commercial_location = [row for row in keywords if contains_any_phrase(row["keyword_tokens"], phrases["commercial"]) and contains_any_phrase(row["keyword_tokens"], phrases["location"])]
    local_high_intent = [row for row in keywords if contains_any_phrase(row["keyword_tokens"], phrases["location"]) and (contains_any_phrase(row["keyword_tokens"], phrases["commercial"]) or contains_any_phrase(row["keyword_tokens"], phrases["service"]) or contains_any_phrase(row["keyword_tokens"], phrases["urgency"]))]
    put("service_location_keyword_coverage", coverage_for(service_location), eligible_keywords=len(service_location))
    put("commercial_location_keyword_coverage", coverage_for(commercial_location), eligible_keywords=len(commercial_location))
    put("local_high_intent_keyword_coverage", coverage_for(local_high_intent), eligible_keywords=len(local_high_intent))
    for name, subset in (("service_gap_volume_health", category_rows("service")), ("location_gap_volume_health", category_rows("location")), ("service_location_gap_volume_health", service_location)):
        volume = sum(row["search_volume"] for row in subset)
        uncovered = sum(row["search_volume"] for row in subset if not row["site_ranked"] and row["competitor_ranked_count"] > 0)
        put(name, complement_ppm(_share(uncovered, volume)) if volume else PPM, eligible_volume=volume, gap_volume=uncovered)

    keyword_token_sets = {row["keyword"]: set(row["keyword_tokens"]) for row in keywords}
    search_query_tokens = {str(row.get("query")): set(row.get("query_tokens", [])) for row in search}
    def keyword_has_observation(row: Mapping[str, Any]) -> bool:
        kt = set(row["keyword_tokens"])
        return any(bool(kt & qt) for qt in search_query_tokens.values())
    put("observed_query_keyword_bridge", _share(sum(1 for row in keywords if keyword_has_observation(row)), len(keywords)), keyword_count=len(keywords))
    observed_keyword_tokens = {token for row in keywords if keyword_has_observation(row) for token in row["keyword_tokens"]}
    put("observed_impression_keyword_bridge", _weighted_share(search, lambda row: bool(set(row.get("query_tokens", [])) & observed_keyword_tokens), "impressions"), search_records=len(search))
    put("observed_click_keyword_bridge", _weighted_share(search, lambda row: bool(set(row.get("query_tokens", [])) & observed_keyword_tokens), "clicks") if sum(int(r.get("clicks",0)) for r in search) else 0, search_records=len(search))

    doc_token_sets = [set(row.get("tokens", [])) for row in docs]
    canon_token_sets: list[set[str]] = []
    for row in canon:
        values = [row.get("keyword"), row.get("semantic_key"), row.get("slug"), row.get("query_cluster"), row.get("brand_entity")]
        raw_entities = row.get("entities")
        if isinstance(raw_entities, list): values.extend(raw_entities)
        canon_token_sets.append(set(tokens(" ".join(str(v) for v in values if isinstance(v, str)))))
    entity_tokens: set[str] = set()
    for record in semantic:
        entities = record.get("entities")
        if isinstance(entities, list):
            for entity in entities:
                if isinstance(entity, Mapping): entity_tokens.update(tokens(entity.get("label")))
    local_tokens = {token for row in local for token in tokens(row.get("name")) + tokens(row.get("address"))}
    intent_tokens = {token for row in intents for token in tokens(row.get("query"))}
    def support_share(token_sets: Sequence[set[str]]) -> int:
        return _share(sum(1 for row in keywords if any(set(row["keyword_tokens"]) & values for values in token_sets)), len(keywords))
    put("keyword_to_content_support", support_share(doc_token_sets), content_documents=len(docs))
    put("keyword_to_canonical_support", support_share(canon_token_sets), canonical_records=len(canon))
    put("keyword_to_entity_support", _share(sum(1 for row in keywords if set(row["keyword_tokens"]) & entity_tokens), len(keywords)), entity_tokens=len(entity_tokens))
    put("keyword_to_local_identity_support", _share(sum(1 for row in keywords if set(row["keyword_tokens"]) & local_tokens), len(keywords)), local_identity_tokens=len(local_tokens))
    put("keyword_to_intent_record_support", _share(sum(1 for row in keywords if set(row["keyword_tokens"]) & intent_tokens), len(keywords)), intent_tokens=len(intent_tokens))
    put("ranked_keyword_content_backing", _share(sum(1 for row in ranked if any(set(row["keyword_tokens"]) & values for values in doc_token_sets)), len(ranked)) if ranked else PPM, ranked_keywords=len(ranked))
    put("gap_keyword_evidence_backing", _share(sum(1 for row in gaps if any(set(row["keyword_tokens"]) & values for values in doc_token_sets + canon_token_sets)), len(gaps)) if gaps else PPM, gap_keywords=len(gaps))

    # Page/query portfolio geometry.
    page_queries: dict[str, set[str]] = {}
    query_pages: dict[str, set[str]] = {}
    query_impressions: dict[str, int] = {}
    query_clicks: dict[str, int] = {}
    page_impressions: dict[str, int] = {}
    page_clicks: dict[str, int] = {}
    for row in search:
        page = _path(row.get("page_url")); query = str(row.get("query"))
        if not page: continue
        page_queries.setdefault(page, set()).add(query)
        query_pages.setdefault(query, set()).add(page)
        query_impressions[query] = query_impressions.get(query, 0) + int(row.get("impressions", 0))
        query_clicks[query] = query_clicks.get(query, 0) + int(row.get("clicks", 0))
        page_impressions[page] = page_impressions.get(page, 0) + int(row.get("impressions", 0))
        page_clicks[page] = page_clicks.get(page, 0) + int(row.get("clicks", 0))
    total_imp = sum(page_impressions.values()); total_click = sum(page_clicks.values())
    ranked_pages_imp = sorted(page_impressions.values(), reverse=True)
    for name, topn in (("top1_page_demand_concentration_health",1),("top3_page_demand_concentration_health",3),("top5_page_demand_concentration_health",5)):
        top = sum(ranked_pages_imp[:topn]); share = _share(top,total_imp) if total_imp else 0
        put(name, complement_ppm(share), top_page_share_ppm=share, top_n=topn)
    put("page_coverage_efficiency", _share(len(query_pages), max(1, sum(len(v) for v in page_queries.values()))), unique_queries=len(query_pages), query_page_edges=sum(len(v) for v in page_queries.values()))
    put("query_coverage_efficiency", _share(sum(1 for q,pages in query_pages.items() if len(pages)==1), len(query_pages)) if query_pages else 0, exclusive_queries=sum(1 for pages in query_pages.values() if len(pages)==1))
    imp_gini = gini_ppm(list(page_impressions.values())) if any(page_impressions.values()) else 0
    click_gini = gini_ppm(list(page_clicks.values())) if any(page_clicks.values()) else 0
    put("demand_per_page_balance", complement_ppm(imp_gini), gini_ppm=imp_gini)
    put("click_per_page_balance", complement_ppm(click_gini), gini_ppm=click_gini)
    exclusive_imp_by_page = {page: sum(query_impressions[q] for q in queries if len(query_pages[q])==1) for page,queries in page_queries.items()}
    exclusive_click_by_page = {page: sum(query_clicks[q] for q in queries if len(query_pages[q])==1) for page,queries in page_queries.items()}
    min_imp = min(exclusive_imp_by_page.values()) if exclusive_imp_by_page else 0
    min_click = min(exclusive_click_by_page.values()) if exclusive_click_by_page else 0
    put("minimum_page_marginal_demand_health", _share(min_imp, max(1,max(exclusive_imp_by_page.values(),default=0))) if exclusive_imp_by_page else 0, minimum_marginal_impressions=min_imp)
    put("minimum_page_marginal_click_health", _share(min_click, max(1,max(exclusive_click_by_page.values(),default=0))) if exclusive_click_by_page else 0, minimum_marginal_clicks=min_click)
    max_exclusive_imp = max(exclusive_imp_by_page.values(), default=0)
    max_exclusive_click = max(exclusive_click_by_page.values(), default=0)
    put("page_removal_demand_resilience", complement_ppm(_share(max_exclusive_imp,total_imp)) if total_imp else PPM, worst_exclusive_impression_loss=max_exclusive_imp)
    put("page_removal_click_resilience", complement_ppm(_share(max_exclusive_click,total_click)) if total_click else PPM, worst_exclusive_click_loss=max_exclusive_click)
    top_page_loss = max(page_impressions.values(), default=0)
    put("top_page_removal_resilience", complement_ppm(_share(top_page_loss,total_imp)) if total_imp else PPM, top_page_impressions=top_page_loss)
    top_query_loss = max(query_impressions.values(), default=0)
    put("top_query_removal_resilience", complement_ppm(_share(top_query_loss,sum(query_impressions.values()))) if query_impressions else PPM, top_query_impressions=top_query_loss)

    service_cells: dict[str,set[str]]={}; location_cells: dict[str,set[str]]={}; joint_cells: dict[str,set[str]]={}
    def group_matches(query_tokens: list[str], groups: Mapping[str, Any]) -> list[str]:
        out=[]
        for group, raw_terms in groups.items():
            if isinstance(group,str) and isinstance(raw_terms,list):
                terms=[tokens(v) for v in raw_terms if isinstance(v,str) and tokens(v)]
                if terms and contains_any_phrase(query_tokens,terms): out.append(group)
        return sorted(out)
    for row in search:
        q=str(row.get("query")); page=_path(row.get("page_url")); qt=row.get("query_tokens",[])
        services=group_matches(qt,service_groups); locations=group_matches(qt,location_groups)
        for service in services: service_cells.setdefault(service,set()).add(page)
        for location in locations: location_cells.setdefault(location,set()).add(page)
        for service in services:
            for location in locations: joint_cells.setdefault(f"{service}|{location}",set()).add(page)
    expected_service={str(k) for k in service_groups}; expected_location={str(k) for k in location_groups}
    expected_joint={f"{s}|{l}" for s in expected_service for l in expected_location}
    put("service_cell_coverage", _share(len(service_cells),len(expected_service)) if expected_service else PPM, covered_cells=len(service_cells))
    put("location_cell_coverage", _share(len(location_cells),len(expected_location)) if expected_location else PPM, covered_cells=len(location_cells))
    put("service_location_cell_coverage", _share(len(joint_cells),len(expected_joint)) if expected_joint else PPM, covered_cells=len(joint_cells))
    def cell_balance(cells: Mapping[str,set[str]]) -> int:
        values=[len(v) for v in cells.values() if v]
        return complement_ppm(gini_ppm(values)) if values else 0
    put("service_cell_balance", cell_balance(service_cells), cells=len(service_cells))
    put("location_cell_balance", cell_balance(location_cells), cells=len(location_cells))
    put("service_location_cell_balance", cell_balance(joint_cells), cells=len(joint_cells))
    orphan_cells=len(expected_joint-set(joint_cells))
    put("cell_orphan_health", complement_ppm(_share(orphan_cells,len(expected_joint))) if expected_joint else PPM, orphan_cells=orphan_cells)
    single_dep=sum(1 for pages in joint_cells.values() if len(pages)==1)
    put("cell_single_page_dependency_health", complement_ppm(_share(single_dep,len(joint_cells))) if joint_cells else PPM, single_page_cells=single_dep)
    fragmented=sum(1 for pages in joint_cells.values() if len(pages)>2)
    put("cell_multi_page_fragmentation_health", complement_ppm(_share(fragmented,len(joint_cells))) if joint_cells else PPM, fragmented_cells=fragmented)

    def page_specialization(kind:str)->int:
        scores=[]
        for page,queries in page_queries.items():
            labels:set[str]=set()
            for q in queries:
                qt=tokens(q)
                if kind=="service": labels.update(group_matches(qt,service_groups))
                elif kind=="location": labels.update(group_matches(qt,location_groups))
                elif kind=="cell":
                    for s in group_matches(qt,service_groups):
                        for l in group_matches(qt,location_groups): labels.add(f"{s}|{l}")
                else:
                    for key in ("commercial","urgency","question","brand"):
                        if contains_any_phrase(qt,phrases[key]): labels.add(key)
            if labels: scores.append(PPM//len(labels))
        return _average(scores)
    put("page_service_specialization",page_specialization("service"),pages=len(page_queries))
    put("page_location_specialization",page_specialization("location"),pages=len(page_queries))
    put("page_intent_specialization",page_specialization("intent"),pages=len(page_queries))
    put("page_cell_specialization",page_specialization("cell"),pages=len(page_queries))

    selected_imp,gains_imp=_greedy_cover(page_queries,query_impressions)
    selected_click,gains_click=_greedy_cover(page_queries,query_clicks)
    put("portfolio_set_cover_efficiency", complement_ppm(_share(len(selected_imp)-1,max(1,len(page_queries)-1))) if page_queries else 0, selected_pages=selected_imp)
    covered_imp=sum(gains_imp); covered_click=sum(gains_click)
    put("demand_weighted_set_cover_efficiency", _share(covered_imp,sum(query_impressions.values())) if query_impressions else 0, covered_impressions=covered_imp)
    put("click_weighted_set_cover_efficiency", _share(covered_click,sum(query_clicks.values())) if query_clicks and sum(query_clicks.values()) else 0, covered_clicks=covered_click)
    for name,n in (("greedy_cover_first_page_gain",1),("greedy_cover_first_two_page_gain",2),("greedy_cover_first_three_page_gain",3)):
        gain=sum(gains_imp[:n]); put(name,_share(gain,sum(query_impressions.values())) if query_impressions else 0, captured_impressions=gain)
    redundant=sum(1 for pages in query_pages.values() if len(pages)>1)
    put("query_redundancy_health", complement_ppm(_share(redundant,len(query_pages))) if query_pages else PPM, redundant_queries=redundant)
    duplicate_edges=sum(max(0,len(pages)-1) for pages in query_pages.values())
    total_edges=sum(len(pages) for pages in query_pages.values())
    put("duplicate_query_assignment_health", complement_ppm(_share(duplicate_edges,total_edges)) if total_edges else PPM, duplicate_edges=duplicate_edges)
    exclusive_queries=sum(1 for pages in query_pages.values() if len(pages)==1)
    exclusive_demand=sum(query_impressions[q] for q,pages in query_pages.items() if len(pages)==1)
    put("exclusive_query_share",_share(exclusive_queries,len(query_pages)) if query_pages else 0,exclusive_queries=exclusive_queries)
    put("exclusive_demand_share",_share(exclusive_demand,sum(query_impressions.values())) if query_impressions else 0,exclusive_impressions=exclusive_demand)
    page_pairs=[]
    pages=sorted(page_queries)
    for i,left in enumerate(pages):
        for right in pages[i+1:]:
            union=page_queries[left]|page_queries[right]
            overlap=_share(len(page_queries[left]&page_queries[right]),len(union)) if union else 0
            page_pairs.append(overlap)
    avg_overlap=_average(page_pairs)
    put("cross_page_query_overlap_health",complement_ppm(avg_overlap),average_overlap_ppm=avg_overlap)
    put("page_jaccard_separation",complement_ppm(avg_overlap),pair_count=len(page_pairs))
    doc_sets={str(row.get("document_id")):set(row.get("tokens",[])) for row in docs}
    content_overlaps=[]
    doc_ids=sorted(doc_sets)
    for i,left in enumerate(doc_ids):
        for right in doc_ids[i+1:]:
            union=doc_sets[left]|doc_sets[right]
            content_overlaps.append(_share(len(doc_sets[left]&doc_sets[right]),len(union)) if union else 0)
    content_overlap=_average(content_overlaps)
    put("content_semantic_separation",complement_ppm(content_overlap),average_overlap_ppm=content_overlap)
    cluster_pages:dict[str,set[str]]={}
    for row in canon:
        cluster=normalize_text(row.get("query_cluster")); page=_path(row.get("url")) or _path(row.get("consolidated_to"))
        if cluster and page: cluster_pages.setdefault(cluster,set()).add(page)
    cluster_multi=sum(1 for v in cluster_pages.values() if len(v)>1)
    put("canonical_cluster_separation",complement_ppm(_share(cluster_multi,len(cluster_pages))) if cluster_pages else PPM,multi_page_clusters=cluster_multi)

    def query_high(row:Mapping[str,Any])->bool:
        qt=row.get("query_tokens",[])
        return any(contains_any_phrase(qt,phrases[key]) for key in ("commercial","service","urgency"))
    def query_local_high(row:Mapping[str,Any])->bool:
        qt=row.get("query_tokens",[])
        return contains_any_phrase(qt,phrases["location"]) and query_high(row)
    high_pages={_path(r.get("page_url")) for r in search if query_high(r)}
    local_high_pages={_path(r.get("page_url")) for r in search if query_local_high(r)}
    put("high_intent_page_coverage",_share(len({p for p in high_pages if p in page_queries}),len(high_pages)) if high_pages else PPM,eligible_pages=len(high_pages))
    put("local_high_intent_page_coverage",_share(len({p for p in local_high_pages if p in page_queries}),len(local_high_pages)) if local_high_pages else PPM,eligible_pages=len(local_high_pages))
    zero_pages={_path(r.get("page_url")) for r in search if int(r.get("clicks",0))==0 and int(r.get("impressions",0))>0}
    rank_gap_pages={_path(r.get("page_url")) for r in search if 10_000 < int(r.get("average_position_milli",1_000_000)) <= 20_000}
    low_ctr_pages={_path(r.get("page_url")) for r in search if int(r.get("impressions",0))>=100 and int(r.get("clicks",0))*20 <= int(r.get("impressions",0))}
    put("zero_click_page_opportunity_coverage",_share(len(zero_pages&set(page_queries)),len(zero_pages)) if zero_pages else PPM,opportunity_pages=len(zero_pages))
    put("rank_gap_page_opportunity_coverage",_share(len(rank_gap_pages&set(page_queries)),len(rank_gap_pages)) if rank_gap_pages else PPM,opportunity_pages=len(rank_gap_pages))
    put("high_impression_low_ctr_page_opportunity_coverage",_share(len(low_ctr_pages&set(page_queries)),len(low_ctr_pages)) if low_ctr_pages else PPM,opportunity_pages=len(low_ctr_pages))

    organic_ids=config.get("organic_funnel_source_ids")
    organic_set={normalize_text(x) for x in organic_ids} if isinstance(organic_ids,list) else set()
    organic_funnel=[row for row in funnel if normalize_text(row.get("source_id")) in organic_set]
    funnel_backed=PPM if organic_funnel else 0
    put("funnel_backed_page_priority_coverage",funnel_backed,organic_funnel_records=len(organic_funnel))
    put("funnel_backed_service_priority_coverage",funnel_backed if service_cells else 0,service_cells=len(service_cells))
    put("funnel_backed_location_priority_coverage",funnel_backed if location_cells else 0,location_cells=len(location_cells))
    opportunity_types=[bool(gaps),bool(zero_pages),bool(rank_gap_pages),bool(low_ctr_pages),bool(service_location),bool(local_high_intent)]
    diversity=_share(sum(1 for x in opportunity_types if x),len(opportunity_types))
    put("portfolio_opportunity_diversity",diversity,active_opportunity_types=sum(1 for x in opportunity_types if x))
    risk_components=[features["top1_page_demand_concentration_health"][0],features["query_redundancy_health"][0],features["page_removal_demand_resilience"][0],features["service_location_cell_balance"][0]]
    risk_div=_average(risk_components)
    put("portfolio_risk_diversification",risk_div,component_scores=risk_components)
    put("demand_pareto_resilience",_pareto_focus(list(page_impressions.values())),page_count=len(page_impressions))
    put("click_pareto_resilience",_pareto_focus(list(page_clicks.values())),page_count=len(page_clicks))
    put("keyword_gap_pareto_focus",_pareto_focus([row["search_volume"] for row in gaps]),gap_keywords=len(gaps))
    service_gap_weights=[]
    location_gap_weights=[]
    for row in gaps:
        if contains_any_phrase(row["keyword_tokens"],phrases["service"]): service_gap_weights.append(row["search_volume"])
        if contains_any_phrase(row["keyword_tokens"],phrases["location"]): location_gap_weights.append(row["search_volume"])
    put("service_gap_pareto_focus",_pareto_focus(service_gap_weights),gap_items=len(service_gap_weights))
    put("location_gap_pareto_focus",_pareto_focus(location_gap_weights),gap_items=len(location_gap_weights))
    evidence_flags=[bool(keywords),bool(search),bool(docs),bool(canon),bool(semantic),bool(local),bool(intents),bool(organic_funnel)]
    breadth=_share(sum(1 for x in evidence_flags if x),len(evidence_flags))
    put("portfolio_evidence_breadth",breadth,evidence_families=sum(1 for x in evidence_flags if x))
    confidence_parts=[breadth,features["observed_impression_keyword_bridge"][0],features["keyword_to_content_support"][0],features["keyword_to_canonical_support"][0],features["local_high_intent_keyword_coverage"][0]]
    confidence=_average(confidence_parts)
    put("portfolio_decision_confidence",confidence,component_scores=confidence_parts)
    constrained_parts=[confidence,features["search_volume_weighted_site_coverage"][0],features["high_volume_gap_health"][0],features["high_intent_page_coverage"][0],features["service_location_cell_coverage"][0]]
    constrained=_average(constrained_parts)
    put("constrained_opportunity_score",constrained,component_scores=constrained_parts)
    resilience_parts=[risk_div,features["page_removal_demand_resilience"][0],features["top_query_removal_resilience"][0],features["demand_pareto_resilience"][0],features["canonical_cluster_separation"][0]]
    resilience=_average(resilience_parts)
    put("portfolio_resilience_score",resilience,component_scores=resilience_parts)
    final_parts=[constrained,resilience,features["portfolio_opportunity_diversity"][0],features["portfolio_evidence_breadth"][0],features["query_redundancy_health"][0]]
    put("traffic_portfolio_optimizer_health",_average(final_parts),component_scores=final_parts)
    return features


def traffic_portfolio_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    params=spec.get("params")
    if not isinstance(params,Mapping): raise InvalidData("traffic_portfolio_params_missing")
    mode=params.get("mode")
    if not isinstance(mode,str): raise InvalidData("traffic_portfolio_mode_invalid")
    features=_feature_map(normalized,config)
    if mode not in features: raise InvalidData(f"unsupported_traffic_portfolio_mode:{mode}")
    score,details=features[mode]
    threshold=spec.get("threshold_ppm")
    if isinstance(threshold,bool) or not isinstance(threshold,int) or not 0<=threshold<=PPM:
        raise InvalidData("traffic_portfolio_threshold_invalid")
    return score,score<threshold,{
        **details,
        "mode":mode,
        "semantic":SEMANTIC,
        "evidence_contract":EVIDENCE_CONTRACT,
        "observe_only":True,
        "portfolio_optimization_only":True,
        "no_google_scraping":True,
        "no_page_generation":True,
        "no_site_mutation":True,
        "not_a_rank_forecast":True,
        "not_a_revenue_forecast":True,
        "not_an_indexation_guarantee":True,
    }

from __future__ import annotations

from collections import defaultdict, deque
from typing import Any, Mapping

from .common import (
    PPM, InsufficientData, bounded_ratio_ppm, complement_ppm, contains_any_phrase,
    config_phrases, gini_ppm, jaccard_ppm,
)
from .kernel_growth_shared import (
    docs_by_id, group_by_page, group_by_query, page_identity_support, query_families,
    scope_rows, threshold_for,
)

def _require_rows(spec, normalized, config):
    rows = scope_rows(spec, normalized, config)
    if not rows:
        raise InsufficientData("authority_scope_empty")
    return rows

def authority_page_impression_concentration(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in rows:
        weights[row["page_url"]] += row["impressions"]
    total = sum(weights.values())
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    top_page, top_weight = sorted(weights.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    concentration = bounded_ratio_ppm(top_weight, total)
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(weights), "top_page": top_page, "top_impressions": top_weight,
        "total_impressions": total, "top_page_impression_share_ppm": concentration,
    }

def authority_page_click_concentration(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in rows:
        weights[row["page_url"]] += row["clicks"]
    total = sum(weights.values())
    if total <= 0:
        raise InsufficientData("authority_clicks_empty")
    top_page, top_weight = sorted(weights.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    concentration = bounded_ratio_ppm(top_weight, total)
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(weights), "top_page": top_page, "top_clicks": top_weight,
        "total_clicks": total, "top_page_click_share_ppm": concentration,
    }

def authority_query_fragmentation(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    graph = group_by_query(rows)
    fragmented = []
    for query, qrows in graph.items():
        pages = sorted({row["page_url"] for row in qrows})
        if len(pages) > 1:
            fragmented.append({"query": query, "page_count": len(pages), "pages": pages})
    bad_share = bounded_ratio_ppm(len(fragmented), len(graph))
    score = complement_ppm(bad_share)
    threshold = threshold_for(spec, config)
    fragmented.sort(key=lambda item: (-item["page_count"], item["query"]))
    return score, score < threshold, {
        "query_count": len(graph), "fragmented_query_count": len(fragmented),
        "fragmented_query_share_ppm": bad_share, "fragmented_queries": fragmented,
    }

def authority_impression_weighted_fragmentation(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    graph = group_by_query(rows)
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    bad = 0
    fragmented = []
    for query, qrows in graph.items():
        pages = sorted({row["page_url"] for row in qrows})
        weight = sum(row["impressions"] for row in qrows)
        if len(pages) > 1:
            bad += weight
            fragmented.append({"query": query, "page_count": len(pages), "impressions": weight})
    bad_share = bounded_ratio_ppm(min(bad, total), total)
    score = complement_ppm(bad_share)
    threshold = threshold_for(spec, config)
    fragmented.sort(key=lambda item: (-item["impressions"], -item["page_count"], item["query"]))
    return score, score < threshold, {
        "total_impressions": total, "fragmented_impressions": bad,
        "fragmented_impression_share_ppm": bad_share, "fragmented_queries": fragmented,
    }

def authority_page_query_breadth(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    graph = group_by_page(rows)
    counts = {page: len({row["query"] for row in prows}) for page, prows in graph.items()}
    maximum = max(counts.values())
    total = sum(counts.values())
    top_page = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    concentration = bounded_ratio_ppm(maximum, total) if total > 0 else 0
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(counts), "top_page": top_page, "top_page_distinct_queries": maximum,
        "total_page_query_edges": total, "breadth_concentration_ppm": concentration,
    }

def authority_page_intent_mixing(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    families = query_families(config)
    per_page: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        for label, phrases in families:
            if contains_any_phrase(row["query_tokens"], phrases):
                per_page[row["page_url"]].add(label)
    if not per_page:
        raise InsufficientData("authority_intent_labels_empty")
    mixed = [
        {"page_url": page, "intent_family_count": len(labels), "intent_families": sorted(labels)}
        for page, labels in per_page.items() if len(labels) >= 3
    ]
    bad_share = bounded_ratio_ppm(len(mixed), len(per_page))
    score = complement_ppm(bad_share)
    threshold = threshold_for(spec, config)
    mixed.sort(key=lambda item: (-item["intent_family_count"], item["page_url"]))
    return score, score < threshold, {
        "labeled_page_count": len(per_page), "mixed_page_count": len(mixed),
        "mixed_page_share_ppm": bad_share, "mixed_pages": mixed,
    }

def authority_demand_orphan_content_gap(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    docs = docs_by_id(normalized)
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    missing_rows = [row for row in rows if row["page_url"] not in docs]
    bad = sum(row["impressions"] for row in missing_rows)
    bad_share = bounded_ratio_ppm(min(bad, total), total)
    score = complement_ppm(bad_share)
    threshold = threshold_for(spec, config)
    pages = sorted({row["page_url"] for row in missing_rows})
    return score, score < threshold, {
        "total_impressions": total, "content_missing_impressions": bad,
        "content_missing_impression_share_ppm": bad_share, "content_not_supplied_pages": pages,
        "semantic": "CONTENT_CORPUS_GAP_NOT_INDEX_STATUS",
    }

def authority_query_content_edge_support(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    docs = docs_by_id(normalized)
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    supported = 0
    unsupported = []
    for row in rows:
        doc = docs.get(row["page_url"])
        if doc is None:
            unsupported.append({"query": row["query"], "page_url": row["page_url"], "reason": "CONTENT_NOT_SUPPLIED"})
            continue
        query_tokens = set(row["query_tokens"])
        doc_tokens = set(doc["tokens"])
        overlap = query_tokens & doc_tokens
        if query_tokens and overlap:
            supported += row["impressions"]
        else:
            unsupported.append({"query": row["query"], "page_url": row["page_url"], "reason": "NO_QUERY_TOKEN_SUPPORT"})
    score = bounded_ratio_ppm(min(supported, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "total_impressions": total, "supported_impressions": supported,
        "query_content_edge_support_ppm": score, "unsupported_edges": unsupported,
    }

def authority_query_content_jaccard(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    docs = docs_by_id(normalized)
    weighted = 0
    total = 0
    samples = []
    for row in rows:
        if row["impressions"] <= 0:
            continue
        doc = docs.get(row["page_url"])
        if doc is None:
            continue
        query_tokens = set(row["query_tokens"])
        doc_tokens = set(doc["tokens"])
        if not query_tokens or not doc_tokens:
            continue
        similarity = jaccard_ppm(query_tokens, doc_tokens)
        weighted += similarity * row["impressions"]
        total += row["impressions"]
        samples.append({"query": row["query"], "page_url": row["page_url"], "token_jaccard_ppm": similarity})
    if total <= 0:
        raise InsufficientData("authority_query_content_similarity_empty")
    score = weighted // total
    threshold = threshold_for(spec, config)
    samples.sort(key=lambda item: (item["token_jaccard_ppm"], item["query"], item["page_url"]))
    return score, score < threshold, {
        "weighted_query_content_jaccard_ppm": score, "weighted_impressions": total,
        "lowest_similarity_edges": samples[:20],
    }

def authority_local_identity_support(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    docs = docs_by_id(normalized)
    local = normalized["local_business_records"]
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    supported = 0
    unsupported_pages = set()
    for row in rows:
        doc = docs.get(row["page_url"])
        if doc is not None and page_identity_support(doc, local):
            supported += row["impressions"]
        else:
            unsupported_pages.add(row["page_url"])
    score = bounded_ratio_ppm(min(supported, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "identity_supported_impressions": supported, "total_impressions": total,
        "identity_support_ppm": score, "unsupported_pages": sorted(unsupported_pages),
    }

def authority_brand_nonbrand_bridge(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    brand = config_phrases(config, "local_brand_terms")
    by_page = group_by_page(rows)
    bridges = []
    for page, prows in by_page.items():
        has_brand = any(contains_any_phrase(row["query_tokens"], brand) for row in prows)
        has_nonbrand = any(not contains_any_phrase(row["query_tokens"], brand) for row in prows)
        if has_brand and has_nonbrand:
            bridges.append(page)
    score = bounded_ratio_ppm(len(bridges), len(by_page))
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(by_page), "brand_nonbrand_bridge_count": len(bridges),
        "brand_nonbrand_bridge_share_ppm": score, "bridge_pages": sorted(bridges),
    }

def authority_zero_click_demand_gap(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    bad_rows = [row for row in rows if row["impressions"] > 0 and row["clicks"] == 0]
    bad = sum(row["impressions"] for row in bad_rows)
    share = bounded_ratio_ppm(min(bad, total), total)
    score = complement_ppm(share)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "total_impressions": total, "zero_click_impressions": bad,
        "zero_click_impression_share_ppm": share,
        "zero_click_observations": [
            {"query": row["query"], "page_url": row["page_url"], "impressions": row["impressions"]}
            for row in sorted(bad_rows, key=lambda r: (-r["impressions"], r["query"], r["page_url"]))[:50]
        ],
    }

def authority_first_page_underclick_gap(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    eligible = [row for row in rows if row["average_position_milli"] <= 10_000 and row["impressions"] > 0]
    if not eligible:
        raise InsufficientData("authority_first_page_observations_empty")
    floor = int(spec["params"].get("ctr_floor_ppm", 20_000))
    total = sum(row["impressions"] for row in eligible)
    bad_rows = [row for row in eligible if (row["clicks"] * PPM) // row["impressions"] < floor]
    bad = sum(row["impressions"] for row in bad_rows)
    share = bounded_ratio_ppm(min(bad, total), total)
    score = complement_ppm(share)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "eligible_impressions": total, "underclick_impressions": bad,
        "underclick_share_ppm": share, "ctr_floor_ppm": floor,
        "observations": [
            {"query": r["query"], "page_url": r["page_url"], "impressions": r["impressions"], "clicks": r["clicks"]}
            for r in sorted(bad_rows, key=lambda r: (-r["impressions"], r["query"], r["page_url"]))[:50]
        ],
    }

def authority_position_weighted_visibility(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    total = sum(row["impressions"] for row in rows)
    if total <= 0:
        raise InsufficientData("authority_impressions_empty")
    weighted = 0
    for row in rows:
        position = row["average_position_milli"]
        if position <= 3_000:
            weight = 1_000_000
        elif position <= 10_000:
            weight = 700_000
        elif position <= 20_000:
            weight = 350_000
        elif position <= 50_000:
            weight = 100_000
        else:
            weight = 20_000
        weighted += row["impressions"] * weight
    score = weighted // total
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "position_weighted_visibility_ppm": score, "weighted_impressions": total,
        "bucket_weights_ppm": {"top3": 1_000_000, "top10": 700_000, "top20": 350_000, "top50": 100_000, "other": 20_000},
        "not_a_ranking_prediction": True,
    }

def authority_page_demand_gini(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in rows:
        weights[row["page_url"]] += row["impressions"]
    if not weights or sum(weights.values()) <= 0:
        raise InsufficientData("authority_page_demand_empty")
    concentration = gini_ppm(list(weights.values()))
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(weights), "page_demand_gini_ppm": concentration,
        "distribution_health_ppm": score,
    }

def authority_query_demand_gini(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in rows:
        weights[row["query"]] += row["impressions"]
    if not weights or sum(weights.values()) <= 0:
        raise InsufficientData("authority_query_demand_empty")
    concentration = gini_ppm(list(weights.values()))
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "query_count": len(weights), "query_demand_gini_ppm": concentration,
        "distribution_health_ppm": score,
    }

def authority_pareto_page_efficiency(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in rows:
        weights[row["page_url"]] += row["impressions"]
    total = sum(weights.values())
    if total <= 0:
        raise InsufficientData("authority_page_demand_empty")
    target = int(spec["params"].get("coverage_target_ppm", 800_000))
    ranked = sorted(weights.items(), key=lambda kv: (-kv[1], kv[0]))
    cumulative = 0
    selected = []
    for page, weight in ranked:
        selected.append({"page_url": page, "impressions": weight})
        cumulative += weight
        if cumulative * PPM >= total * target:
            break
    page_share = bounded_ratio_ppm(len(selected), len(ranked))
    score = complement_ppm(page_share)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "page_count": len(ranked), "pages_for_target_count": len(selected),
        "coverage_target_ppm": target, "selected_page_share_ppm": page_share,
        "selected_pages": selected,
    }

def authority_bipartite_component_health(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        q = "q:" + row["query"]
        p = "p:" + row["page_url"]
        adjacency[q].add(p)
        adjacency[p].add(q)
    if not adjacency:
        raise InsufficientData("authority_graph_empty")
    seen = set()
    components = []
    for node in sorted(adjacency):
        if node in seen:
            continue
        queue = deque([node])
        seen.add(node)
        nodes = []
        while queue:
            current = queue.popleft()
            nodes.append(current)
            for nxt in sorted(adjacency[current]):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        components.append(sorted(nodes))
    largest = max(len(component) for component in components)
    score = bounded_ratio_ppm(largest, len(adjacency))
    threshold = threshold_for(spec, config)
    return score, score < threshold, {
        "node_count": len(adjacency), "component_count": len(components),
        "largest_component_node_count": largest, "largest_component_share_ppm": score,
        "component_sizes": sorted((len(c) for c in components), reverse=True),
    }

def authority_page_pair_query_overlap(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    page_queries: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        page_queries[row["page_url"]].add(row["query"])
    pages = sorted(page_queries)
    if len(pages) < 2:
        return PPM, False, {
            "page_pair_count": 0,
            "maximum_query_overlap_ppm": 0,
            "overlap_health_ppm": PPM,
            "top_overlapping_pairs": [],
            "single_page_scope": True,
        }
    pairs = []
    maximum = 0
    for i, left in enumerate(pages):
        for right in pages[i + 1:]:
            similarity = jaccard_ppm(page_queries[left], page_queries[right])
            maximum = max(maximum, similarity)
            if similarity > 0:
                pairs.append({"page_a": left, "page_b": right, "query_jaccard_ppm": similarity})
    score = complement_ppm(maximum)
    threshold = threshold_for(spec, config)
    pairs.sort(key=lambda item: (-item["query_jaccard_ppm"], item["page_a"], item["page_b"]))
    return score, score < threshold, {
        "page_pair_count": len(pages) * (len(pages) - 1) // 2,
        "maximum_query_overlap_ppm": maximum, "overlap_health_ppm": score,
        "top_overlapping_pairs": pairs[:30],
    }

def authority_service_location_cell_fragmentation(spec, normalized, config):
    rows = _require_rows(spec, normalized, config)
    service_groups = config.get("local_service_groups")
    location_groups = config.get("local_location_groups")
    if not isinstance(service_groups, Mapping) or not isinstance(location_groups, Mapping):
        raise InsufficientData("service_location_groups_missing")
    service_phrases = {
        str(group): tuple(config_phrases({"x": values}, "x"))
        for group, values in service_groups.items() if isinstance(values, list)
    }
    location_phrases = {
        str(group): tuple(config_phrases({"x": values}, "x"))
        for group, values in location_groups.items() if isinstance(values, list)
    }
    cells: dict[str, set[str]] = defaultdict(set)
    cell_impressions: dict[str, int] = defaultdict(int)
    for row in rows:
        services = [name for name, phrases in service_phrases.items() if contains_any_phrase(row["query_tokens"], phrases)]
        locations = [name for name, phrases in location_phrases.items() if contains_any_phrase(row["query_tokens"], phrases)]
        for service in services:
            for location in locations:
                key = f"{service}|{location}"
                cells[key].add(row["page_url"])
                cell_impressions[key] += row["impressions"]
    if not cells:
        raise InsufficientData("service_location_cells_empty")
    fragmented = [
        {"cell": cell, "page_count": len(pages), "pages": sorted(pages), "impressions": cell_impressions[cell]}
        for cell, pages in cells.items() if len(pages) > 1
    ]
    bad = sum(item["impressions"] for item in fragmented)
    total = sum(cell_impressions.values())
    share = bounded_ratio_ppm(min(bad, total), total) if total > 0 else 0
    score = complement_ppm(share)
    threshold = threshold_for(spec, config)
    fragmented.sort(key=lambda item: (-item["impressions"], -item["page_count"], item["cell"]))
    return score, score < threshold, {
        "cell_count": len(cells), "fragmented_cell_count": len(fragmented),
        "fragmented_cell_impression_share_ppm": share, "fragmented_cells": fragmented,
    }

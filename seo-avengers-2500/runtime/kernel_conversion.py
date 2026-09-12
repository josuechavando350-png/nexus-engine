from __future__ import annotations

from collections import defaultdict
from typing import Mapping

from .common import PPM, InsufficientData, bounded_ratio_ppm, complement_ppm
from .kernel_growth_shared import aggregate_funnel, docs_by_id, page_identity_support, scope_rows, threshold_for

def _all_and_scoped(spec, normalized, config):
    all_rows = normalized["search_performance_records"]
    scoped = scope_rows(spec, normalized, config)
    if not all_rows:
        raise InsufficientData("conversion_search_records_empty")
    if not scoped:
        raise InsufficientData("conversion_scope_empty")
    return all_rows, scoped

def conversion_impression_share(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in all_rows)
    selected = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_impressions_empty")
    score = bounded_ratio_ppm(min(selected, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_impressions": selected, "total_impressions": total, "scoped_impression_share_ppm": score}

def conversion_click_share(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["clicks"] for row in all_rows)
    selected = sum(row["clicks"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_clicks_empty")
    score = bounded_ratio_ppm(min(selected, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_clicks": selected, "total_clicks": total, "scoped_click_share_ppm": score}

def conversion_ctr_health(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    impressions = sum(row["impressions"] for row in scoped)
    clicks = sum(row["clicks"] for row in scoped)
    if impressions <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    score = bounded_ratio_ppm(min(clicks, impressions), impressions)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_clicks": clicks, "scoped_impressions": impressions, "ctr_ppm": score}

def conversion_zero_click_health(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    zero = sum(row["impressions"] for row in scoped if row["impressions"] > 0 and row["clicks"] == 0)
    bad_share = bounded_ratio_ppm(min(zero, total), total)
    score = complement_ppm(bad_share)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_impressions": total, "zero_click_impressions": zero, "zero_click_share_ppm": bad_share, "zero_click_health_ppm": score}

def conversion_top10_visibility_share(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    top = sum(row["impressions"] for row in scoped if row["average_position_milli"] <= 10_000)
    score = bounded_ratio_ppm(min(top, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_impressions": total, "top10_impressions": top, "top10_impression_share_ppm": score, "not_a_ranking_prediction": True}

def conversion_rank_gap_health(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    gap = sum(row["impressions"] for row in scoped if row["average_position_milli"] > 10_000)
    gap_share = bounded_ratio_ppm(min(gap, total), total)
    score = complement_ppm(gap_share)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_impressions": total, "outside_top10_impressions": gap, "outside_top10_share_ppm": gap_share, "rank_gap_health_ppm": score, "not_a_ranking_prediction": True}

def conversion_content_support(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    docs = docs_by_id(normalized)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    supported = 0
    unsupported = set()
    for row in scoped:
        doc = docs.get(row["page_url"])
        if doc is None:
            unsupported.add(row["page_url"])
            continue
        if set(row["query_tokens"]) & set(doc["tokens"]):
            supported += row["impressions"]
        else:
            unsupported.add(row["page_url"])
    score = bounded_ratio_ppm(min(supported, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"supported_impressions": supported, "scoped_impressions": total, "content_support_ppm": score, "unsupported_pages": sorted(unsupported)}

def conversion_identity_support(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    docs = docs_by_id(normalized)
    local = normalized["local_business_records"]
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    supported = 0
    unsupported = set()
    for row in scoped:
        doc = docs.get(row["page_url"])
        if doc is not None and page_identity_support(doc, local):
            supported += row["impressions"]
        else:
            unsupported.add(row["page_url"])
    score = bounded_ratio_ppm(min(supported, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"identity_supported_impressions": supported, "scoped_impressions": total, "local_identity_support_ppm": score, "unsupported_pages": sorted(unsupported)}

def conversion_page_specialization(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    total_page: dict[str, int] = defaultdict(int)
    scoped_page: dict[str, int] = defaultdict(int)
    for row in all_rows:
        total_page[row["page_url"]] += row["impressions"]
    for row in scoped:
        scoped_page[row["page_url"]] += row["impressions"]
    scoped_total = sum(scoped_page.values())
    if scoped_total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    specialized = 0
    page_ratios = []
    floor = int(spec["params"].get("specialization_floor_ppm", 600_000))
    for page, scoped_weight in scoped_page.items():
        total_weight = total_page[page]
        ratio = bounded_ratio_ppm(scoped_weight, total_weight) if total_weight > 0 else 0
        page_ratios.append({"page_url": page, "specialization_ppm": ratio, "scoped_impressions": scoped_weight})
        if ratio >= floor:
            specialized += scoped_weight
    score = bounded_ratio_ppm(min(specialized, scoped_total), scoped_total)
    threshold = threshold_for(spec, config)
    page_ratios.sort(key=lambda item: (item["specialization_ppm"], -item["scoped_impressions"], item["page_url"]))
    return score, score < threshold, {"specialized_impressions": specialized, "scoped_impressions": scoped_total, "specialized_impression_share_ppm": score, "specialization_floor_ppm": floor, "page_specialization": page_ratios}

def conversion_landing_concentration_health(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    weights: dict[str, int] = defaultdict(int)
    for row in scoped:
        weights[row["page_url"]] += row["impressions"]
    total = sum(weights.values())
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    page, top = sorted(weights.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    concentration = bounded_ratio_ppm(top, total)
    score = complement_ppm(concentration)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"page_count": len(weights), "top_page": page, "top_page_impressions": top, "top_page_impression_share_ppm": concentration, "concentration_health_ppm": score}

def conversion_query_breadth_share(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    all_queries = {row["query"] for row in all_rows}
    scoped_queries = {row["query"] for row in scoped}
    if not all_queries:
        raise InsufficientData("conversion_query_set_empty")
    score = bounded_ratio_ppm(len(scoped_queries), len(all_queries))
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_query_count": len(scoped_queries), "total_query_count": len(all_queries), "query_breadth_share_ppm": score}

def conversion_longtail_impression_share(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    minimum_tokens = int(spec["params"].get("longtail_min_tokens", 4))
    longtail = sum(row["impressions"] for row in scoped if len(row["query_tokens"]) >= minimum_tokens)
    score = bounded_ratio_ppm(min(longtail, total), total)
    threshold = threshold_for(spec, config)
    return score, score < threshold, {"scoped_impressions": total, "longtail_impressions": longtail, "longtail_impression_share_ppm": score, "longtail_min_tokens": minimum_tokens}

def _scope_share(all_rows, scoped, field):
    total = sum(row[field] for row in all_rows)
    selected = sum(row[field] for row in scoped)
    if total <= 0:
        raise InsufficientData(f"conversion_{field}_empty")
    return bounded_ratio_ppm(min(selected, total), total), selected, total

def conversion_lead_priority(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    share, selected, total = _scope_share(all_rows, scoped, "impressions")
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["lead_conversion_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"scope_impression_share_ppm": share, "lead_conversion_ppm": funnel["lead_conversion_ppm"], "lead_priority_index_ppm": priority, "scoped_impressions": selected, "total_impressions": total, "not_a_revenue_forecast": True, "not_a_lead_count_forecast": True}

def conversion_close_priority(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    share, selected, total = _scope_share(all_rows, scoped, "clicks")
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["close_rate_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"scope_click_share_ppm": share, "close_rate_ppm": funnel["close_rate_ppm"], "close_priority_index_ppm": priority, "scoped_clicks": selected, "total_clicks": total, "not_a_revenue_forecast": True, "not_a_client_count_forecast": True}

def conversion_composed_priority(spec, normalized, config):
    all_rows, scoped = _all_and_scoped(spec, normalized, config)
    share, selected, total = _scope_share(all_rows, scoped, "impressions")
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["composed_conversion_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"scope_impression_share_ppm": share, "composed_conversion_ppm": funnel["composed_conversion_ppm"], "composed_priority_index_ppm": priority, "scoped_impressions": selected, "total_impressions": total, "not_a_revenue_forecast": True, "not_a_client_count_forecast": True}

def conversion_zero_click_lead_priority(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    zero = sum(row["impressions"] for row in scoped if row["impressions"] > 0 and row["clicks"] == 0)
    share = bounded_ratio_ppm(min(zero, total), total)
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["lead_conversion_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"zero_click_share_ppm": share, "lead_conversion_ppm": funnel["lead_conversion_ppm"], "zero_click_lead_priority_ppm": priority, "zero_click_impressions": zero, "scoped_impressions": total, "not_a_revenue_forecast": True, "not_a_lead_count_forecast": True}

def conversion_rank_gap_lead_priority(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    gap = sum(row["impressions"] for row in scoped if row["average_position_milli"] > 10_000)
    share = bounded_ratio_ppm(min(gap, total), total)
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["lead_conversion_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"outside_top10_share_ppm": share, "lead_conversion_ppm": funnel["lead_conversion_ppm"], "rank_gap_lead_priority_ppm": priority, "outside_top10_impressions": gap, "scoped_impressions": total, "not_a_revenue_forecast": True, "not_a_rank_or_lead_forecast": True}

def conversion_content_gap_lead_priority(spec, normalized, config):
    _, scoped = _all_and_scoped(spec, normalized, config)
    docs = docs_by_id(normalized)
    total = sum(row["impressions"] for row in scoped)
    if total <= 0:
        raise InsufficientData("conversion_scope_impressions_empty")
    unsupported = 0
    for row in scoped:
        doc = docs.get(row["page_url"])
        if doc is None or not (set(row["query_tokens"]) & set(doc["tokens"])):
            unsupported += row["impressions"]
    share = bounded_ratio_ppm(min(unsupported, total), total)
    funnel = aggregate_funnel(normalized, config)
    priority = (share * funnel["lead_conversion_ppm"]) // PPM
    threshold = threshold_for(spec, config)
    return priority, priority >= threshold, {"content_gap_share_ppm": share, "lead_conversion_ppm": funnel["lead_conversion_ppm"], "content_gap_lead_priority_ppm": priority, "content_gap_impressions": unsupported, "scoped_impressions": total, "not_a_revenue_forecast": True, "not_a_lead_count_forecast": True}

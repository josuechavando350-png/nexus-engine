from __future__ import annotations

import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from .seo_avengers_1200 import (
    INT64_MAX,
    PPM_SCALE,
    canonical_hash,
    canonicalize_url_or_path,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
)


def _identity(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value).strip()
    return normalized or None


def _keyword(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value).casefold()
    collapsed = " ".join(normalized.strip().split())
    return collapsed or None


def _checked_mul(left: int, right: int) -> Optional[int]:
    if left < 0 or right < 0:
        return None
    if left != 0 and right > INT64_MAX // left:
        return None
    return left * right


def _mul_div_half_even(left: int, right: int, denominator: int) -> Optional[int]:
    product = _checked_mul(left, right)
    if product is None:
        return None
    return div_round_half_even(product, denominator, 1)


def run_m201(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect high-impression low-CTR query/page observations from explicit search data."""
    try:
        raw_hash = canonical_hash({"search_performance_records": records})
    except (TypeError, ValueError):
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_impressions = normalize_integer(config.get("m201_min_impressions", 100), 100_000_000_000)
    max_ctr = normalize_integer(config.get("m201_max_ctr_ppm", 30_000), PPM_SCALE)
    max_position_milli = normalize_integer(config.get("m201_max_average_position_milli", 20_000), 1_000_000)
    cfg_hash = canonical_hash({
        "min_impressions": min_impressions if min_impressions is not None else "INVALID",
        "max_ctr_ppm": max_ctr if max_ctr is not None else "INVALID",
        "max_average_position_milli": max_position_milli if max_position_milli is not None else "INVALID",
        "position_scale": 1000,
    })
    if min_impressions is None or max_ctr is None or max_position_milli is None:
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, None, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    registry: Dict[Tuple[str, str], Dict[str, int]] = {}
    invalid_count = 0
    conflicts: Set[Tuple[str, str]] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        query = _keyword(row.get("query"))
        page = canonicalize_url_or_path(row.get("page_url"))
        clicks = normalize_integer(row.get("clicks"), 100_000_000_000)
        impressions = normalize_integer(row.get("impressions"), 100_000_000_000)
        position = normalize_integer(row.get("average_position_milli"), 1_000_000)
        if not query or not page or clicks is None or impressions is None or position is None or clicks > impressions:
            invalid_count += 1
            continue
        key = (query, page)
        item = {"clicks": clicks, "impressions": impressions, "average_position_milli": position}
        prior = registry.get(key)
        if prior is None:
            registry[key] = item
        elif prior != item:
            conflicts.add(key)

    dataset = [
        {"query": query, "page_url": page, **item}
        for (query, page), item in sorted(registry.items())
    ]
    conflict_rows = [{"query": query, "page_url": page} for query, page in sorted(conflicts)]
    norm_hash = canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_observation_conflicts": conflict_rows,
    })
    if conflicts:
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflict_rows, "invalid_records_count": invalid_count})
    if not dataset:
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_PERFORMANCE_RECORDS",
                               {"invalid_records_count": invalid_count})

    opportunities: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["impressions"] < min_impressions or item["impressions"] == 0:
            continue
        analyzable += 1
        ctr = div_round_half_even(item["clicks"], item["impressions"], PPM_SCALE)
        if ctr is None:
            return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if ctr <= max_ctr and item["average_position_milli"] <= max_position_milli:
            opportunities.append({
                "query": item["query"],
                "page_url": item["page_url"],
                "clicks": item["clicks"],
                "impressions": item["impressions"],
                "average_position_milli": item["average_position_milli"],
                "ctr_ppm": ctr,
                "review_recommended": True,
            })
    if analyzable == 0:
        return compile_receipt("M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    opportunities.sort(key=lambda item: (-item["impressions"], item["ctr_ppm"], item["query"], item["page_url"]))
    return compile_receipt(
        "M201", "search_ctr_opportunity_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if opportunities else "NO_FINDING",
        "LOW_CTR_SEARCH_OPPORTUNITY_FOUND" if opportunities else "SEARCH_CTR_WITHIN_POLICY",
        {"ctr_scale": PPM_SCALE, "analyzed_records_count": analyzable, "invalid_records_count": invalid_count,
         "opportunities": opportunities},
    )


def run_m202(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure top-query impression concentration in an explicitly supplied search corpus."""
    try:
        raw_hash = canonical_hash({"search_performance_records": records})
    except (TypeError, ValueError):
        return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m202_top_query_count", 5), 1000)
    max_share = normalize_integer(config.get("m202_max_top_query_share_ppm", 700_000), PPM_SCALE)
    min_total_impressions = normalize_integer(config.get("m202_min_total_impressions", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "top_query_count": top_n if top_n is not None else "INVALID",
        "max_top_query_share_ppm": max_share if max_share is not None else "INVALID",
        "min_total_impressions": min_total_impressions if min_total_impressions is not None else "INVALID",
    })
    if top_n is None or top_n < 1 or max_share is None or min_total_impressions is None:
        return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, raw_hash, None, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    impressions_by_query: Dict[str, int] = {}
    invalid_count = 0
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        query = _keyword(row.get("query"))
        impressions = normalize_integer(row.get("impressions"), 100_000_000_000)
        if not query or impressions is None:
            invalid_count += 1
            continue
        prior = impressions_by_query.get(query, 0)
        if impressions > INT64_MAX - prior:
            return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, raw_hash, None, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        impressions_by_query[query] = prior + impressions

    dataset = [{"query": query, "impressions": count} for query, count in sorted(impressions_by_query.items())]
    norm_hash = canonical_hash({"queries": dataset, "invalid_records_count": invalid_count})
    total = sum(item["impressions"] for item in dataset)
    if not dataset or total < min_total_impressions or total == 0:
        return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_DEMAND_SAMPLE",
                               {"total_impressions": total, "invalid_records_count": invalid_count})

    ranked = sorted(dataset, key=lambda item: (-item["impressions"], item["query"]))
    selected = ranked[:top_n]
    top_total = sum(item["impressions"] for item in selected)
    share = div_round_half_even(top_total, total, PPM_SCALE)
    if share is None:
        return compile_receipt("M202", "search_demand_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    concentrated = share > max_share
    return compile_receipt(
        "M202", "search_demand_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if concentrated else "NO_FINDING",
        "SEARCH_DEMAND_CONCENTRATION_HIGH" if concentrated else "SEARCH_DEMAND_DIVERSIFIED",
        {"share_scale": PPM_SCALE, "total_impressions": total, "top_query_count": len(selected),
         "top_query_impressions": top_total, "top_query_share_ppm": share,
         "top_queries": selected, "invalid_records_count": invalid_count},
    )


def _prepare_keyword_coverage(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"keyword_coverage_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []
    registry: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        keyword = _keyword(row.get("keyword"))
        site_ranked = row.get("site_ranked")
        competitor_count = normalize_integer(row.get("competitor_ranked_count"), 100_000)
        search_volume = normalize_integer(row.get("search_volume"), 100_000_000_000)
        if not keyword or type(site_ranked) is not bool or competitor_count is None or search_volume is None:
            invalid_count += 1
            continue
        item = {
            "site_ranked": site_ranked,
            "competitor_ranked_count": competitor_count,
            "search_volume": search_volume,
        }
        prior = registry.get(keyword)
        if prior is None:
            registry[keyword] = item
        elif prior != item:
            conflicts.add(keyword)
    dataset = [{"keyword": keyword, **item} for keyword, item in sorted(registry.items())]
    return raw_hash, dataset, invalid_count, sorted(conflicts)


def run_m301(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect competitor-covered keywords absent from the site's supplied coverage set."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_keyword_coverage(records)
    if raw_hash is None:
        return compile_receipt("M301", "competitor_keyword_gap_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M301", "competitor_keyword_gap_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_competitors = normalize_integer(config.get("m301_min_competitor_ranked_count", 1), 100_000)
    min_volume = normalize_integer(config.get("m301_min_search_volume", 10), 100_000_000_000)
    cfg_hash = canonical_hash({
        "min_competitor_ranked_count": min_competitors if min_competitors is not None else "INVALID",
        "min_search_volume": min_volume if min_volume is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_competitors is None or min_competitors < 1 or min_volume is None:
        return compile_receipt("M301", "competitor_keyword_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M301", "competitor_keyword_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})
    if not dataset:
        return compile_receipt("M301", "competitor_keyword_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_KEYWORD_COVERAGE_RECORDS",
                               {"invalid_records_count": invalid_count})
    gaps = [
        {"keyword": item["keyword"], "competitor_ranked_count": item["competitor_ranked_count"],
         "search_volume": item["search_volume"], "review_recommended": True}
        for item in dataset
        if not item["site_ranked"]
        and item["competitor_ranked_count"] >= min_competitors
        and item["search_volume"] >= min_volume
    ]
    gaps.sort(key=lambda item: (-item["search_volume"], -item["competitor_ranked_count"], item["keyword"]))
    return compile_receipt(
        "M301", "competitor_keyword_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if gaps else "NO_FINDING",
        "COMPETITOR_KEYWORD_GAP_FOUND" if gaps else "NO_COMPETITOR_KEYWORD_GAP",
        {"checked_keywords_count": len(dataset), "invalid_records_count": invalid_count, "keyword_gaps": gaps},
    )


def run_m302(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure search-volume-weighted site coverage across tracked competitive keywords."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_keyword_coverage(records)
    if raw_hash is None:
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_share = normalize_integer(config.get("m302_min_weighted_coverage_ppm", 500_000), PPM_SCALE)
    min_tracked_volume = normalize_integer(config.get("m302_min_tracked_search_volume", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "min_weighted_coverage_ppm": min_share if min_share is not None else "INVALID",
        "min_tracked_search_volume": min_tracked_volume if min_tracked_volume is not None else "INVALID",
        "weight": "search_volume",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_share is None or min_tracked_volume is None:
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})
    relevant = [item for item in dataset if item["competitor_ranked_count"] > 0 or item["site_ranked"]]
    total_volume = sum(item["search_volume"] for item in relevant)
    if not relevant or total_volume < min_tracked_volume or total_volume == 0:
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_KEYWORD_SAMPLE",
                               {"relevant_keywords_count": len(relevant), "tracked_search_volume": total_volume,
                                "invalid_records_count": invalid_count})
    covered_volume = sum(item["search_volume"] for item in relevant if item["site_ranked"])
    share = div_round_half_even(covered_volume, total_volume, PPM_SCALE)
    if share is None:
        return compile_receipt("M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    return compile_receipt(
        "M302", "competitive_keyword_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if low else "NO_FINDING",
        "COMPETITIVE_COVERAGE_SHARE_LOW" if low else "COMPETITIVE_COVERAGE_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "relevant_keywords_count": len(relevant), "tracked_search_volume": total_volume,
         "site_covered_search_volume": covered_volume, "weighted_coverage_ppm": share,
         "invalid_records_count": invalid_count},
    )


def _prepare_traffic_windows(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"traffic_window_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []
    registry: Dict[str, Dict[str, int]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        entity_id = _identity(row.get("entity_id"))
        baseline = normalize_integer(row.get("baseline_visits"), 1_000_000_000_000)
        current = normalize_integer(row.get("current_visits"), 1_000_000_000_000)
        baseline_days = normalize_integer(row.get("baseline_window_days"), 3660)
        current_days = normalize_integer(row.get("current_window_days"), 3660)
        if not entity_id or baseline is None or current is None or baseline_days is None or current_days is None or baseline_days == 0 or baseline_days != current_days:
            invalid_count += 1
            continue
        item = {"baseline_visits": baseline, "current_visits": current, "window_days": baseline_days}
        prior = registry.get(entity_id)
        if prior is None:
            registry[entity_id] = item
        elif prior != item:
            conflicts.add(entity_id)
    return raw_hash, [{"entity_id": entity, **item} for entity, item in sorted(registry.items())], invalid_count, sorted(conflicts)


def run_m401(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect material equal-window traffic changes without pretending to forecast."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_windows(records)
    if raw_hash is None:
        return compile_receipt("M401", "traffic_window_change_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M401", "traffic_window_change_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_baseline = normalize_integer(config.get("m401_min_baseline_visits", 100), 1_000_000_000_000)
    min_change = normalize_integer(config.get("m401_min_absolute_change_ppm", 200_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_baseline_visits": min_baseline if min_baseline is not None else "INVALID",
        "min_absolute_change_ppm": min_change if min_change is not None else "INVALID",
        "window_policy": "equal_duration_required",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_baseline is None or min_change is None:
        return compile_receipt("M401", "traffic_window_change_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M401", "traffic_window_change_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_WINDOW_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts, "invalid_records_count": invalid_count})

    changes: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        baseline = item["baseline_visits"]
        if baseline < min_baseline or baseline == 0:
            continue
        analyzable += 1
        current = item["current_visits"]
        delta = current - baseline
        magnitude = abs(delta)
        change_ppm = div_round_half_even(magnitude, baseline, PPM_SCALE)
        if change_ppm is None:
            return compile_receipt("M401", "traffic_window_change_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if change_ppm >= min_change:
            changes.append({
                "entity_id": item["entity_id"],
                "baseline_visits": baseline,
                "current_visits": current,
                "window_days": item["window_days"],
                "direction": "UP" if delta > 0 else "DOWN" if delta < 0 else "FLAT",
                "absolute_change_ppm": change_ppm,
            })
    if analyzable == 0:
        return compile_receipt("M401", "traffic_window_change_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_BASELINE",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    changes.sort(key=lambda item: (-item["absolute_change_ppm"], item["entity_id"]))
    return compile_receipt(
        "M401", "traffic_window_change_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if changes else "NO_FINDING",
        "MATERIAL_TRAFFIC_CHANGE_FOUND" if changes else "TRAFFIC_CHANGE_WITHIN_POLICY",
        {"change_scale": PPM_SCALE, "analyzed_records_count": analyzable,
         "invalid_records_count": invalid_count, "material_changes": changes},
    )


def run_m402(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor relative mean absolute deviation of bounded traffic series."""
    try:
        raw_hash = canonical_hash({"traffic_series_records": records})
    except (TypeError, ValueError):
        return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_points = normalize_integer(config.get("m402_min_points", 7), 366)
    max_volatility = normalize_integer(config.get("m402_max_relative_mad_ppm", 300_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "max_relative_mad_ppm": max_volatility if max_volatility is not None else "INVALID",
        "metric": "mean_absolute_deviation_over_mean_ppm",
        "max_point_visits": 1_000_000,
    })
    if min_points is None or min_points < 2 or max_volatility is None:
        return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, raw_hash, None, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    registry: Dict[str, Tuple[int, ...]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        entity_id = _identity(row.get("entity_id"))
        raw_points = row.get("visits_series")
        if not entity_id or not isinstance(raw_points, list) or len(raw_points) > 366:
            invalid_count += 1
            continue
        points: List[int] = []
        valid = True
        for point in raw_points:
            clean = normalize_integer(point, 1_000_000)
            if clean is None:
                valid = False
                break
            points.append(clean)
        if not valid:
            invalid_count += 1
            continue
        series = tuple(points)
        prior = registry.get(entity_id)
        if prior is None:
            registry[entity_id] = series
        elif prior != series:
            conflicts.add(entity_id)
    dataset = [{"entity_id": entity, "visits_series": list(series)} for entity, series in sorted(registry.items())]
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": sorted(conflicts)})
    if conflicts:
        return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": sorted(conflicts), "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        count = len(points)
        total = sum(points)
        if count < min_points or total == 0:
            continue
        analyzable += 1
        absolute_scaled_deviations = sum(abs(point * count - total) for point in points)
        denominator = count * total
        volatility = div_round_half_even(absolute_scaled_deviations, denominator, PPM_SCALE)
        if volatility is None:
            return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if volatility > max_volatility:
            findings.append({"entity_id": item["entity_id"], "points_count": count,
                             "relative_mad_ppm": volatility})
    if analyzable == 0:
        return compile_receipt("M402", "traffic_volatility_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_SERIES",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["relative_mad_ppm"], item["entity_id"]))
    return compile_receipt(
        "M402", "traffic_volatility_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "TRAFFIC_VOLATILITY_HIGH" if findings else "TRAFFIC_VOLATILITY_WITHIN_POLICY",
        {"volatility_scale": PPM_SCALE, "analyzed_series_count": analyzable,
         "invalid_records_count": invalid_count, "volatile_entities": findings},
    )


def run_m501(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Project funnel revenue from explicitly supplied integer rates and ticket values."""
    try:
        raw_hash = canonical_hash({"revenue_funnel_records": records})
    except (TypeError, ValueError):
        return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_sessions = normalize_integer(config.get("m501_min_sessions", 100), 1_000_000_000_000)
    cfg_hash = canonical_hash({"min_sessions": min_sessions if min_sessions is not None else "INVALID",
                               "rate_scale": PPM_SCALE, "currency_unit": "micros"})
    if min_sessions is None:
        return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, None, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    registry: Dict[str, Dict[str, int]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_id = _identity(row.get("source_id"))
        sessions = normalize_integer(row.get("sessions"), 1_000_000_000_000)
        lead_rate = normalize_integer(row.get("lead_conversion_ppm"), PPM_SCALE)
        close_rate = normalize_integer(row.get("close_rate_ppm"), PPM_SCALE)
        ticket = normalize_integer(row.get("average_ticket_micros"), 1_000_000_000_000_000)
        if not source_id or None in (sessions, lead_rate, close_rate, ticket):
            invalid_count += 1
            continue
        item = {"sessions": sessions, "lead_conversion_ppm": lead_rate,
                "close_rate_ppm": close_rate, "average_ticket_micros": ticket}
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)
    dataset = [{"source_id": source, **item} for source, item in sorted(registry.items())]
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": sorted(conflicts)})
    if conflicts:
        return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_REVENUE_FUNNEL_CONFLICT",
                               {"duplicate_source_conflicts": sorted(conflicts), "invalid_records_count": invalid_count})

    projections: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["sessions"] < min_sessions:
            continue
        analyzable += 1
        projected_leads = _mul_div_half_even(item["sessions"], item["lead_conversion_ppm"], PPM_SCALE)
        if projected_leads is None:
            return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        projected_sales = _mul_div_half_even(projected_leads, item["close_rate_ppm"], PPM_SCALE)
        if projected_sales is None:
            return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        projected_revenue = _checked_mul(projected_sales, item["average_ticket_micros"])
        if projected_revenue is None:
            return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        projections.append({
            "source_id": item["source_id"],
            "sessions": item["sessions"],
            "projected_leads": projected_leads,
            "projected_sales": projected_sales,
            "projected_revenue_micros": projected_revenue,
        })
    if analyzable == 0:
        return compile_receipt("M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_FUNNEL_VOLUME",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    projections.sort(key=lambda item: (-item["projected_revenue_micros"], item["source_id"]))
    return compile_receipt(
        "M501", "funnel_revenue_projection_auditor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "NO_FINDING", "FUNNEL_REVENUE_PROJECTION_COMPUTED",
        {"currency_unit": "micros", "analyzed_sources_count": analyzable,
         "invalid_records_count": invalid_count, "projections": projections},
    )


def run_m502(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure attributed revenue coverage against explicit total observed revenue."""
    try:
        raw_hash = canonical_hash({"revenue_attribution_records": records})
    except (TypeError, ValueError):
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_coverage = normalize_integer(config.get("m502_min_attribution_coverage_ppm", 900_000), PPM_SCALE)
    min_total_revenue = normalize_integer(config.get("m502_min_total_revenue_micros", 1), INT64_MAX)
    cfg_hash = canonical_hash({
        "min_attribution_coverage_ppm": min_coverage if min_coverage is not None else "INVALID",
        "min_total_revenue_micros": min_total_revenue if min_total_revenue is not None else "INVALID",
        "currency_unit": "micros",
    })
    if min_coverage is None or min_total_revenue is None:
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, None, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    registry: Dict[str, Tuple[int, int]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_id = _identity(row.get("source_id"))
        total = normalize_integer(row.get("total_revenue_micros"), INT64_MAX)
        attributed = normalize_integer(row.get("attributed_revenue_micros"), INT64_MAX)
        if not source_id or total is None or attributed is None or attributed > total:
            invalid_count += 1
            continue
        item = (total, attributed)
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)
    dataset = [
        {"source_id": source, "total_revenue_micros": values[0], "attributed_revenue_micros": values[1]}
        for source, values in sorted(registry.items())
    ]
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": sorted(conflicts)})
    if conflicts:
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_REVENUE_ATTRIBUTION_CONFLICT",
                               {"duplicate_source_conflicts": sorted(conflicts), "invalid_records_count": invalid_count})

    total_all = 0
    attributed_all = 0
    for item in dataset:
        if total_all > INT64_MAX - item["total_revenue_micros"] or attributed_all > INT64_MAX - item["attributed_revenue_micros"]:
            return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_all += item["total_revenue_micros"]
        attributed_all += item["attributed_revenue_micros"]
    if not dataset or total_all < min_total_revenue or total_all == 0:
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_REVENUE_SAMPLE",
                               {"total_revenue_micros": total_all, "invalid_records_count": invalid_count})
    coverage = div_round_half_even(attributed_all, total_all, PPM_SCALE)
    if coverage is None:
        return compile_receipt("M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    low = coverage < min_coverage
    return compile_receipt(
        "M502", "revenue_attribution_coverage_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if low else "NO_FINDING",
        "REVENUE_ATTRIBUTION_COVERAGE_LOW" if low else "REVENUE_ATTRIBUTION_COVERAGE_WITHIN_POLICY",
        {"coverage_scale": PPM_SCALE, "total_revenue_micros": total_all,
         "attributed_revenue_micros": attributed_all, "attribution_coverage_ppm": coverage,
         "checked_sources_count": len(dataset), "invalid_records_count": invalid_count},
    )

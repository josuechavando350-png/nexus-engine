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


def _checked_add(left: int, right: int) -> Optional[int]:
    if left < 0 or right < 0 or left > INT64_MAX - right:
        return None
    return left + right


def _prepare_search_records(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[Dict[str, str]]]:
    try:
        raw_hash = canonical_hash({"search_performance_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []

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
    return raw_hash, dataset, invalid_count, conflict_rows


def _prepare_competitor_records(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
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


def _prepare_traffic_series(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"traffic_series_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []

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
    return raw_hash, dataset, invalid_count, sorted(conflicts)


def _prepare_funnel_records(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"revenue_funnel_records": records})
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
        source_id = _identity(row.get("source_id"))
        sessions = normalize_integer(row.get("sessions"), 1_000_000_000_000)
        lead_rate = normalize_integer(row.get("lead_conversion_ppm"), PPM_SCALE)
        close_rate = normalize_integer(row.get("close_rate_ppm"), PPM_SCALE)
        if not source_id or sessions is None or lead_rate is None or close_rate is None:
            invalid_count += 1
            continue
        item = {"sessions": sessions, "lead_conversion_ppm": lead_rate, "close_rate_ppm": close_rate}
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)

    dataset = [{"source_id": source, **item} for source, item in sorted(registry.items())]
    return raw_hash, dataset, invalid_count, sorted(conflicts)


def _prepare_attribution_records(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"revenue_attribution_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []

    registry: Dict[str, int] = {}
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
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = attributed
        elif prior != attributed:
            conflicts.add(source_id)

    dataset = [
        {"source_id": source, "attributed_revenue_micros": attributed}
        for source, attributed in sorted(registry.items())
    ]
    return raw_hash, dataset, invalid_count, sorted(conflicts)


def run_m203(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect zero-click exposure from explicit query/page Search Console-style observations."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_impressions = normalize_integer(config.get("m203_min_impressions", 100), 100_000_000_000)
    max_position = normalize_integer(config.get("m203_max_average_position_milli", 20_000), 1_000_000)
    cfg_hash = canonical_hash({
        "min_impressions": min_impressions if min_impressions is not None else "INVALID",
        "max_average_position_milli": max_position if max_position is not None else "INVALID",
        "position_scale": 1000,
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if min_impressions is None or max_position is None:
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts, "invalid_records_count": invalid_count})
    if not dataset:
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_PERFORMANCE_RECORDS",
                               {"invalid_records_count": invalid_count})

    analyzable = 0
    findings: List[Dict[str, Any]] = []
    for item in dataset:
        if item["impressions"] < min_impressions:
            continue
        analyzable += 1
        if item["clicks"] == 0 and item["average_position_milli"] <= max_position:
            findings.append({
                "query": item["query"],
                "page_url": item["page_url"],
                "impressions": item["impressions"],
                "average_position_milli": item["average_position_milli"],
                "review_recommended": True,
            })
    if analyzable == 0:
        return compile_receipt("M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["impressions"], item["average_position_milli"], item["query"], item["page_url"]))
    return compile_receipt(
        "M203", "zero_click_search_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "ZERO_CLICK_SEARCH_EXPOSURE_FOUND" if findings else "ZERO_CLICK_EXPOSURE_WITHIN_POLICY",
        {"analyzed_records_count": analyzable, "invalid_records_count": invalid_count,
         "zero_click_exposures": findings},
    )


def run_m204(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect one query receiving material exposure across multiple distinct pages."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_total_impressions = normalize_integer(config.get("m204_min_query_impressions", 100), 100_000_000_000)
    min_pages = normalize_integer(config.get("m204_min_distinct_pages", 2), 1000)
    cfg_hash = canonical_hash({
        "min_query_impressions": min_total_impressions if min_total_impressions is not None else "INVALID",
        "min_distinct_pages": min_pages if min_pages is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if min_total_impressions is None or min_pages is None or min_pages < 2:
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts, "invalid_records_count": invalid_count})
    if not dataset:
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_PERFORMANCE_RECORDS",
                               {"invalid_records_count": invalid_count})

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for item in dataset:
        grouped.setdefault(item["query"], []).append(item)

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for query, rows in sorted(grouped.items()):
        total = 0
        for row in rows:
            added = _checked_add(total, row["impressions"])
            if added is None:
                return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1,
                                       raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                       "ARITHMETIC_RANGE_EXCEEDED", {})
            total = added
        if total < min_total_impressions:
            continue
        analyzable += 1
        if len(rows) >= min_pages:
            pages = [
                {"page_url": row["page_url"], "impressions": row["impressions"], "clicks": row["clicks"]}
                for row in sorted(rows, key=lambda row: (-row["impressions"], row["page_url"]))
            ]
            findings.append({"query": query, "total_impressions": total,
                             "distinct_pages_count": len(rows), "pages": pages,
                             "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_QUERY_IMPRESSIONS",
                               {"queries_count": len(grouped), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["total_impressions"], -item["distinct_pages_count"], item["query"]))
    return compile_receipt(
        "M204", "search_query_multi_page_exposure_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "MULTI_PAGE_QUERY_EXPOSURE_FOUND" if findings else "QUERY_PAGE_EXPOSURE_WITHIN_POLICY",
        {"analyzed_queries_count": analyzable, "invalid_records_count": invalid_count,
         "multi_page_queries": findings},
    )


def run_m303(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure search-volume share exposed to a configured level of competitor saturation."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_competitors = normalize_integer(config.get("m303_min_competitor_ranked_count", 3), 100_000)
    max_share = normalize_integer(config.get("m303_max_saturated_volume_share_ppm", 700_000), PPM_SCALE)
    min_volume = normalize_integer(config.get("m303_min_tracked_search_volume", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "min_competitor_ranked_count": min_competitors if min_competitors is not None else "INVALID",
        "max_saturated_volume_share_ppm": max_share if max_share is not None else "INVALID",
        "min_tracked_search_volume": min_volume if min_volume is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_competitors is None or min_competitors < 1 or max_share is None or min_volume is None:
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})

    total_volume = 0
    saturated_volume = 0
    saturated_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        added = _checked_add(total_volume, item["search_volume"])
        if added is None:
            return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_volume = added
        if item["competitor_ranked_count"] >= min_competitors:
            added_saturated = _checked_add(saturated_volume, item["search_volume"])
            if added_saturated is None:
                return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            saturated_volume = added_saturated
            saturated_keywords.append({"keyword": item["keyword"],
                                       "competitor_ranked_count": item["competitor_ranked_count"],
                                       "search_volume": item["search_volume"]})
    if not dataset or total_volume < min_volume or total_volume == 0:
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_SEARCH_VOLUME",
                               {"tracked_search_volume": total_volume, "invalid_records_count": invalid_count})
    share = div_round_half_even(saturated_volume, total_volume, PPM_SCALE)
    if share is None:
        return compile_receipt("M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    saturated_keywords.sort(key=lambda item: (-item["search_volume"], -item["competitor_ranked_count"], item["keyword"]))
    high = share > max_share
    return compile_receipt(
        "M303", "competitor_saturation_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITOR_SATURATION_SHARE_HIGH" if high else "COMPETITOR_SATURATION_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "tracked_search_volume": total_volume,
         "saturated_search_volume": saturated_volume, "saturated_volume_share_ppm": share,
         "saturated_keywords": saturated_keywords, "invalid_records_count": invalid_count},
    )


def run_m304(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure whether uncovered competitive opportunity volume is concentrated in a few keywords."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m304_top_opportunity_count", 5), 1000)
    max_share = normalize_integer(config.get("m304_max_top_opportunity_share_ppm", 700_000), PPM_SCALE)
    min_volume = normalize_integer(config.get("m304_min_uncovered_search_volume", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "top_opportunity_count": top_n if top_n is not None else "INVALID",
        "max_top_opportunity_share_ppm": max_share if max_share is not None else "INVALID",
        "min_uncovered_search_volume": min_volume if min_volume is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if top_n is None or top_n < 1 or max_share is None or min_volume is None:
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})

    opportunities = [item for item in dataset if not item["site_ranked"]
                     and item["competitor_ranked_count"] > 0 and item["search_volume"] > 0]
    opportunities.sort(key=lambda item: (-item["search_volume"], -item["competitor_ranked_count"], item["keyword"]))
    total_volume = 0
    for item in opportunities:
        added = _checked_add(total_volume, item["search_volume"])
        if added is None:
            return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        total_volume = added
    if not opportunities:
        return compile_receipt(
            "M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "SUCCESS", "NO_FINDING", "NO_UNCOVERED_COMPETITIVE_VOLUME",
            {"share_scale": PPM_SCALE, "uncovered_search_volume": 0,
             "invalid_records_count": invalid_count, "top_opportunities": []},
        )
    if total_volume < min_volume:
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_UNCOVERED_SEARCH_VOLUME",
                               {"uncovered_search_volume": total_volume, "invalid_records_count": invalid_count})
    selected = opportunities[:top_n]
    top_volume = sum(item["search_volume"] for item in selected)
    share = div_round_half_even(top_volume, total_volume, PPM_SCALE)
    if share is None:
        return compile_receipt("M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    top_rows = [{"keyword": item["keyword"], "search_volume": item["search_volume"],
                 "competitor_ranked_count": item["competitor_ranked_count"]} for item in selected]
    return compile_receipt(
        "M304", "uncovered_keyword_opportunity_concentration_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "UNCOVERED_OPPORTUNITY_CONCENTRATION_HIGH" if high else "UNCOVERED_OPPORTUNITY_DIVERSIFIED",
        {"share_scale": PPM_SCALE, "uncovered_search_volume": total_volume,
         "top_opportunity_search_volume": top_volume, "top_opportunity_share_ppm": share,
         "top_opportunities": top_rows, "invalid_records_count": invalid_count},
    )


def run_m403(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect sustained consecutive declines in explicit bounded traffic series."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M403", "traffic_decline_streak_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M403", "traffic_decline_streak_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m403_min_points", 7), 366)
    min_declines = normalize_integer(config.get("m403_min_consecutive_declines", 3), 365)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "min_consecutive_declines": min_declines if min_declines is not None else "INVALID",
        "decline_definition": "strictly_lower_than_previous_point",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 2 or min_declines is None or min_declines < 1:
        return compile_receipt("M403", "traffic_decline_streak_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M403", "traffic_decline_streak_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        if len(points) < min_points:
            continue
        analyzable += 1
        current = 0
        longest = 0
        for index in range(1, len(points)):
            if points[index] < points[index - 1]:
                current += 1
                longest = max(longest, current)
            else:
                current = 0
        if longest >= min_declines:
            findings.append({"entity_id": item["entity_id"], "points_count": len(points),
                             "longest_consecutive_declines": longest,
                             "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M403", "traffic_decline_streak_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_SERIES",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["longest_consecutive_declines"], item["entity_id"]))
    return compile_receipt(
        "M403", "traffic_decline_streak_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "SUSTAINED_TRAFFIC_DECLINE_STREAK_FOUND" if findings else "TRAFFIC_DECLINE_STREAK_WITHIN_POLICY",
        {"analyzed_series_count": analyzable, "invalid_records_count": invalid_count,
         "declining_entities": findings},
    )


def run_m404(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure single-interval traffic concentration inside explicit bounded series."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m404_min_points", 7), 366)
    max_share = normalize_integer(config.get("m404_max_peak_share_ppm", 400_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "max_peak_share_ppm": max_share if max_share is not None else "INVALID",
        "metric": "max_point_over_series_total_ppm",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 2 or max_share is None:
        return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        total = sum(points)
        if len(points) < min_points or total == 0:
            continue
        analyzable += 1
        peak = max(points)
        share = div_round_half_even(peak, total, PPM_SCALE)
        if share is None:
            return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if share > max_share:
            findings.append({"entity_id": item["entity_id"], "points_count": len(points),
                             "peak_visits": peak, "series_total_visits": total,
                             "peak_share_ppm": share})
    if analyzable == 0:
        return compile_receipt("M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_SERIES",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["peak_share_ppm"], item["entity_id"]))
    return compile_receipt(
        "M404", "traffic_peak_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "TRAFFIC_PEAK_CONCENTRATION_HIGH" if findings else "TRAFFIC_PEAK_CONCENTRATION_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "analyzed_series_count": analyzable,
         "invalid_records_count": invalid_count, "concentrated_entities": findings},
    )


def run_m503(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor explicit lead and close conversion stages without projecting causal uplift."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_funnel_records(records)
    if raw_hash is None:
        return compile_receipt("M503", "funnel_stage_conversion_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M503", "funnel_stage_conversion_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_sessions = normalize_integer(config.get("m503_min_sessions", 100), 1_000_000_000_000)
    min_lead = normalize_integer(config.get("m503_min_lead_conversion_ppm", 20_000), PPM_SCALE)
    min_close = normalize_integer(config.get("m503_min_close_rate_ppm", 200_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_sessions": min_sessions if min_sessions is not None else "INVALID",
        "min_lead_conversion_ppm": min_lead if min_lead is not None else "INVALID",
        "min_close_rate_ppm": min_close if min_close is not None else "INVALID",
        "rate_scale": PPM_SCALE,
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sessions is None or min_lead is None or min_close is None:
        return compile_receipt("M503", "funnel_stage_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M503", "funnel_stage_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_REVENUE_FUNNEL_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["sessions"] < min_sessions:
            continue
        analyzable += 1
        weak: List[str] = []
        if item["lead_conversion_ppm"] < min_lead:
            weak.append("LEAD_CONVERSION")
        if item["close_rate_ppm"] < min_close:
            weak.append("CLOSE_RATE")
        if weak:
            findings.append({"source_id": item["source_id"], "sessions": item["sessions"],
                             "lead_conversion_ppm": item["lead_conversion_ppm"],
                             "close_rate_ppm": item["close_rate_ppm"],
                             "below_policy_stages": weak, "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M503", "funnel_stage_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_FUNNEL_VOLUME",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["source_id"], item["below_policy_stages"]))
    return compile_receipt(
        "M503", "funnel_stage_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "FUNNEL_STAGE_CONVERSION_BELOW_POLICY" if findings else "FUNNEL_STAGE_CONVERSION_WITHIN_POLICY",
        {"rate_scale": PPM_SCALE, "analyzed_sources_count": analyzable,
         "invalid_records_count": invalid_count, "below_policy_sources": findings},
    )


def run_m504(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure concentration of attributed revenue across explicitly identified sources."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_attribution_records(records)
    if raw_hash is None:
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m504_top_source_count", 1), 1000)
    max_share = normalize_integer(config.get("m504_max_top_source_share_ppm", 700_000), PPM_SCALE)
    min_attributed = normalize_integer(config.get("m504_min_total_attributed_revenue_micros", 1), INT64_MAX)
    cfg_hash = canonical_hash({
        "top_source_count": top_n if top_n is not None else "INVALID",
        "max_top_source_share_ppm": max_share if max_share is not None else "INVALID",
        "min_total_attributed_revenue_micros": min_attributed if min_attributed is not None else "INVALID",
        "currency_unit": "micros",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if top_n is None or top_n < 1 or max_share is None or min_attributed is None:
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_REVENUE_ATTRIBUTION_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    total_attributed = 0
    for item in dataset:
        added = _checked_add(total_attributed, item["attributed_revenue_micros"])
        if added is None:
            return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        total_attributed = added
    if not dataset or total_attributed < min_attributed or total_attributed == 0:
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_ATTRIBUTED_REVENUE",
                               {"total_attributed_revenue_micros": total_attributed,
                                "invalid_records_count": invalid_count})

    ranked = sorted(dataset, key=lambda item: (-item["attributed_revenue_micros"], item["source_id"]))
    selected = ranked[:top_n]
    top_total = 0
    for item in selected:
        added = _checked_add(top_total, item["attributed_revenue_micros"])
        if added is None:
            return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        top_total = added
    share = div_round_half_even(top_total, total_attributed, PPM_SCALE)
    if share is None:
        return compile_receipt("M504", "attributed_revenue_source_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    return compile_receipt(
        "M504", "attributed_revenue_source_concentration_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "ATTRIBUTED_REVENUE_SOURCE_CONCENTRATION_HIGH" if high else "ATTRIBUTED_REVENUE_SOURCE_DIVERSIFIED",
        {"share_scale": PPM_SCALE, "currency_unit": "micros",
         "total_attributed_revenue_micros": total_attributed,
         "top_source_attributed_revenue_micros": top_total, "top_source_share_ppm": share,
         "top_sources": selected, "invalid_records_count": invalid_count},
    )

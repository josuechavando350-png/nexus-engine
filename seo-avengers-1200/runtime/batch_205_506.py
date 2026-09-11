from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from .batch_203_504 import (
    _checked_add,
    _identity,
    _prepare_competitor_records,
    _prepare_funnel_records,
    _prepare_search_records,
    _prepare_traffic_series,
)
from .seo_avengers_1200 import (
    INT64_MAX,
    PPM_SCALE,
    canonical_hash,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
)


def run_m205(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure impression share inside an explicitly configured average-position band."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_position = normalize_integer(config.get("m205_min_average_position_milli", 10_000), 1_000_000)
    max_position = normalize_integer(config.get("m205_max_average_position_milli", 20_000), 1_000_000)
    min_total = normalize_integer(config.get("m205_min_total_impressions", 100), 100_000_000_000)
    min_share = normalize_integer(config.get("m205_min_band_exposure_share_ppm", 300_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_average_position_milli": min_position if min_position is not None else "INVALID",
        "max_average_position_milli": max_position if max_position is not None else "INVALID",
        "min_total_impressions": min_total if min_total is not None else "INVALID",
        "min_band_exposure_share_ppm": min_share if min_share is not None else "INVALID",
        "position_scale": 1000,
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if min_position is None or max_position is None or min_position > max_position or min_total is None or min_share is None:
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts, "invalid_records_count": invalid_count})

    total_impressions = 0
    band_impressions = 0
    band_rows: List[Dict[str, Any]] = []
    for item in dataset:
        total_next = _checked_add(total_impressions, item["impressions"])
        if total_next is None:
            return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_impressions = total_next
        if min_position <= item["average_position_milli"] <= max_position:
            band_next = _checked_add(band_impressions, item["impressions"])
            if band_next is None:
                return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            band_impressions = band_next
            if item["impressions"] > 0:
                band_rows.append({
                    "query": item["query"],
                    "page_url": item["page_url"],
                    "impressions": item["impressions"],
                    "average_position_milli": item["average_position_milli"],
                })
    if not dataset or total_impressions < min_total or total_impressions == 0:
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"total_impressions": total_impressions, "invalid_records_count": invalid_count})
    share = div_round_half_even(band_impressions, total_impressions, PPM_SCALE)
    if share is None:
        return compile_receipt("M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share >= min_share
    band_rows.sort(key=lambda item: (-item["impressions"], item["average_position_milli"], item["query"], item["page_url"]))
    return compile_receipt(
        "M205", "search_position_band_exposure_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "SEARCH_POSITION_BAND_EXPOSURE_HIGH" if high else "SEARCH_POSITION_BAND_EXPOSURE_BELOW_POLICY",
        {"share_scale": PPM_SCALE, "total_impressions": total_impressions,
         "band_impressions": band_impressions, "band_exposure_share_ppm": share,
         "band_records": band_rows, "invalid_records_count": invalid_count},
    )


def run_m206(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure concentration of observed search clicks in the top N query/page records."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m206_top_record_count", 5), 1000)
    max_share = normalize_integer(config.get("m206_max_top_click_share_ppm", 700_000), PPM_SCALE)
    min_clicks = normalize_integer(config.get("m206_min_total_clicks", 10), 100_000_000_000)
    cfg_hash = canonical_hash({
        "top_record_count": top_n if top_n is not None else "INVALID",
        "max_top_click_share_ppm": max_share if max_share is not None else "INVALID",
        "min_total_clicks": min_clicks if min_clicks is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if top_n is None or top_n < 1 or max_share is None or min_clicks is None:
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts, "invalid_records_count": invalid_count})

    ranked = sorted(dataset, key=lambda item: (-item["clicks"], -item["impressions"], item["query"], item["page_url"]))
    total_clicks = 0
    for item in ranked:
        next_total = _checked_add(total_clicks, item["clicks"])
        if next_total is None:
            return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_clicks = next_total
    if not ranked or total_clicks < min_clicks or total_clicks == 0:
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_CLICKS",
                               {"total_clicks": total_clicks, "invalid_records_count": invalid_count})
    selected = ranked[:top_n]
    top_clicks = sum(item["clicks"] for item in selected)
    share = div_round_half_even(top_clicks, total_clicks, PPM_SCALE)
    if share is None:
        return compile_receipt("M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    top_rows = [{"query": item["query"], "page_url": item["page_url"], "clicks": item["clicks"],
                 "impressions": item["impressions"]} for item in selected]
    return compile_receipt(
        "M206", "search_click_concentration_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "SEARCH_CLICK_CONCENTRATION_HIGH" if high else "SEARCH_CLICK_CONCENTRATION_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "total_clicks": total_clicks,
         "top_record_clicks": top_clicks, "top_click_share_ppm": share,
         "top_records": top_rows, "invalid_records_count": invalid_count},
    )


def run_m305(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure count-based site coverage across the supplied competitive keyword corpus."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_keywords = normalize_integer(config.get("m305_min_relevant_keywords", 10), 100_000)
    min_share = normalize_integer(config.get("m305_min_keyword_coverage_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_relevant_keywords": min_keywords if min_keywords is not None else "INVALID",
        "min_keyword_coverage_ppm": min_share if min_share is not None else "INVALID",
        "relevant_definition": "competitor_ranked_or_site_ranked",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_keywords is None or min_keywords < 1 or min_share is None:
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})

    relevant = [item for item in dataset if item["competitor_ranked_count"] > 0 or item["site_ranked"]]
    if len(relevant) < min_keywords:
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_KEYWORD_SAMPLE",
                               {"relevant_keywords_count": len(relevant), "invalid_records_count": invalid_count})
    covered = sum(1 for item in relevant if item["site_ranked"])
    share = div_round_half_even(covered, len(relevant), PPM_SCALE)
    if share is None:
        return compile_receipt("M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    return compile_receipt(
        "M305", "competitive_keyword_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if low else "NO_FINDING",
        "COMPETITIVE_KEYWORD_BREADTH_LOW" if low else "COMPETITIVE_KEYWORD_BREADTH_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "relevant_keywords_count": len(relevant),
         "site_ranked_keywords_count": covered, "keyword_coverage_ppm": share,
         "invalid_records_count": invalid_count},
    )


def run_m306(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure how much site-covered search volume is also covered by tracked competitors."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    max_share = normalize_integer(config.get("m306_max_contested_coverage_ppm", 800_000), PPM_SCALE)
    min_volume = normalize_integer(config.get("m306_min_site_covered_search_volume", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "max_contested_coverage_ppm": max_share if max_share is not None else "INVALID",
        "min_site_covered_search_volume": min_volume if min_volume is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if max_share is None or min_volume is None:
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count})

    site_volume = 0
    contested_volume = 0
    for item in dataset:
        if not item["site_ranked"]:
            continue
        next_site = _checked_add(site_volume, item["search_volume"])
        if next_site is None:
            return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        site_volume = next_site
        if item["competitor_ranked_count"] > 0:
            next_contested = _checked_add(contested_volume, item["search_volume"])
            if next_contested is None:
                return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            contested_volume = next_contested
    if site_volume < min_volume or site_volume == 0:
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SITE_COVERED_SEARCH_VOLUME",
                               {"site_covered_search_volume": site_volume, "invalid_records_count": invalid_count})
    share = div_round_half_even(contested_volume, site_volume, PPM_SCALE)
    if share is None:
        return compile_receipt("M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    return compile_receipt(
        "M306", "contested_site_coverage_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "CONTESTED_SITE_COVERAGE_SHARE_HIGH" if high else "CONTESTED_SITE_COVERAGE_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "site_covered_search_volume": site_volume,
         "contested_search_volume": contested_volume, "contested_coverage_ppm": share,
         "invalid_records_count": invalid_count},
    )


def run_m405(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure the share of zero-visit intervals in explicit bounded traffic series."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m405_min_points", 7), 366)
    max_share = normalize_integer(config.get("m405_max_zero_interval_share_ppm", 300_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "max_zero_interval_share_ppm": max_share if max_share is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 1 or max_share is None:
        return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        if len(points) < min_points:
            continue
        analyzable += 1
        zero_count = sum(1 for point in points if point == 0)
        share = div_round_half_even(zero_count, len(points), PPM_SCALE)
        if share is None:
            return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if share > max_share:
            findings.append({"entity_id": item["entity_id"], "points_count": len(points),
                             "zero_intervals_count": zero_count, "zero_interval_share_ppm": share})
    if analyzable == 0:
        return compile_receipt("M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_SERIES",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["zero_interval_share_ppm"], item["entity_id"]))
    return compile_receipt(
        "M405", "traffic_zero_interval_share_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "TRAFFIC_ZERO_INTERVAL_SHARE_HIGH" if findings else "TRAFFIC_ZERO_INTERVAL_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "analyzed_series_count": analyzable,
         "invalid_records_count": invalid_count, "sparse_entities": findings},
    )


def run_m406(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Compare equal-length first/last halves of a traffic series without forecasting."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m406_min_points", 8), 366)
    min_shift = normalize_integer(config.get("m406_min_absolute_shift_ppm", 250_000), INT64_MAX)
    min_baseline = normalize_integer(config.get("m406_min_first_half_visits", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "min_absolute_shift_ppm": min_shift if min_shift is not None else "INVALID",
        "min_first_half_visits": min_baseline if min_baseline is not None else "INVALID",
        "odd_length_policy": "ignore_center_point",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 4 or min_shift is None or min_baseline is None:
        return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        if len(points) < min_points:
            continue
        width = len(points) // 2
        first = sum(points[:width])
        last = sum(points[-width:])
        if first < min_baseline or first == 0:
            continue
        analyzable += 1
        delta = last - first
        shift = div_round_half_even(abs(delta), first, PPM_SCALE)
        if shift is None:
            return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if shift >= min_shift:
            findings.append({"entity_id": item["entity_id"], "compared_points_per_half": width,
                             "first_half_visits": first, "last_half_visits": last,
                             "direction": "UP" if delta > 0 else "DOWN" if delta < 0 else "FLAT",
                             "absolute_shift_ppm": shift})
    if analyzable == 0:
        return compile_receipt("M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_TRAFFIC_HALF_WINDOW_BASELINE",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["absolute_shift_ppm"], item["entity_id"]))
    return compile_receipt(
        "M406", "traffic_half_window_shift_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "MATERIAL_TRAFFIC_HALF_WINDOW_SHIFT_FOUND" if findings else "TRAFFIC_HALF_WINDOW_SHIFT_WITHIN_POLICY",
        {"shift_scale": PPM_SCALE, "analyzed_series_count": analyzable,
         "invalid_records_count": invalid_count, "material_shifts": findings},
    )


def run_m505(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor the composed lead-to-sale conversion implied by supplied funnel rates."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_funnel_records(records)
    if raw_hash is None:
        return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_sessions = normalize_integer(config.get("m505_min_sessions", 100), 1_000_000_000_000)
    min_composed = normalize_integer(config.get("m505_min_composed_conversion_ppm", 5_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_sessions": min_sessions if min_sessions is not None else "INVALID",
        "min_composed_conversion_ppm": min_composed if min_composed is not None else "INVALID",
        "composition": "lead_conversion_ppm_x_close_rate_ppm_div_ppm_scale",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sessions is None or min_composed is None:
        return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_REVENUE_FUNNEL_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["sessions"] < min_sessions:
            continue
        analyzable += 1
        product = item["lead_conversion_ppm"] * item["close_rate_ppm"]
        composed = div_round_half_even(product, PPM_SCALE, 1)
        if composed is None:
            return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if composed < min_composed:
            findings.append({"source_id": item["source_id"], "sessions": item["sessions"],
                             "composed_conversion_ppm": composed, "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_FUNNEL_VOLUME",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["composed_conversion_ppm"], item["source_id"]))
    return compile_receipt(
        "M505", "composed_funnel_conversion_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "COMPOSED_FUNNEL_CONVERSION_BELOW_POLICY" if findings else "COMPOSED_FUNNEL_CONVERSION_WITHIN_POLICY",
        {"rate_scale": PPM_SCALE, "analyzed_sources_count": analyzable,
         "invalid_records_count": invalid_count, "below_policy_sources": findings},
    )


def _prepare_source_attribution(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"revenue_attribution_records": records})
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
        total = normalize_integer(row.get("total_revenue_micros"), INT64_MAX)
        attributed = normalize_integer(row.get("attributed_revenue_micros"), INT64_MAX)
        if not source_id or total is None or attributed is None or attributed > total:
            invalid_count += 1
            continue
        item = {"total_revenue_micros": total, "attributed_revenue_micros": attributed}
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)
    dataset = [{"source_id": source, **item} for source, item in sorted(registry.items())]
    return raw_hash, dataset, invalid_count, sorted(conflicts)


def run_m506(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect source-level attribution coverage below a configured observed-revenue threshold."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_source_attribution(records)
    if raw_hash is None:
        return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_total = normalize_integer(config.get("m506_min_source_revenue_micros", 1), INT64_MAX)
    min_coverage = normalize_integer(config.get("m506_min_source_attribution_coverage_ppm", 900_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_source_revenue_micros": min_total if min_total is not None else "INVALID",
        "min_source_attribution_coverage_ppm": min_coverage if min_coverage is not None else "INVALID",
        "currency_unit": "micros",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_total is None or min_coverage is None:
        return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_REVENUE_ATTRIBUTION_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        total = item["total_revenue_micros"]
        if total < min_total or total == 0:
            continue
        analyzable += 1
        coverage = div_round_half_even(item["attributed_revenue_micros"], total, PPM_SCALE)
        if coverage is None:
            return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if coverage < min_coverage:
            findings.append({
                "source_id": item["source_id"],
                "total_revenue_micros": total,
                "attributed_revenue_micros": item["attributed_revenue_micros"],
                "unattributed_revenue_micros": total - item["attributed_revenue_micros"],
                "attribution_coverage_ppm": coverage,
                "review_recommended": True,
            })
    if analyzable == 0:
        return compile_receipt("M506", "source_attribution_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SOURCE_REVENUE",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["attribution_coverage_ppm"], -item["unattributed_revenue_micros"], item["source_id"]))
    return compile_receipt(
        "M506", "source_attribution_gap_detector", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "SOURCE_ATTRIBUTION_GAP_FOUND" if findings else "SOURCE_ATTRIBUTION_COVERAGE_WITHIN_POLICY",
        {"coverage_scale": PPM_SCALE, "currency_unit": "micros",
         "analyzed_sources_count": analyzable, "invalid_records_count": invalid_count,
         "source_attribution_gaps": findings},
    )

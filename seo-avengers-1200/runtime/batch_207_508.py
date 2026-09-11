from __future__ import annotations

from typing import Any, Dict, List

from .batch_201_502 import _checked_mul
from .batch_203_504 import (
    _checked_add,
    _prepare_competitor_records,
    _prepare_search_records,
    _prepare_traffic_series,
)
from .batch_205_506 import _prepare_source_attribution
from .seo_avengers_1200 import (
    INT64_MAX,
    PPM_SCALE,
    canonical_hash,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
)


def run_m207(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure how concentrated observed search impressions are in the top N pages."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m207_top_page_count", 3), 1000)
    max_share = normalize_integer(config.get("m207_max_top_page_impression_share_ppm", 800_000), PPM_SCALE)
    min_total = normalize_integer(config.get("m207_min_total_impressions", 100), 100_000_000_000)
    cfg_hash = canonical_hash({
        "top_page_count": top_n if top_n is not None else "INVALID",
        "max_top_page_impression_share_ppm": max_share if max_share is not None else "INVALID",
        "min_total_impressions": min_total if min_total is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if top_n is None or top_n < 1 or max_share is None or min_total is None:
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    by_page: Dict[str, int] = {}
    total = 0
    for item in dataset:
        next_total = _checked_add(total, item["impressions"])
        prior = by_page.get(item["page_url"], 0)
        next_page = _checked_add(prior, item["impressions"])
        if next_total is None or next_page is None:
            return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        total = next_total
        by_page[item["page_url"]] = next_page

    if not by_page or total == 0 or total < min_total:
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"total_impressions": total, "invalid_records_count": invalid_count})

    ranked = sorted(
        ({"page_url": page, "impressions": impressions} for page, impressions in by_page.items()),
        key=lambda item: (-item["impressions"], item["page_url"]),
    )
    selected = ranked[:top_n]
    top_total = 0
    for item in selected:
        next_top = _checked_add(top_total, item["impressions"])
        if next_top is None:
            return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        top_total = next_top
    share = div_round_half_even(top_total, total, PPM_SCALE)
    if share is None:
        return compile_receipt("M207", "search_page_impression_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    return compile_receipt(
        "M207", "search_page_impression_concentration_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if high else "NO_FINDING",
        "SEARCH_PAGE_IMPRESSION_CONCENTRATION_HIGH" if high else "SEARCH_PAGE_IMPRESSION_CONCENTRATION_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "total_impressions": total,
         "distinct_pages_count": len(ranked), "top_page_impressions": top_total,
         "top_page_impression_share_ppm": share, "top_pages": selected,
         "invalid_records_count": invalid_count},
    )


def run_m208(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate explicit query/page observations to identify low-CTR landing pages."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    if raw_hash is None:
        return compile_receipt("M208", "search_page_ctr_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M208", "search_page_ctr_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_impressions = normalize_integer(config.get("m208_min_page_impressions", 100), 100_000_000_000)
    min_ctr = normalize_integer(config.get("m208_min_page_ctr_ppm", 20_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_page_impressions": min_impressions if min_impressions is not None else "INVALID",
        "min_page_ctr_ppm": min_ctr if min_ctr is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_observation_conflicts": conflicts})
    if min_impressions is None or min_ctr is None:
        return compile_receipt("M208", "search_page_ctr_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M208", "search_page_ctr_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
                               {"duplicate_observation_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    by_page: Dict[str, Dict[str, int]] = {}
    for item in dataset:
        current = by_page.setdefault(item["page_url"], {"clicks": 0, "impressions": 0})
        next_clicks = _checked_add(current["clicks"], item["clicks"])
        next_impressions = _checked_add(current["impressions"], item["impressions"])
        if next_clicks is None or next_impressions is None:
            return compile_receipt("M208", "search_page_ctr_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        current["clicks"] = next_clicks
        current["impressions"] = next_impressions

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for page in sorted(by_page):
        item = by_page[page]
        if item["impressions"] < min_impressions or item["impressions"] == 0:
            continue
        analyzable += 1
        ctr = div_round_half_even(item["clicks"], item["impressions"], PPM_SCALE)
        if ctr is None:
            return compile_receipt("M208", "search_page_ctr_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        if ctr < min_ctr:
            findings.append({"page_url": page, "clicks": item["clicks"],
                             "impressions": item["impressions"], "ctr_ppm": ctr,
                             "review_recommended": True})

    if analyzable == 0:
        return compile_receipt("M208", "search_page_ctr_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_PAGE_SEARCH_IMPRESSIONS",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["ctr_ppm"], -item["impressions"], item["page_url"]))
    return compile_receipt(
        "M208", "search_page_ctr_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if findings else "NO_FINDING",
        "LOW_PAGE_LEVEL_SEARCH_CTR_FOUND" if findings else "PAGE_LEVEL_SEARCH_CTR_WITHIN_POLICY",
        {"ctr_scale": PPM_SCALE, "analyzed_pages_count": analyzable,
         "invalid_records_count": invalid_count, "low_ctr_pages": findings},
    )


def run_m307(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure competitor-covered search volume where the site is absent."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_volume = normalize_integer(config.get("m307_min_competitor_covered_search_volume", 100), 100_000_000_000)
    max_gap_share = normalize_integer(config.get("m307_max_gap_volume_share_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_competitor_covered_search_volume": min_volume if min_volume is not None else "INVALID",
        "max_gap_volume_share_ppm": max_gap_share if max_gap_share is not None else "INVALID",
        "denominator": "search_volume_where_competitor_ranked_count_gt_zero",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_volume is None or max_gap_share is None:
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    competitor_volume = 0
    gap_volume = 0
    gap_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        if item["competitor_ranked_count"] <= 0:
            continue
        next_competitor = _checked_add(competitor_volume, item["search_volume"])
        if next_competitor is None:
            return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        competitor_volume = next_competitor
        if not item["site_ranked"]:
            next_gap = _checked_add(gap_volume, item["search_volume"])
            if next_gap is None:
                return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                                       raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                       "ARITHMETIC_RANGE_EXCEEDED", {})
            gap_volume = next_gap
            if item["search_volume"] > 0:
                gap_keywords.append({"keyword": item["keyword"],
                                     "search_volume": item["search_volume"],
                                     "competitor_ranked_count": item["competitor_ranked_count"]})

    if competitor_volume == 0 or competitor_volume < min_volume:
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_COMPETITOR_COVERED_VOLUME",
                               {"competitor_covered_search_volume": competitor_volume,
                                "invalid_records_count": invalid_count})
    share = div_round_half_even(gap_volume, competitor_volume, PPM_SCALE)
    if share is None:
        return compile_receipt("M307", "competitive_gap_volume_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_gap_share
    gap_keywords.sort(key=lambda item: (-item["search_volume"], -item["competitor_ranked_count"], item["keyword"]))
    return compile_receipt(
        "M307", "competitive_gap_volume_share_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_VOLUME_SHARE_HIGH" if high else "COMPETITIVE_GAP_VOLUME_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "competitor_covered_search_volume": competitor_volume,
         "site_absent_search_volume": gap_volume, "gap_volume_share_ppm": share,
         "gap_keywords": gap_keywords, "invalid_records_count": invalid_count},
    )


def run_m308(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Compute search-volume-weighted tracked competitor intensity without inferring rank quality."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    if raw_hash is None:
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_volume = normalize_integer(config.get("m308_min_tracked_search_volume", 100), 100_000_000_000)
    max_intensity_milli = normalize_integer(config.get("m308_max_weighted_competitor_count_milli", 3_000), 100_000_000)
    cfg_hash = canonical_hash({
        "min_tracked_search_volume": min_volume if min_volume is not None else "INVALID",
        "max_weighted_competitor_count_milli": max_intensity_milli if max_intensity_milli is not None else "INVALID",
        "intensity_scale": 1000,
        "weight": "search_volume",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_keyword_conflicts": conflicts})
    if min_volume is None or max_intensity_milli is None:
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
                               {"duplicate_keyword_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    total_volume = 0
    weighted_units = 0
    for item in dataset:
        if item["search_volume"] == 0:
            continue
        next_volume = _checked_add(total_volume, item["search_volume"])
        product = _checked_mul(item["search_volume"], item["competitor_ranked_count"])
        if next_volume is None or product is None:
            return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        next_weighted = _checked_add(weighted_units, product)
        if next_weighted is None:
            return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        total_volume = next_volume
        weighted_units = next_weighted

    if total_volume == 0 or total_volume < min_volume:
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_COMPETITIVE_KEYWORD_VOLUME",
                               {"tracked_search_volume": total_volume, "invalid_records_count": invalid_count})
    intensity_milli = div_round_half_even(weighted_units, total_volume, 1000)
    if intensity_milli is None:
        return compile_receipt("M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = intensity_milli > max_intensity_milli
    return compile_receipt(
        "M308", "volume_weighted_competitor_intensity_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if high else "NO_FINDING",
        "WEIGHTED_COMPETITOR_INTENSITY_HIGH" if high else "WEIGHTED_COMPETITOR_INTENSITY_WITHIN_POLICY",
        {"intensity_scale": 1000, "tracked_search_volume": total_volume,
         "weighted_competitor_count_milli": intensity_milli,
         "invalid_records_count": invalid_count},
    )


def run_m407(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect sustained consecutive zero-visit runs in explicit traffic series."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M407", "traffic_zero_run_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M407", "traffic_zero_run_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m407_min_points", 7), 366)
    min_zero_run = normalize_integer(config.get("m407_min_consecutive_zero_intervals", 3), 366)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "min_consecutive_zero_intervals": min_zero_run if min_zero_run is not None else "INVALID",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 1 or min_zero_run is None or min_zero_run < 1:
        return compile_receipt("M407", "traffic_zero_run_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M407", "traffic_zero_run_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        if len(points) < min_points:
            continue
        analyzable += 1
        longest = 0
        current = 0
        for point in points:
            if point == 0:
                current += 1
                longest = max(longest, current)
            else:
                current = 0
        if longest >= min_zero_run:
            findings.append({"entity_id": item["entity_id"], "points_count": len(points),
                             "longest_consecutive_zero_intervals": longest,
                             "review_recommended": True})

    if analyzable == 0:
        return compile_receipt("M407", "traffic_zero_run_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_TRAFFIC_SERIES",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["longest_consecutive_zero_intervals"], item["entity_id"]))
    return compile_receipt(
        "M407", "traffic_zero_run_detector", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if findings else "NO_FINDING",
        "SUSTAINED_ZERO_TRAFFIC_RUN_FOUND" if findings else "ZERO_TRAFFIC_RUN_WITHIN_POLICY",
        {"analyzed_series_count": analyzable, "invalid_records_count": invalid_count,
         "zero_run_entities": findings},
    )


def run_m408(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure maximum observed peak-to-later-trough drawdown in bounded traffic series."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_traffic_series(records)
    if raw_hash is None:
        return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_points = normalize_integer(config.get("m408_min_points", 7), 366)
    min_peak = normalize_integer(config.get("m408_min_peak_visits", 50), 1_000_000)
    min_drawdown = normalize_integer(config.get("m408_min_drawdown_ppm", 300_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_points": min_points if min_points is not None else "INVALID",
        "min_peak_visits": min_peak if min_peak is not None else "INVALID",
        "min_drawdown_ppm": min_drawdown if min_drawdown is not None else "INVALID",
        "metric": "max_peak_to_later_trough_drawdown",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_entity_conflicts": conflicts})
    if min_points is None or min_points < 2 or min_peak is None or min_drawdown is None:
        return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_TRAFFIC_SERIES_CONFLICT",
                               {"duplicate_entity_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        points = item["visits_series"]
        if len(points) < min_points:
            continue
        running_peak = points[0]
        best_ppm = 0
        best_peak = running_peak
        best_trough = running_peak
        eligible = False
        for point in points[1:]:
            if running_peak >= min_peak and running_peak > 0:
                eligible = True
                drop = running_peak - point if point < running_peak else 0
                drawdown = div_round_half_even(drop, running_peak, PPM_SCALE)
                if drawdown is None:
                    return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1,
                                           raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                           "ARITHMETIC_RANGE_EXCEEDED", {})
                if drawdown > best_ppm:
                    best_ppm = drawdown
                    best_peak = running_peak
                    best_trough = point
            if point > running_peak:
                running_peak = point
        if not eligible:
            continue
        analyzable += 1
        if best_ppm >= min_drawdown:
            findings.append({"entity_id": item["entity_id"], "peak_visits": best_peak,
                             "later_trough_visits": best_trough,
                             "max_drawdown_ppm": best_ppm,
                             "review_recommended": True})

    if analyzable == 0:
        return compile_receipt("M408", "traffic_drawdown_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_TRAFFIC_PEAK_BASELINE",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["max_drawdown_ppm"], item["entity_id"]))
    return compile_receipt(
        "M408", "traffic_drawdown_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if findings else "NO_FINDING",
        "MATERIAL_TRAFFIC_DRAWDOWN_FOUND" if findings else "TRAFFIC_DRAWDOWN_WITHIN_POLICY",
        {"drawdown_scale": PPM_SCALE, "analyzed_series_count": analyzable,
         "invalid_records_count": invalid_count, "material_drawdowns": findings},
    )


def run_m507(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure concentration of unattributed observed revenue across sources."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_source_attribution(records)
    if raw_hash is None:
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    top_n = normalize_integer(config.get("m507_top_source_count", 1), 1000)
    max_share = normalize_integer(config.get("m507_max_top_unattributed_share_ppm", 700_000), PPM_SCALE)
    min_total = normalize_integer(config.get("m507_min_total_unattributed_revenue_micros", 1), INT64_MAX)
    cfg_hash = canonical_hash({
        "top_source_count": top_n if top_n is not None else "INVALID",
        "max_top_unattributed_share_ppm": max_share if max_share is not None else "INVALID",
        "min_total_unattributed_revenue_micros": min_total if min_total is not None else "INVALID",
        "currency_unit": "micros",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if top_n is None or top_n < 1 or max_share is None or min_total is None:
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_REVENUE_ATTRIBUTION_CONFLICT",
                               {"duplicate_source_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    rows: List[Dict[str, Any]] = []
    total_unattributed = 0
    for item in dataset:
        unattributed = item["total_revenue_micros"] - item["attributed_revenue_micros"]
        next_total = _checked_add(total_unattributed, unattributed)
        if next_total is None:
            return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        total_unattributed = next_total
        if unattributed > 0:
            rows.append({"source_id": item["source_id"],
                         "unattributed_revenue_micros": unattributed})

    if total_unattributed == 0 or total_unattributed < min_total:
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_UNATTRIBUTED_REVENUE_SAMPLE",
                               {"total_unattributed_revenue_micros": total_unattributed,
                                "invalid_records_count": invalid_count})
    rows.sort(key=lambda item: (-item["unattributed_revenue_micros"], item["source_id"]))
    selected = rows[:top_n]
    top_total = 0
    for item in selected:
        next_top = _checked_add(top_total, item["unattributed_revenue_micros"])
        if next_top is None:
            return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        top_total = next_top
    share = div_round_half_even(top_total, total_unattributed, PPM_SCALE)
    if share is None:
        return compile_receipt("M507", "unattributed_revenue_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    return compile_receipt(
        "M507", "unattributed_revenue_concentration_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if high else "NO_FINDING",
        "UNATTRIBUTED_REVENUE_CONCENTRATION_HIGH" if high else "UNATTRIBUTED_REVENUE_CONCENTRATION_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "currency_unit": "micros",
         "total_unattributed_revenue_micros": total_unattributed,
         "top_unattributed_revenue_micros": top_total,
         "top_unattributed_share_ppm": share, "top_sources": selected,
         "invalid_records_count": invalid_count},
    )


def run_m508(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure breadth of sources with any attributed revenue among material revenue sources."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_source_attribution(records)
    if raw_hash is None:
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_sources = normalize_integer(config.get("m508_min_material_sources", 2), 100_000)
    min_source_revenue = normalize_integer(config.get("m508_min_source_revenue_micros", 1), INT64_MAX)
    min_breadth = normalize_integer(config.get("m508_min_attributed_source_share_ppm", 800_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_material_sources": min_sources if min_sources is not None else "INVALID",
        "min_source_revenue_micros": min_source_revenue if min_source_revenue is not None else "INVALID",
        "min_attributed_source_share_ppm": min_breadth if min_breadth is not None else "INVALID",
        "attributed_definition": "attributed_revenue_micros_gt_zero",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sources is None or min_sources < 1 or min_source_revenue is None or min_breadth is None:
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_REVENUE_ATTRIBUTION_CONFLICT",
                               {"duplicate_source_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    material = [item for item in dataset if item["total_revenue_micros"] >= min_source_revenue]
    if len(material) < min_sources:
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_MATERIAL_REVENUE_SOURCES",
                               {"material_sources_count": len(material),
                                "invalid_records_count": invalid_count})
    attributed_count = sum(1 for item in material if item["attributed_revenue_micros"] > 0)
    share = div_round_half_even(attributed_count, len(material), PPM_SCALE)
    if share is None:
        return compile_receipt("M508", "revenue_source_attribution_breadth_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_breadth
    unattributed_sources = sorted(
        item["source_id"] for item in material if item["attributed_revenue_micros"] == 0
    )
    return compile_receipt(
        "M508", "revenue_source_attribution_breadth_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if low else "NO_FINDING",
        "REVENUE_SOURCE_ATTRIBUTION_BREADTH_LOW" if low else "REVENUE_SOURCE_ATTRIBUTION_BREADTH_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "material_sources_count": len(material),
         "attributed_sources_count": attributed_count,
         "attributed_source_share_ppm": share,
         "fully_unattributed_sources": unattributed_sources,
         "invalid_records_count": invalid_count},
    )

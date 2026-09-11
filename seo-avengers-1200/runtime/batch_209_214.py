from __future__ import annotations

from typing import Any, Dict, List, Set

from .batch_201_502 import _checked_mul
from .batch_203_504 import _checked_add, _prepare_search_records
from .seo_avengers_1200 import (
    PPM_SCALE,
    canonical_hash,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
)


def _search_norm_hash(dataset: List[Dict[str, Any]], invalid_count: int, conflicts: List[Dict[str, str]]) -> str:
    return canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_observation_conflicts": conflicts,
    })


def _search_input_error(module: str, algorithm: str, records: Any, raw_hash: Any) -> Dict[str, Any] | None:
    if raw_hash is None:
        return compile_receipt(module, algorithm, 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt(module, algorithm, 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    return None


def _conflict_receipt(module: str, algorithm: str, raw_hash: str, norm_hash: str,
                      cfg_hash: str, conflicts: List[Dict[str, str]], invalid_count: int) -> Dict[str, Any] | None:
    if not conflicts:
        return None
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "ERROR", "FINDING", "DUPLICATE_SEARCH_OBSERVATION_CONFLICT",
        {"duplicate_observation_conflicts": conflicts, "invalid_records_count": invalid_count},
    )


def run_m209(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure impression-weighted average observed search position from explicit records."""
    module = "M209"
    algorithm = "search_impression_weighted_position_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_impressions = normalize_integer(config.get("m209_min_total_impressions", 100), 100_000_000_000)
    max_position = normalize_integer(config.get("m209_max_weighted_average_position_milli", 20_000), 1_000_000)
    cfg_hash = canonical_hash({
        "min_total_impressions": min_impressions if min_impressions is not None else "INVALID",
        "max_weighted_average_position_milli": max_position if max_position is not None else "INVALID",
        "metric": "sum(average_position_milli*impressions)/sum(impressions)",
        "position_scale": 1000,
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_impressions is None or max_position is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    total_impressions = 0
    weighted_position_sum = 0
    for item in dataset:
        weighted = _checked_mul(item["average_position_milli"], item["impressions"])
        next_total = _checked_add(total_impressions, item["impressions"])
        next_weighted = None if weighted is None else _checked_add(weighted_position_sum, weighted)
        if next_total is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_impressions = next_total
        weighted_position_sum = next_weighted

    if total_impressions == 0 or total_impressions < min_impressions:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"total_impressions": total_impressions, "invalid_records_count": invalid_count})
    weighted_position = div_round_half_even(weighted_position_sum, total_impressions, 1)
    if weighted_position is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = weighted_position > max_position
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "IMPRESSION_WEIGHTED_SEARCH_POSITION_HIGH" if high else "IMPRESSION_WEIGHTED_SEARCH_POSITION_WITHIN_POLICY",
        {"position_scale": 1000, "total_impressions": total_impressions,
         "weighted_average_position_milli": weighted_position,
         "invalid_records_count": invalid_count},
    )


def run_m210(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure click-weighted average observed search position from explicit records."""
    module = "M210"
    algorithm = "search_click_weighted_position_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_clicks = normalize_integer(config.get("m210_min_total_clicks", 10), 100_000_000_000)
    max_position = normalize_integer(config.get("m210_max_weighted_average_position_milli", 20_000), 1_000_000)
    cfg_hash = canonical_hash({
        "min_total_clicks": min_clicks if min_clicks is not None else "INVALID",
        "max_weighted_average_position_milli": max_position if max_position is not None else "INVALID",
        "metric": "sum(average_position_milli*clicks)/sum(clicks)",
        "position_scale": 1000,
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_clicks is None or max_position is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    total_clicks = 0
    weighted_position_sum = 0
    for item in dataset:
        weighted = _checked_mul(item["average_position_milli"], item["clicks"])
        next_total = _checked_add(total_clicks, item["clicks"])
        next_weighted = None if weighted is None else _checked_add(weighted_position_sum, weighted)
        if next_total is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_clicks = next_total
        weighted_position_sum = next_weighted

    if total_clicks == 0 or total_clicks < min_clicks:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_CLICKS",
                               {"total_clicks": total_clicks, "invalid_records_count": invalid_count})
    weighted_position = div_round_half_even(weighted_position_sum, total_clicks, 1)
    if weighted_position is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = weighted_position > max_position
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "CLICK_WEIGHTED_SEARCH_POSITION_HIGH" if high else "CLICK_WEIGHTED_SEARCH_POSITION_WITHIN_POLICY",
        {"position_scale": 1000, "total_clicks": total_clicks,
         "weighted_average_position_milli": weighted_position,
         "invalid_records_count": invalid_count},
    )


def run_m211(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor distinct exposed-query breadth for materially exposed landing pages."""
    module = "M211"
    algorithm = "search_page_query_breadth_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_page_impressions = normalize_integer(config.get("m211_min_page_impressions", 100), 100_000_000_000)
    min_queries = normalize_integer(config.get("m211_min_distinct_queries", 3), 100_000)
    cfg_hash = canonical_hash({
        "min_page_impressions": min_page_impressions if min_page_impressions is not None else "INVALID",
        "min_distinct_queries": min_queries if min_queries is not None else "INVALID",
        "query_presence": "query_page_record_with_positive_impressions",
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_page_impressions is None or min_queries is None or min_queries < 1:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    page_impressions: Dict[str, int] = {}
    page_queries: Dict[str, Set[str]] = {}
    for item in dataset:
        prior = page_impressions.get(item["page_url"], 0)
        next_total = _checked_add(prior, item["impressions"])
        if next_total is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        page_impressions[item["page_url"]] = next_total
        if item["impressions"] > 0:
            page_queries.setdefault(item["page_url"], set()).add(item["query"])

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for page in sorted(page_impressions):
        impressions = page_impressions[page]
        if impressions < min_page_impressions:
            continue
        analyzable += 1
        queries = sorted(page_queries.get(page, set()))
        if len(queries) < min_queries:
            findings.append({"page_url": page, "impressions": impressions,
                             "distinct_query_count": len(queries), "queries": queries,
                             "review_recommended": True})
    if analyzable == 0:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_PAGE_SEARCH_IMPRESSIONS",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["distinct_query_count"], -item["impressions"], item["page_url"]))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "SEARCH_PAGE_QUERY_BREADTH_LOW" if findings else "SEARCH_PAGE_QUERY_BREADTH_WITHIN_POLICY",
        {"analyzed_pages_count": analyzable, "invalid_records_count": invalid_count,
         "low_breadth_pages": findings},
    )


def run_m212(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure page-level impression share coming from zero-click query/page observations."""
    module = "M212"
    algorithm = "search_page_zero_click_exposure_share_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_page_impressions = normalize_integer(config.get("m212_min_page_impressions", 100), 100_000_000_000)
    max_share = normalize_integer(config.get("m212_max_zero_click_impression_share_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_page_impressions": min_page_impressions if min_page_impressions is not None else "INVALID",
        "max_zero_click_impression_share_ppm": max_share if max_share is not None else "INVALID",
        "numerator": "impressions_from_records_with_zero_clicks",
        "denominator": "all_page_impressions",
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_page_impressions is None or max_share is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    by_page: Dict[str, Dict[str, int]] = {}
    for item in dataset:
        current = by_page.setdefault(item["page_url"], {"impressions": 0, "zero_click_impressions": 0})
        next_impressions = _checked_add(current["impressions"], item["impressions"])
        if next_impressions is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        current["impressions"] = next_impressions
        if item["clicks"] == 0:
            next_zero = _checked_add(current["zero_click_impressions"], item["impressions"])
            if next_zero is None:
                return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            current["zero_click_impressions"] = next_zero

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for page in sorted(by_page):
        item = by_page[page]
        if item["impressions"] == 0 or item["impressions"] < min_page_impressions:
            continue
        analyzable += 1
        share = div_round_half_even(item["zero_click_impressions"], item["impressions"], PPM_SCALE)
        if share is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if share > max_share:
            findings.append({"page_url": page, "impressions": item["impressions"],
                             "zero_click_impressions": item["zero_click_impressions"],
                             "zero_click_impression_share_ppm": share,
                             "review_recommended": True})
    if analyzable == 0:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_PAGE_SEARCH_IMPRESSIONS",
                               {"valid_records_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["zero_click_impression_share_ppm"], -item["impressions"], item["page_url"]))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "PAGE_ZERO_CLICK_EXPOSURE_SHARE_HIGH" if findings else "PAGE_ZERO_CLICK_EXPOSURE_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "analyzed_pages_count": analyzable,
         "invalid_records_count": invalid_count, "high_zero_click_pages": findings},
    )


def run_m213(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure impression-weighted mean absolute deviation of observed average positions."""
    module = "M213"
    algorithm = "search_position_dispersion_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_impressions = normalize_integer(config.get("m213_min_total_impressions", 100), 100_000_000_000)
    max_mad = normalize_integer(config.get("m213_max_weighted_position_mad_milli", 10_000), 1_000_000)
    cfg_hash = canonical_hash({
        "min_total_impressions": min_impressions if min_impressions is not None else "INVALID",
        "max_weighted_position_mad_milli": max_mad if max_mad is not None else "INVALID",
        "center": "impression_weighted_average_position_milli_round_half_even",
        "metric": "sum(abs(position-center)*impressions)/sum(impressions)",
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_impressions is None or max_mad is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    total_impressions = 0
    weighted_position_sum = 0
    for item in dataset:
        weighted = _checked_mul(item["average_position_milli"], item["impressions"])
        next_total = _checked_add(total_impressions, item["impressions"])
        next_weighted = None if weighted is None else _checked_add(weighted_position_sum, weighted)
        if next_total is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_impressions = next_total
        weighted_position_sum = next_weighted
    if total_impressions == 0 or total_impressions < min_impressions:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_SEARCH_IMPRESSIONS",
                               {"total_impressions": total_impressions, "invalid_records_count": invalid_count})
    center = div_round_half_even(weighted_position_sum, total_impressions, 1)
    if center is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})

    weighted_deviation_sum = 0
    for item in dataset:
        weighted_deviation = _checked_mul(abs(item["average_position_milli"] - center), item["impressions"])
        next_sum = None if weighted_deviation is None else _checked_add(weighted_deviation_sum, weighted_deviation)
        if next_sum is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        weighted_deviation_sum = next_sum
    mad = div_round_half_even(weighted_deviation_sum, total_impressions, 1)
    if mad is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = mad > max_mad
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "SEARCH_POSITION_DISPERSION_HIGH" if high else "SEARCH_POSITION_DISPERSION_WITHIN_POLICY",
        {"position_scale": 1000, "total_impressions": total_impressions,
         "weighted_average_position_milli": center, "weighted_position_mad_milli": mad,
         "invalid_records_count": invalid_count},
    )


def run_m214(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure equal-query dispersion of aggregate CTR across sufficiently exposed queries."""
    module = "M214"
    algorithm = "search_query_ctr_dispersion_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_search_records(records)
    early = _search_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_query_impressions = normalize_integer(config.get("m214_min_query_impressions", 50), 100_000_000_000)
    min_queries = normalize_integer(config.get("m214_min_queries", 3), 100_000)
    max_mad = normalize_integer(config.get("m214_max_query_ctr_mad_ppm", 150_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_query_impressions": min_query_impressions if min_query_impressions is not None else "INVALID",
        "min_queries": min_queries if min_queries is not None else "INVALID",
        "max_query_ctr_mad_ppm": max_mad if max_mad is not None else "INVALID",
        "query_weighting": "equal_weight_after_minimum_impression_filter",
        "ctr_scale": PPM_SCALE,
    })
    norm_hash = _search_norm_hash(dataset, invalid_count, conflicts)
    if min_query_impressions is None or min_queries is None or min_queries < 2 or max_mad is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    conflict = _conflict_receipt(module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count)
    if conflict is not None:
        return conflict

    by_query: Dict[str, Dict[str, int]] = {}
    for item in dataset:
        current = by_query.setdefault(item["query"], {"clicks": 0, "impressions": 0})
        next_clicks = _checked_add(current["clicks"], item["clicks"])
        next_impressions = _checked_add(current["impressions"], item["impressions"])
        if next_clicks is None or next_impressions is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        current["clicks"] = next_clicks
        current["impressions"] = next_impressions

    query_ctrs: List[Dict[str, Any]] = []
    total_ctr_ppm = 0
    for query in sorted(by_query):
        item = by_query[query]
        if item["impressions"] == 0 or item["impressions"] < min_query_impressions:
            continue
        ctr = div_round_half_even(item["clicks"], item["impressions"], PPM_SCALE)
        if ctr is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        next_total = _checked_add(total_ctr_ppm, ctr)
        if next_total is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_ctr_ppm = next_total
        query_ctrs.append({"query": query, "clicks": item["clicks"],
                           "impressions": item["impressions"], "ctr_ppm": ctr})

    if len(query_ctrs) < min_queries:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_QUERY_CTR_SAMPLE",
                               {"analyzable_queries_count": len(query_ctrs), "invalid_records_count": invalid_count})
    mean_ctr = div_round_half_even(total_ctr_ppm, len(query_ctrs), 1)
    if mean_ctr is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    total_abs_deviation = 0
    for item in query_ctrs:
        next_dev = _checked_add(total_abs_deviation, abs(item["ctr_ppm"] - mean_ctr))
        if next_dev is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        total_abs_deviation = next_dev
    mad = div_round_half_even(total_abs_deviation, len(query_ctrs), 1)
    if mad is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = mad > max_mad
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "SEARCH_QUERY_CTR_DISPERSION_HIGH" if high else "SEARCH_QUERY_CTR_DISPERSION_WITHIN_POLICY",
        {"ctr_scale": PPM_SCALE, "analyzed_queries_count": len(query_ctrs),
         "mean_query_ctr_ppm": mean_ctr, "query_ctr_mad_ppm": mad,
         "query_ctrs": query_ctrs, "invalid_records_count": invalid_count},
    )

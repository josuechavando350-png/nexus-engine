from __future__ import annotations

from typing import Any, Dict, List

from .batch_203_504 import _checked_add, _prepare_competitor_records
from .batch_309_314 import (
    _competitive_data_quality_receipt,
    _competitive_input_error,
    _competitive_norm_hash,
)
from .seo_avengers_1200 import canonical_hash, compile_receipt, normalize_integer


def run_m315(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure the search-volume-weighted upper-quartile competitor pressure across observed site-absent gaps."""
    module = "M315"
    algorithm = "competitive_gap_weighted_upper_quartile_pressure_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m315_min_gap_search_volume", 100), 100_000_000_000)
    max_upper_quartile_count = normalize_integer(
        config.get("m315_max_weighted_upper_quartile_gap_competitor_count", 4), 100_000
    )
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "max_weighted_upper_quartile_gap_competitor_count": (
            max_upper_quartile_count if max_upper_quartile_count is not None else "INVALID"
        ),
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "weight": "search_volume",
        "statistic": "lower_threshold_crossing_weighted_upper_quartile_competitor_count",
        "quantile_numerator": 3,
        "quantile_denominator": 4,
        "quantile_target": "ceil(3*total_gap_search_volume/4)",
        "target_implementation": "total_gap_search_volume-floor(total_gap_search_volume/4)",
        "ordering": "competitor_ranked_count_then_keyword_ascending",
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if min_gap_volume is None or min_gap_volume < 1 or max_upper_quartile_count is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    gap_rows: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_gap = _checked_add(gap_volume, item["search_volume"])
        if next_gap is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_gap
        gap_rows.append(item)

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )

    # ceil(3*n/4) == n - floor(n/4), avoiding overflow-prone 3*n.
    upper_quartile_target = gap_volume - gap_volume // 4
    ordered = sorted(gap_rows, key=lambda item: (item["competitor_ranked_count"], item["keyword"]))
    cumulative_volume = 0
    support_row: Dict[str, Any] | None = None
    for item in ordered:
        next_cumulative = _checked_add(cumulative_volume, item["search_volume"])
        if next_cumulative is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        cumulative_volume = next_cumulative
        if cumulative_volume >= upper_quartile_target:
            support_row = item
            break

    if support_row is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "WEIGHTED_UPPER_QUARTILE_UNRESOLVED", {})

    upper_quartile_count = support_row["competitor_ranked_count"]
    high = upper_quartile_count > max_upper_quartile_count
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_WEIGHTED_UPPER_QUARTILE_PRESSURE_HIGH" if high
        else "COMPETITIVE_GAP_WEIGHTED_UPPER_QUARTILE_PRESSURE_WITHIN_POLICY",
        {"gap_search_volume": gap_volume,
         "gap_keyword_count": len(gap_rows),
         "weighted_upper_quartile_target_search_volume": upper_quartile_target,
         "weighted_upper_quartile_gap_competitor_count": upper_quartile_count,
         "weighted_upper_quartile_support_keyword": support_row["keyword"],
         "weighted_upper_quartile_support_search_volume": support_row["search_volume"],
         "invalid_records_count": invalid_count},
    )


def run_m316(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure robust search-volume-weighted competitor-pressure spread using the interquartile range."""
    module = "M316"
    algorithm = "competitive_gap_weighted_interquartile_pressure_spread_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m316_min_gap_search_volume", 100), 100_000_000_000)
    max_iqr_count = normalize_integer(
        config.get("m316_max_weighted_iqr_gap_competitor_count", 2), 100_000
    )
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "max_weighted_iqr_gap_competitor_count": max_iqr_count if max_iqr_count is not None else "INVALID",
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "weight": "search_volume",
        "statistic": "weighted_interquartile_range_of_competitor_ranked_count",
        "q1_target": "ceil(total_gap_search_volume/4)",
        "q1_target_implementation": "floor(total_gap_search_volume/4)+indicator(remainder_gt_zero)",
        "q3_target": "ceil(3*total_gap_search_volume/4)",
        "q3_target_implementation": "total_gap_search_volume-floor(total_gap_search_volume/4)",
        "quantile_selection": "first_cumulative_weight_at_or_above_target",
        "ordering": "competitor_ranked_count_then_keyword_ascending",
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if min_gap_volume is None or min_gap_volume < 1 or max_iqr_count is None or max_iqr_count < 0:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    gap_rows: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_gap = _checked_add(gap_volume, item["search_volume"])
        if next_gap is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_gap
        gap_rows.append(item)

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )

    q1_target = gap_volume // 4 + (1 if gap_volume % 4 else 0)
    q3_target = gap_volume - gap_volume // 4
    ordered = sorted(gap_rows, key=lambda item: (item["competitor_ranked_count"], item["keyword"]))
    cumulative_volume = 0
    q1_row: Dict[str, Any] | None = None
    q3_row: Dict[str, Any] | None = None
    for item in ordered:
        next_cumulative = _checked_add(cumulative_volume, item["search_volume"])
        if next_cumulative is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        cumulative_volume = next_cumulative
        if q1_row is None and cumulative_volume >= q1_target:
            q1_row = item
        if cumulative_volume >= q3_target:
            q3_row = item
            break

    if q1_row is None or q3_row is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "WEIGHTED_INTERQUARTILE_RANGE_UNRESOLVED", {})

    q1_count = q1_row["competitor_ranked_count"]
    q3_count = q3_row["competitor_ranked_count"]
    iqr_count = q3_count - q1_count
    if iqr_count < 0:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "WEIGHTED_INTERQUARTILE_RANGE_INVALID", {})

    high = iqr_count > max_iqr_count
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_WEIGHTED_IQR_PRESSURE_SPREAD_HIGH" if high
        else "COMPETITIVE_GAP_WEIGHTED_IQR_PRESSURE_SPREAD_WITHIN_POLICY",
        {"gap_search_volume": gap_volume,
         "gap_keyword_count": len(gap_rows),
         "weighted_q1_target_search_volume": q1_target,
         "weighted_q3_target_search_volume": q3_target,
         "weighted_q1_gap_competitor_count": q1_count,
         "weighted_q3_gap_competitor_count": q3_count,
         "weighted_iqr_gap_competitor_count": iqr_count,
         "weighted_q1_support_keyword": q1_row["keyword"],
         "weighted_q3_support_keyword": q3_row["keyword"],
         "invalid_records_count": invalid_count},
    )

from __future__ import annotations

from typing import Any, Dict, List

from .batch_201_502 import _checked_mul
from .batch_203_504 import _checked_add, _prepare_competitor_records
from .seo_avengers_1200 import PPM_SCALE, canonical_hash, compile_receipt, div_round_half_even, normalize_integer


def _competitive_norm_hash(dataset: List[Dict[str, Any]], invalid_count: int,
                           conflicts: List[str]) -> str:
    return canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_keyword_conflicts": conflicts,
    })


def _competitive_input_error(module: str, algorithm: str, records: Any,
                             raw_hash: Any) -> Dict[str, Any] | None:
    if raw_hash is None:
        return compile_receipt(module, algorithm, 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt(module, algorithm, 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    return None


def _competitive_data_quality_receipt(module: str, algorithm: str, raw_hash: str,
                                      norm_hash: str, cfg_hash: str,
                                      conflicts: List[str], invalid_count: int) -> Dict[str, Any] | None:
    if conflicts:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "FINDING", "DUPLICATE_KEYWORD_COVERAGE_CONFLICT",
            {"duplicate_keyword_conflicts": conflicts, "invalid_records_count": invalid_count},
        )
    if invalid_count:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_KEYWORD_COVERAGE_RECORDS",
            {"invalid_records_count": invalid_count},
        )
    return None


def run_m309(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure search-volume-weighted competitor pressure only on observed site-absent gaps."""
    module = "M309"
    algorithm = "competitive_gap_weighted_pressure_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m309_min_gap_search_volume", 100), 100_000_000_000)
    max_pressure_milli = normalize_integer(
        config.get("m309_max_weighted_gap_competitor_count_milli", 3_000), 100_000_000
    )
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "max_weighted_gap_competitor_count_milli": (
            max_pressure_milli if max_pressure_milli is not None else "INVALID"
        ),
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "weight": "search_volume",
        "pressure_scale": 1000,
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if min_gap_volume is None or min_gap_volume < 1 or max_pressure_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    weighted_competitor_units = 0
    gap_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_volume = _checked_add(gap_volume, item["search_volume"])
        weighted = _checked_mul(item["search_volume"], item["competitor_ranked_count"])
        next_weighted = None if weighted is None else _checked_add(weighted_competitor_units, weighted)
        if next_volume is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_volume
        weighted_competitor_units = next_weighted
        gap_keywords.append({
            "keyword": item["keyword"],
            "search_volume": item["search_volume"],
            "competitor_ranked_count": item["competitor_ranked_count"],
        })

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )

    pressure_milli = div_round_half_even(weighted_competitor_units, gap_volume, 1000)
    if pressure_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = pressure_milli > max_pressure_milli
    gap_keywords.sort(key=lambda item: (
        -item["competitor_ranked_count"], -item["search_volume"], item["keyword"]
    ))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_PRESSURE_HIGH" if high else "COMPETITIVE_GAP_PRESSURE_WITHIN_POLICY",
        {"pressure_scale": 1000, "gap_search_volume": gap_volume,
         "weighted_gap_competitor_count_milli": pressure_milli,
         "gap_keywords": gap_keywords, "invalid_records_count": invalid_count},
    )


def run_m310(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure gap search-volume share exposed to a configured high-competitor-count tail."""
    module = "M310"
    algorithm = "competitive_gap_high_pressure_volume_share_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m310_min_gap_search_volume", 100), 100_000_000_000)
    high_pressure_count = normalize_integer(config.get("m310_high_pressure_competitor_count", 4), 100_000)
    max_share = normalize_integer(config.get("m310_max_high_pressure_gap_volume_share_ppm", 700_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "high_pressure_competitor_count": high_pressure_count if high_pressure_count is not None else "INVALID",
        "max_high_pressure_gap_volume_share_ppm": max_share if max_share is not None else "INVALID",
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "numerator": "gap_search_volume_where_competitor_count_gte_high_pressure_count",
        "denominator": "all_gap_search_volume",
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if (min_gap_volume is None or min_gap_volume < 1 or
            high_pressure_count is None or high_pressure_count < 1 or max_share is None):
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    high_pressure_volume = 0
    high_pressure_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_gap = _checked_add(gap_volume, item["search_volume"])
        if next_gap is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_gap
        if item["competitor_ranked_count"] >= high_pressure_count:
            next_high = _checked_add(high_pressure_volume, item["search_volume"])
            if next_high is None:
                return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            high_pressure_volume = next_high
            high_pressure_keywords.append({
                "keyword": item["keyword"],
                "search_volume": item["search_volume"],
                "competitor_ranked_count": item["competitor_ranked_count"],
            })

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )
    share = div_round_half_even(high_pressure_volume, gap_volume, PPM_SCALE)
    if share is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    high_pressure_keywords.sort(key=lambda item: (
        -item["search_volume"], -item["competitor_ranked_count"], item["keyword"]
    ))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "HIGH_PRESSURE_GAP_VOLUME_SHARE_HIGH" if high else "HIGH_PRESSURE_GAP_VOLUME_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "gap_search_volume": gap_volume,
         "high_pressure_gap_search_volume": high_pressure_volume,
         "high_pressure_gap_volume_share_ppm": share,
         "high_pressure_keywords": high_pressure_keywords,
         "invalid_records_count": invalid_count},
    )


def run_m311(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure site coverage share inside explicitly observed high-competition search volume."""
    module = "M311"
    algorithm = "high_pressure_competitive_site_coverage_share_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_volume = normalize_integer(config.get("m311_min_high_pressure_search_volume", 100), 100_000_000_000)
    high_pressure_count = normalize_integer(config.get("m311_high_pressure_competitor_count", 4), 100_000)
    min_coverage = normalize_integer(config.get("m311_min_site_coverage_share_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_high_pressure_search_volume": min_volume if min_volume is not None else "INVALID",
        "high_pressure_competitor_count": high_pressure_count if high_pressure_count is not None else "INVALID",
        "min_site_coverage_share_ppm": min_coverage if min_coverage is not None else "INVALID",
        "population": "competitor_ranked_count_gte_high_pressure_count_and_positive_search_volume",
        "numerator": "site_ranked_high_pressure_search_volume",
        "denominator": "all_high_pressure_search_volume",
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if (min_volume is None or min_volume < 1 or high_pressure_count is None or
            high_pressure_count < 1 or min_coverage is None):
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    high_pressure_volume = 0
    covered_volume = 0
    uncovered_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        if item["competitor_ranked_count"] < high_pressure_count or item["search_volume"] == 0:
            continue
        next_total = _checked_add(high_pressure_volume, item["search_volume"])
        if next_total is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        high_pressure_volume = next_total
        if item["site_ranked"]:
            next_covered = _checked_add(covered_volume, item["search_volume"])
            if next_covered is None:
                return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                       "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
            covered_volume = next_covered
        else:
            uncovered_keywords.append({
                "keyword": item["keyword"],
                "search_volume": item["search_volume"],
                "competitor_ranked_count": item["competitor_ranked_count"],
            })

    if high_pressure_volume == 0 or high_pressure_volume < min_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_HIGH_PRESSURE_COMPETITIVE_VOLUME",
            {"high_pressure_search_volume": high_pressure_volume,
             "invalid_records_count": invalid_count},
        )
    coverage = div_round_half_even(covered_volume, high_pressure_volume, PPM_SCALE)
    if coverage is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    low = coverage < min_coverage
    uncovered_keywords.sort(key=lambda item: (
        -item["search_volume"], -item["competitor_ranked_count"], item["keyword"]
    ))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if low else "NO_FINDING",
        "HIGH_PRESSURE_SITE_COVERAGE_LOW" if low else "HIGH_PRESSURE_SITE_COVERAGE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE,
         "high_pressure_search_volume": high_pressure_volume,
         "site_covered_high_pressure_search_volume": covered_volume,
         "high_pressure_site_coverage_ppm": coverage,
         "uncovered_high_pressure_keywords": uncovered_keywords,
         "invalid_records_count": invalid_count},
    )


def run_m312(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure search-volume-weighted dispersion of competitor pressure across observed site-absent gaps."""
    module = "M312"
    algorithm = "competitive_gap_pressure_dispersion_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m312_min_gap_search_volume", 100), 100_000_000_000)
    max_mad_milli = normalize_integer(config.get("m312_max_gap_pressure_mad_milli", 1_000), 100_000_000)
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "max_gap_pressure_mad_milli": max_mad_milli if max_mad_milli is not None else "INVALID",
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "weight": "search_volume",
        "center": "search_volume_weighted_competitor_count_milli",
        "dispersion": "search_volume_weighted_mean_absolute_deviation_milli",
        "pressure_scale": 1000,
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if min_gap_volume is None or min_gap_volume < 1 or max_mad_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    weighted_competitor_units = 0
    gap_rows: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_volume = _checked_add(gap_volume, item["search_volume"])
        weighted = _checked_mul(item["search_volume"], item["competitor_ranked_count"])
        next_weighted = None if weighted is None else _checked_add(weighted_competitor_units, weighted)
        if next_volume is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_volume
        weighted_competitor_units = next_weighted
        gap_rows.append(item)

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )

    center_milli = div_round_half_even(weighted_competitor_units, gap_volume, 1000)
    if center_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})

    weighted_abs_deviation_milli = 0
    for item in gap_rows:
        competitor_milli = _checked_mul(item["competitor_ranked_count"], 1000)
        if competitor_milli is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        deviation_milli = abs(competitor_milli - center_milli)
        weighted_deviation = _checked_mul(deviation_milli, item["search_volume"])
        next_deviation = None if weighted_deviation is None else _checked_add(
            weighted_abs_deviation_milli, weighted_deviation
        )
        if next_deviation is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        weighted_abs_deviation_milli = next_deviation

    mad_milli = div_round_half_even(weighted_abs_deviation_milli, gap_volume, 1)
    if mad_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = mad_milli > max_mad_milli
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_PRESSURE_DISPERSION_HIGH" if high else "COMPETITIVE_GAP_PRESSURE_DISPERSION_WITHIN_POLICY",
        {"pressure_scale": 1000,
         "gap_search_volume": gap_volume,
         "gap_keyword_count": len(gap_rows),
         "weighted_gap_competitor_count_milli": center_milli,
         "weighted_gap_pressure_mad_milli": mad_milli,
         "invalid_records_count": invalid_count},
    )

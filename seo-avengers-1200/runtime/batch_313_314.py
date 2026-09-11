from __future__ import annotations

from typing import Any, Dict, List

from .batch_201_502 import _checked_mul
from .batch_203_504 import _checked_add, _prepare_competitor_records
from .batch_309_314 import (
    _competitive_data_quality_receipt,
    _competitive_input_error,
    _competitive_norm_hash,
)
from .seo_avengers_1200 import canonical_hash, compile_receipt, div_round_half_even, normalize_integer


def run_m313(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure volume-weighted excess competitor pressure above an explicit floor on observed site-absent gaps."""
    module = "M313"
    algorithm = "competitive_gap_tail_excess_severity_monitor"
    raw_hash, dataset, invalid_count, conflicts = _prepare_competitor_records(records)
    early = _competitive_input_error(module, algorithm, records, raw_hash)
    if early is not None:
        return early

    min_gap_volume = normalize_integer(config.get("m313_min_gap_search_volume", 100), 100_000_000_000)
    pressure_floor = normalize_integer(config.get("m313_tail_pressure_floor_competitor_count", 3), 100_000)
    max_excess_milli = normalize_integer(config.get("m313_max_weighted_tail_excess_milli", 700), 100_000_000)
    cfg_hash = canonical_hash({
        "min_gap_search_volume": min_gap_volume if min_gap_volume is not None else "INVALID",
        "tail_pressure_floor_competitor_count": pressure_floor if pressure_floor is not None else "INVALID",
        "max_weighted_tail_excess_milli": max_excess_milli if max_excess_milli is not None else "INVALID",
        "population": "site_absent_and_competitor_ranked_count_gt_zero",
        "tail": "competitor_ranked_count_gt_tail_pressure_floor_competitor_count",
        "excess": "max(competitor_ranked_count-tail_pressure_floor_competitor_count,0)",
        "weight": "search_volume",
        "denominator": "all_gap_search_volume",
        "pressure_scale": 1000,
    })
    norm_hash = _competitive_norm_hash(dataset, invalid_count, conflicts)
    if (min_gap_volume is None or min_gap_volume < 1 or pressure_floor is None or
            pressure_floor < 1 or max_excess_milli is None):
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    data_quality = _competitive_data_quality_receipt(
        module, algorithm, raw_hash, norm_hash, cfg_hash, conflicts, invalid_count
    )
    if data_quality is not None:
        return data_quality

    gap_volume = 0
    tail_volume = 0
    weighted_excess_units = 0
    tail_keywords: List[Dict[str, Any]] = []
    for item in dataset:
        if item["site_ranked"] or item["competitor_ranked_count"] <= 0 or item["search_volume"] == 0:
            continue
        next_gap = _checked_add(gap_volume, item["search_volume"])
        if next_gap is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        gap_volume = next_gap

        excess_count = item["competitor_ranked_count"] - pressure_floor
        if excess_count <= 0:
            continue
        next_tail = _checked_add(tail_volume, item["search_volume"])
        weighted_excess = _checked_mul(item["search_volume"], excess_count)
        next_weighted = None if weighted_excess is None else _checked_add(
            weighted_excess_units, weighted_excess
        )
        if next_tail is None or next_weighted is None:
            return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        tail_volume = next_tail
        weighted_excess_units = next_weighted
        tail_keywords.append({
            "keyword": item["keyword"],
            "search_volume": item["search_volume"],
            "competitor_ranked_count": item["competitor_ranked_count"],
            "excess_competitor_count": excess_count,
        })

    if gap_volume == 0 or gap_volume < min_gap_volume:
        return compile_receipt(
            module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_COMPETITIVE_GAP_VOLUME",
            {"gap_search_volume": gap_volume, "invalid_records_count": invalid_count},
        )

    weighted_excess_milli = div_round_half_even(weighted_excess_units, gap_volume, 1000)
    if weighted_excess_milli is None:
        return compile_receipt(module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
    high = weighted_excess_milli > max_excess_milli
    tail_keywords.sort(key=lambda item: (
        -item["excess_competitor_count"], -item["search_volume"], item["keyword"]
    ))
    return compile_receipt(
        module, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if high else "NO_FINDING",
        "COMPETITIVE_GAP_TAIL_EXCESS_HIGH" if high else "COMPETITIVE_GAP_TAIL_EXCESS_WITHIN_POLICY",
        {"pressure_scale": 1000,
         "tail_pressure_floor_competitor_count": pressure_floor,
         "gap_search_volume": gap_volume,
         "tail_gap_search_volume": tail_volume,
         "weighted_tail_excess_milli": weighted_excess_milli,
         "tail_keywords": tail_keywords,
         "invalid_records_count": invalid_count},
    )

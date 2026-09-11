from __future__ import annotations

from typing import Any, Dict, List

from .batch_201_502 import _checked_mul
from .batch_203_504 import _checked_add, _prepare_competitor_records
from .seo_avengers_1200 import canonical_hash, compile_receipt, div_round_half_even, normalize_integer


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

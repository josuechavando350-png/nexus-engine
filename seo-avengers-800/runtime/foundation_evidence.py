from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, complement_ppm, need_int, need_int_list, need_str, need_str_list, overlap_ppm, ratio_ppm, subset_coverage_ppm


def _ppm_int(row: Mapping[str, Any], key: str) -> int:
    value = need_int(row, key, minimum=0)
    if value > PPM:
        raise InvalidData(f'{key}_above_one_million')
    return value


def _score(metric_ppm: int, threshold_ppm: int, metric_name: str = 'evidence_health_ppm') -> Dict[str, Any]:
    return {
        'metric_name': metric_name,
        'metric_ppm': metric_ppm,
        'threshold_ppm': threshold_ppm,
        'policy_direction': 'higher_is_healthier',
        'violation': metric_ppm < threshold_ppm,
    }


def evaluate(operation: str, row: Mapping[str, Any], spec: Mapping[str, Any]) -> Dict[str, Any]:
    fields = tuple(str(x) for x in spec['input_fields'])
    formula = str(spec['formula'])
    threshold_ppm = int(spec['threshold_ppm'])

    if formula == 'coverage_count':
        total = need_int(row, fields[0], minimum=0); good = need_int(row, fields[1], minimum=0)
        if total == 0: raise InsufficientData(f'{fields[0]}_zero')
        if good > total: raise InvalidData(f'{fields[1]}_exceeds_{fields[0]}')
        return _score(ratio_ppm(good, total), threshold_ppm)

    if formula == 'defect_rate':
        total = need_int(row, fields[0], minimum=0); bad = need_int(row, fields[1], minimum=0)
        if total == 0: raise InsufficientData(f'{fields[0]}_zero')
        if bad > total: raise InvalidData(f'{fields[1]}_exceeds_{fields[0]}')
        return _score(complement_ppm(ratio_ppm(bad, total)), threshold_ppm)

    if formula == 'budget':
        observed = need_int(row, fields[0], minimum=0); limit = need_int(row, fields[1], minimum=0)
        if limit == 0: raise InsufficientData(f'{fields[1]}_zero')
        score = PPM if observed <= limit else ratio_ppm(limit, observed)
        return _score(score, threshold_ppm)

    if formula == 'minimum':
        observed = need_int(row, fields[0], minimum=0); required = need_int(row, fields[1], minimum=0)
        if required == 0: raise InsufficientData(f'{fields[1]}_zero')
        score = PPM if observed >= required else ratio_ppm(observed, required)
        return _score(score, threshold_ppm)

    if formula == 'ratio_score':
        numerator = need_int(row, fields[0], minimum=0); denominator = need_int(row, fields[1], minimum=0)
        if denominator == 0: raise InsufficientData(f'{fields[1]}_zero')
        if numerator > denominator: raise InvalidData(f'{fields[0]}_exceeds_{fields[1]}')
        return _score(ratio_ppm(numerator, denominator), threshold_ppm)

    if formula == 'subset':
        required = need_str_list(row, fields[0]); observed = need_str_list(row, fields[1])
        return _score(subset_coverage_ppm(required, observed), threshold_ppm)

    if formula == 'overlap':
        left = need_str_list(row, fields[0]); right = need_str_list(row, fields[1])
        return _score(overlap_ppm(left, right), threshold_ppm)

    if formula == 'separation':
        left = need_str_list(row, fields[0]); right = need_str_list(row, fields[1])
        return _score(complement_ppm(overlap_ppm(left, right)), threshold_ppm)

    if formula == 'equality':
        left = need_str(row, fields[0]); right = need_str(row, fields[1])
        return _score(PPM if left == right else 0, threshold_ppm)

    if formula == 'ppm_mean':
        values = need_int_list(row, fields[0], minimum=0)
        if not values: raise InsufficientData(f'{fields[0]}_empty')
        if any(v > PPM for v in values): raise InvalidData(f'{fields[0]}_above_one_million')
        return _score(sum(values) // len(values), threshold_ppm)

    if formula == 'ppm_min':
        values = need_int_list(row, fields[0], minimum=0)
        if not values: raise InsufficientData(f'{fields[0]}_empty')
        if any(v > PPM for v in values): raise InvalidData(f'{fields[0]}_above_one_million')
        return _score(min(values), threshold_ppm)

    if formula == 'ppm_pair_mean':
        left = _ppm_int(row, fields[0]); right = _ppm_int(row, fields[1])
        return _score((left + right) // 2, threshold_ppm)

    if formula == 'inverse_balance':
        largest = need_int(row, fields[0], minimum=0); smallest = need_int(row, fields[1], minimum=0)
        if largest == 0: raise InsufficientData(f'{fields[0]}_zero')
        if smallest > largest: raise InvalidData(f'{fields[1]}_exceeds_{fields[0]}')
        return _score(ratio_ppm(smallest, largest), threshold_ppm)

    if formula == 'delta_ppm':
        observed = _ppm_int(row, fields[0]); baseline = _ppm_int(row, fields[1]); tolerance = _ppm_int(row, fields[2])
        delta = abs(observed - baseline)
        score = PPM if delta <= tolerance else complement_ppm(delta - tolerance)
        return _score(score, threshold_ppm)

    if formula == 'delta_int':
        observed = need_int(row, fields[0], minimum=0); baseline = need_int(row, fields[1], minimum=0); tolerance = need_int(row, fields[2], minimum=0)
        delta = abs(observed - baseline)
        if delta <= tolerance: return _score(PPM, threshold_ppm)
        denominator = max(1, baseline)
        score = complement_ppm(ratio_ppm(delta - tolerance, denominator))
        return _score(score, threshold_ppm)

    raise InvalidData(f'unsupported_foundation_formula:{formula}:{operation}')

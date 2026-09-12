from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any, Dict, List, Mapping, Sequence

INT_MIN = -(2**63)
INT_MAX = 2**63 - 1
PPM = 1_000_000
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class InvalidData(ValueError):
    pass


class InsufficientData(ValueError):
    pass


def _normalize(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        if value < INT_MIN or value > INT_MAX:
            raise InvalidData("integer_out_of_range")
        return value
    if isinstance(value, float):
        raise InvalidData("floats_not_allowed")
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, tuple):
        return [_normalize(v) for v in value]
    if isinstance(value, Mapping):
        out: Dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str):
                raise InvalidData("mapping_keys_must_be_strings")
            normalized_key = unicodedata.normalize("NFC", key)
            if normalized_key in out:
                raise InvalidData("normalized_mapping_key_collision")
            out[normalized_key] = _normalize(value[key])
        return out
    raise InvalidData(f"unsupported_type:{type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(_normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_value(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def need_int(row: Mapping[str, Any], key: str, *, minimum: int | None = None, maximum: int | None = None) -> int:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidData(f"{key}_must_be_int")
    if value < INT_MIN or value > INT_MAX:
        raise InvalidData(f"{key}_out_of_int64_range")
    if minimum is not None and value < minimum:
        raise InvalidData(f"{key}_below_minimum")
    if maximum is not None and value > maximum:
        raise InvalidData(f"{key}_above_maximum")
    return value


def need_ppm(row: Mapping[str, Any], key: str) -> int:
    return need_int(row, key, minimum=0, maximum=PPM)


def need_bool(row: Mapping[str, Any], key: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        raise InvalidData(f"{key}_must_be_bool")
    return value


def need_str(row: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = row.get(key)
    if not isinstance(value, str):
        raise InvalidData(f"{key}_must_be_string")
    normalized = unicodedata.normalize("NFC", value)
    if not allow_empty and not normalized:
        raise InsufficientData(f"{key}_empty")
    return normalized


def need_sha256(row: Mapping[str, Any], key: str) -> str:
    value = need_str(row, key)
    if _SHA256_RE.fullmatch(value) is None:
        raise InvalidData(f"{key}_invalid_sha256")
    return value


def need_list(row: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> List[Any]:
    value = row.get(key)
    if not isinstance(value, list):
        raise InvalidData(f"{key}_must_be_list")
    if not value and not allow_empty:
        raise InsufficientData(f"{key}_empty")
    return value


def need_str_list(row: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> List[str]:
    values = need_list(row, key, allow_empty=allow_empty)
    out: List[str] = []
    for value in values:
        if not isinstance(value, str):
            raise InvalidData(f"{key}_items_must_be_strings")
        normalized = unicodedata.normalize("NFC", value)
        if not normalized:
            raise InvalidData(f"{key}_items_must_be_nonempty")
        out.append(normalized)
    return out


def need_int_list(row: Mapping[str, Any], key: str, *, minimum: int | None = None, maximum: int | None = None, allow_empty: bool = False) -> List[int]:
    values = need_list(row, key, allow_empty=allow_empty)
    out: List[int] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidData(f"{key}_items_must_be_ints")
        if value < INT_MIN or value > INT_MAX:
            raise InvalidData(f"{key}_item_out_of_int64_range")
        if minimum is not None and value < minimum:
            raise InvalidData(f"{key}_item_below_minimum")
        if maximum is not None and value > maximum:
            raise InvalidData(f"{key}_item_above_maximum")
        out.append(value)
    return out


def need_ppm_list(row: Mapping[str, Any], key: str) -> List[int]:
    return need_int_list(row, key, minimum=0, maximum=PPM)


def bounded_ratio_ppm(numerator: int, denominator: int) -> int:
    if isinstance(numerator, bool) or isinstance(denominator, bool):
        raise InvalidData("ratio_bool_not_allowed")
    if denominator <= 0:
        raise InsufficientData("zero_or_negative_denominator")
    if numerator < 0:
        raise InvalidData("negative_numerator")
    if numerator > denominator:
        raise InvalidData("numerator_exceeds_denominator")
    return (numerator * PPM) // denominator


def capped_ratio_ppm(numerator: int, denominator: int) -> int:
    if isinstance(numerator, bool) or isinstance(denominator, bool):
        raise InvalidData("ratio_bool_not_allowed")
    if denominator <= 0:
        raise InsufficientData("zero_or_negative_denominator")
    if numerator < 0:
        raise InvalidData("negative_numerator")
    if numerator >= denominator:
        return PPM
    return (numerator * PPM) // denominator


def complement_ppm(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= PPM:
        raise InvalidData("ppm_value_out_of_range")
    return PPM - value


def jaccard_ppm(left: Sequence[str], right: Sequence[str]) -> int:
    a = {unicodedata.normalize("NFC", item).casefold() for item in left if item}
    b = {unicodedata.normalize("NFC", item).casefold() for item in right if item}
    if not a or not b:
        raise InsufficientData("jaccard_requires_nonempty_sets")
    return bounded_ratio_ppm(len(a & b), len(a | b))


def coverage_ppm(required: Sequence[str], observed: Sequence[str]) -> int:
    req = {unicodedata.normalize("NFC", item).casefold() for item in required if item}
    obs = {unicodedata.normalize("NFC", item).casefold() for item in observed if item}
    if not req:
        raise InsufficientData("required_set_empty")
    return bounded_ratio_ppm(len(req & obs), len(req))


def positional_match_ppm(left: Sequence[str], right: Sequence[str]) -> int:
    if not left or not right:
        raise InsufficientData("sequence_requires_nonempty_values")
    denominator = max(len(left), len(right))
    matches = sum(1 for l, r in zip(left, right) if l == r)
    return bounded_ratio_ppm(matches, denominator)


def mean_ppm(values: Sequence[int]) -> int:
    if not values:
        raise InsufficientData("ppm_vector_empty")
    total = 0
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= PPM:
            raise InvalidData("ppm_vector_item_out_of_range")
        total += value
    return total // len(values)


def min_ppm(values: Sequence[int]) -> int:
    if not values:
        raise InsufficientData("ppm_vector_empty")
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= PPM:
            raise InvalidData("ppm_vector_item_out_of_range")
    return min(values)


def vector_stability_ppm(left: Sequence[int], right: Sequence[int]) -> int:
    if not left or not right:
        raise InsufficientData("vector_stability_requires_nonempty_vectors")
    if len(left) != len(right):
        raise InvalidData("vector_length_mismatch")
    deltas = []
    for l_value, r_value in zip(left, right):
        if isinstance(l_value, bool) or not isinstance(l_value, int) or not 0 <= l_value <= PPM:
            raise InvalidData("left_vector_ppm_out_of_range")
        if isinstance(r_value, bool) or not isinstance(r_value, int) or not 0 <= r_value <= PPM:
            raise InvalidData("right_vector_ppm_out_of_range")
        deltas.append(abs(l_value - r_value))
    return PPM - (sum(deltas) // len(deltas))


def distribution_uniformity_ppm(values: Sequence[int]) -> int:
    if not values:
        raise InsufficientData("distribution_empty")
    checked = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= PPM:
            raise InvalidData("distribution_ppm_out_of_range")
        checked.append(value)
    spread = max(checked) - min(checked)
    return PPM - spread


def exact_text_match_ppm(left: str, right: str, *, casefold: bool = False) -> int:
    if casefold:
        return PPM if left.casefold() == right.casefold() else 0
    return PPM if left == right else 0


def validate_required_fields(row: Mapping[str, Any], fields: Sequence[str]) -> None:
    for field in fields:
        if field not in row:
            raise InsufficientData(f"{field}_missing")


def normalize_records(payload: Mapping[str, Any], dataset_key: str) -> Dict[str, Dict[str, Any]]:
    raw = payload.get(dataset_key)
    if raw is None:
        raise InsufficientData(f"{dataset_key}_missing")
    if not isinstance(raw, list):
        raise InvalidData(f"{dataset_key}_must_be_list")
    if not raw:
        raise InsufficientData(f"{dataset_key}_empty")
    normalized: Dict[str, Dict[str, Any]] = {}
    serialized: Dict[str, str] = {}
    for item in raw:
        item_norm = _normalize(item)
        if not isinstance(item_norm, dict):
            raise InvalidData(f"{dataset_key}_record_must_be_object")
        module_id = item_norm.get("module_id")
        if not isinstance(module_id, str) or not module_id:
            raise InvalidData(f"{dataset_key}_module_id_required")
        encoded = canonical_json(item_norm)
        if module_id in normalized and serialized[module_id] != encoded:
            raise InvalidData(f"{dataset_key}_conflicting_duplicate:{module_id}")
        normalized[module_id] = item_norm
        serialized[module_id] = encoded
    return normalized


def select_record(payload: Mapping[str, Any], dataset_key: str, target_id: str, source_id: str) -> Dict[str, Any]:
    rows = normalize_records(payload, dataset_key)
    target = rows.get(target_id)
    source = rows.get(source_id)
    if target is not None and source is not None:
        target_copy = dict(target)
        source_copy = dict(source)
        target_copy.pop("module_id", None)
        source_copy.pop("module_id", None)
        if canonical_json(target_copy) != canonical_json(source_copy):
            raise InvalidData(f"{dataset_key}_target_source_conflict:{target_id}:{source_id}")
    row = target if target is not None else source
    if row is None:
        raise InsufficientData(f"{dataset_key}_record_missing:{target_id}")
    return row


def make_receipt(*, module_id: str, source_module: str, operation: str, family: str, raw_row: Mapping[str, Any] | None, normalized_row: Mapping[str, Any] | None, module_config: Mapping[str, Any], execution_status: str, finding_status: str, reason_code: str, output: Mapping[str, Any]) -> Dict[str, Any]:
    algorithm = f"avengers1000_v1_{module_id.lower()}_{operation}"
    receipt = {
        "module": module_id,
        "source_module": source_module,
        "family": family,
        "operation": operation,
        "algorithm": algorithm,
        "algorithm_version": 1,
        "schema_version": 1,
        "raw_input_hash": hash_value(raw_row) if raw_row is not None else None,
        "normalized_input_hash": hash_value(normalized_row) if normalized_row is not None else None,
        "module_config_hash": hash_value(module_config),
        "execution_status": execution_status,
        "finding_status": finding_status,
        "reason_code": reason_code,
        "output": dict(output),
    }
    receipt["evidence_hash"] = hash_value(receipt)
    return receipt

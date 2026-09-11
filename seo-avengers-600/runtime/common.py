from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any, Dict, List, Mapping, Sequence

INT_MIN = -(2**63)
INT_MAX = 2**63 - 1
PPM = 1_000_000


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
            out[unicodedata.normalize("NFC", key)] = _normalize(value[key])
        return out
    raise InvalidData(f"unsupported_type:{type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(_normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_value(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def clamp_ppm(value: int) -> int:
    if value < 0:
        return 0
    if value > PPM:
        return PPM
    return value


def ratio_ppm(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise InsufficientData("zero_or_negative_denominator")
    if numerator < 0:
        raise InvalidData("negative_numerator")
    return clamp_ppm((numerator * PPM) // denominator)


def complement_ppm(value: int) -> int:
    return PPM - clamp_ppm(value)


def weighted_ppm(value: int, weight_ppm: int) -> int:
    return clamp_ppm((clamp_ppm(value) * clamp_ppm(weight_ppm)) // PPM)


def need_int(row: Mapping[str, Any], key: str, *, minimum: int | None = None) -> int:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidData(f"{key}_must_be_int")
    if minimum is not None and value < minimum:
        raise InvalidData(f"{key}_below_minimum")
    return value


def need_bool(row: Mapping[str, Any], key: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        raise InvalidData(f"{key}_must_be_bool")
    return value


def need_str(row: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = row.get(key)
    if not isinstance(value, str):
        raise InvalidData(f"{key}_must_be_string")
    value = unicodedata.normalize("NFC", value)
    if not allow_empty and not value:
        raise InsufficientData(f"{key}_empty")
    return value


def need_list(row: Mapping[str, Any], key: str) -> List[Any]:
    value = row.get(key)
    if not isinstance(value, list):
        raise InvalidData(f"{key}_must_be_list")
    return value


def need_str_list(row: Mapping[str, Any], key: str) -> List[str]:
    values = need_list(row, key)
    out: List[str] = []
    for value in values:
        if not isinstance(value, str):
            raise InvalidData(f"{key}_items_must_be_strings")
        out.append(unicodedata.normalize("NFC", value))
    return out


def need_int_list(row: Mapping[str, Any], key: str, *, minimum: int | None = None) -> List[int]:
    values = need_list(row, key)
    out: List[int] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidData(f"{key}_items_must_be_ints")
        if minimum is not None and value < minimum:
            raise InvalidData(f"{key}_item_below_minimum")
        out.append(value)
    return out


def overlap_ppm(left: Sequence[str], right: Sequence[str]) -> int:
    a = {x.casefold() for x in left if x}
    b = {x.casefold() for x in right if x}
    if not a or not b:
        raise InsufficientData("overlap_requires_nonempty_sets")
    return ratio_ppm(len(a & b), len(a | b))


def subset_coverage_ppm(required: Sequence[str], observed: Sequence[str]) -> int:
    req = {x.casefold() for x in required if x}
    obs = {x.casefold() for x in observed if x}
    if not req:
        raise InsufficientData("required_set_empty")
    return ratio_ppm(len(req & obs), len(req))


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
    if target is not None and source is not None and canonical_json(target) != canonical_json(source):
        raise InvalidData(f"{dataset_key}_target_source_conflict:{target_id}:{source_id}")
    row = target if target is not None else source
    if row is None:
        raise InsufficientData(f"{dataset_key}_record_missing:{target_id}")
    return row


def make_receipt(*, module_id: str, source_module: str, operation: str, family: str,
                 raw_row: Mapping[str, Any] | None, normalized_row: Mapping[str, Any] | None,
                 module_config: Mapping[str, Any], execution_status: str,
                 finding_status: str, reason_code: str, output: Mapping[str, Any]) -> Dict[str, Any]:
    algorithm = f"avengers600_v1_{module_id.lower()}_{operation}"
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

from __future__ import annotations

import hashlib
import html as html_lib
import json
import re
import unicodedata
import zlib
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import parse_qsl, urlparse

from .seo_avengers_1200 import canonical_hash, normalize_integer

INT64_MAX = 9_223_372_036_854_775_807
PPM = 1_000_000

class _InvalidData(Exception):
    pass

class _InsufficientData(Exception):
    pass

class _InvalidConfig(Exception):
    pass

@dataclass(frozen=True)
class EvalResult:
    metric_name: str
    metric_value: int
    finding: bool
    policy: Dict[str, Any]
    details: Dict[str, Any]
    finding_reason: str
    okay_reason: str

def _reason_slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]+", "_", normalized.upper()).strip("_")

def _canonicalize(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str):
            return unicodedata.normalize("NFC", value)
        return value
    if type(value) is int:
        if not (-INT64_MAX <= value <= INT64_MAX):
            raise _InvalidData("INTEGER_RANGE_EXCEEDED")
        return value
    if isinstance(value, float):
        raise _InvalidData("FLOATS_FORBIDDEN")
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, child in value.items():
            if not isinstance(key, str) or not key:
                raise _InvalidData("INVALID_OBJECT_KEY")
            clean_key = unicodedata.normalize("NFC", key)
            if clean_key in result:
                raise _InvalidData("DUPLICATE_NORMALIZED_KEY")
            result[clean_key] = _canonicalize(child)
        return result
    raise _InvalidData("NON_JSON_VALUE")

def _prepare_records(records: Any, key_field: str) -> Tuple[str | None, List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"records": records})
    except (TypeError, ValueError):
        raw_hash = None
    if not isinstance(records, list):
        return raw_hash, [], 1, []
    seen: Dict[str, Dict[str, Any]] = {}
    invalid = 0
    conflicts: List[str] = []
    for item in records:
        if not isinstance(item, dict):
            invalid += 1
            continue
        try:
            row = _canonicalize(item)
        except _InvalidData:
            invalid += 1
            continue
        key = row.get(key_field)
        if not isinstance(key, str) or not key.strip():
            invalid += 1
            continue
        key = " ".join(key.strip().split())
        row[key_field] = key
        prior = seen.get(key)
        if prior is None:
            seen[key] = row
        elif prior != row:
            conflicts.append(key)
    rows = [seen[key] for key in sorted(seen)]
    return raw_hash, rows, invalid, sorted(set(conflicts))

def _config_threshold(config: Mapping[str, Any], module_id: str, default: int, maximum: int = INT64_MAX) -> int:
    key = f"{module_id.lower()}_policy_threshold"
    raw = config.get(key, default)
    value = normalize_integer(raw, maximum)
    if value is None:
        raise _InvalidConfig(key)
    return value

def _req_str(row: Mapping[str, Any], key: str) -> str:
    if key not in row:
        raise _InsufficientData(key)
    value = row[key]
    if not isinstance(value, str):
        raise _InvalidData(key)
    clean = unicodedata.normalize("NFC", value)
    if not clean.strip():
        raise _InsufficientData(key)
    return clean

def _opt_str(row: Mapping[str, Any], key: str, default: str = "") -> str:
    if key not in row:
        return default
    value = row[key]
    if not isinstance(value, str):
        raise _InvalidData(key)
    return unicodedata.normalize("NFC", value)

def _req_int(row: Mapping[str, Any], key: str, maximum: int = INT64_MAX) -> int:
    if key not in row:
        raise _InsufficientData(key)
    value = row[key]
    if type(value) is not int or value < 0 or value > maximum:
        raise _InvalidData(key)
    return value

def _opt_int(row: Mapping[str, Any], key: str, default: int = 0, maximum: int = INT64_MAX) -> int:
    if key not in row:
        return default
    value = row[key]
    if type(value) is not int or value < 0 or value > maximum:
        raise _InvalidData(key)
    return value

def _opt_bool(row: Mapping[str, Any], key: str, default: bool = False) -> bool:
    if key not in row:
        return default
    value = row[key]
    if type(value) is not bool:
        raise _InvalidData(key)
    return value

def _opt_dict(row: Mapping[str, Any], key: str) -> Dict[str, Any]:
    if key not in row:
        return {}
    value = row[key]
    if not isinstance(value, dict):
        raise _InvalidData(key)
    return dict(value)

def _opt_list(row: Mapping[str, Any], key: str) -> List[Any]:
    if key not in row:
        return []
    value = row[key]
    if not isinstance(value, list):
        raise _InvalidData(key)
    return list(value)

def _list_str(row: Mapping[str, Any], key: str) -> List[str]:
    values = _opt_list(row, key)
    if any(not isinstance(item, str) for item in values):
        raise _InvalidData(key)
    return [unicodedata.normalize("NFC", item) for item in values]

def _tags(html: str) -> List[str]:
    return re.findall(r"<\s*([a-zA-Z][a-zA-Z0-9:-]*)\b", html)

def _text_from_html(html: str) -> str:
    no_scripts = re.sub(r"<(script|style)\b[^>]*>.*?</\1\s*>", " ", html, flags=re.I | re.S)
    no_tags = re.sub(r"<[^>]+>", " ", no_scripts)
    return " ".join(html_lib.unescape(no_tags).split())

def _tokens(text: str) -> List[str]:
    return re.findall(r"[\wáéíóúüñ]+", unicodedata.normalize("NFC", text).casefold(), flags=re.UNICODE)

def _sentences(text: str) -> List[str]:
    return [piece.strip() for piece in re.split(r"[.!?]+", text) if piece.strip()]

def _ppm(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        return 0
    return (numerator * PPM + denominator // 2) // denominator

def _gt_result(module_id: str, metric_name: str, value: int, config: Mapping[str, Any], default: int,
               details: Dict[str, Any], reason_base: str, maximum: int = INT64_MAX) -> EvalResult:
    threshold = _config_threshold(config, module_id, default, maximum)
    return EvalResult(metric_name, value, value > threshold,
                      {"comparison": "GT", "threshold": threshold}, details,
                      f"{reason_base}_ABOVE_POLICY", f"{reason_base}_WITHIN_POLICY")

def _lt_result(module_id: str, metric_name: str, value: int, config: Mapping[str, Any], default: int,
               details: Dict[str, Any], reason_base: str, maximum: int = INT64_MAX) -> EvalResult:
    threshold = _config_threshold(config, module_id, default, maximum)
    return EvalResult(metric_name, value, value < threshold,
                      {"comparison": "LT", "threshold": threshold}, details,
                      f"{reason_base}_BELOW_POLICY", f"{reason_base}_WITHIN_POLICY")

def _entity_rows(row: Mapping[str, Any]) -> List[Dict[str, Any]]:
    values = _opt_list(row, "entities")
    result: List[Dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            raise _InvalidData("entities")
        result.append(dict(value))
    return result

def _entity_id(entity: Mapping[str, Any]) -> str:
    value = entity.get("id")
    if not isinstance(value, str) or not value.strip():
        raise _InvalidData("entity.id")
    return value.strip()

def _entity_label(entity: Mapping[str, Any]) -> str:
    value = entity.get("label")
    if not isinstance(value, str) or not value.strip():
        raise _InvalidData("entity.label")
    return " ".join(value.strip().split())

def _entity_type(entity: Mapping[str, Any]) -> str:
    value = entity.get("type", "UNKNOWN")
    if not isinstance(value, str):
        raise _InvalidData("entity.type")
    return value.strip().upper() or "UNKNOWN"

def _headers_lower(row: Mapping[str, Any], key: str) -> Dict[str, str]:
    raw = _opt_dict(row, key)
    result: Dict[str, str] = {}
    for header, value in raw.items():
        if not isinstance(header, str) or not isinstance(value, str):
            raise _InvalidData(key)
        result[header.casefold()] = value
    return result

def _normalized_html_text(value: str) -> str:
    return " ".join(_tokens(_text_from_html(value)))

__all__ = [name for name in globals() if not name.startswith("__")]

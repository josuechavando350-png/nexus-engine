from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit

INT_MIN = -(2**63)
INT_MAX = 2**63 - 1
PPM = 1_000_000
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_TOKEN_RE = re.compile(r"\w+", flags=re.UNICODE)

class InvalidData(ValueError):
    """Evidence is malformed or violates a hard contract."""

class InsufficientData(ValueError):
    """Evidence is valid but insufficient for a defensible conclusion."""

def _normalize(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value < INT_MIN or value > INT_MAX:
            raise InvalidData("integer_out_of_int64_range")
        return value
    if isinstance(value, float):
        raise InvalidData("floats_not_allowed")
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, (list, tuple)):
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

def need_int(value: Any, name: str, *, minimum: int | None = None, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidData(f"{name}_must_be_int")
    if value < INT_MIN or value > INT_MAX:
        raise InvalidData(f"{name}_out_of_int64_range")
    if minimum is not None and value < minimum:
        raise InvalidData(f"{name}_below_minimum")
    if maximum is not None and value > maximum:
        raise InvalidData(f"{name}_above_maximum")
    return value

def need_str(value: Any, name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise InvalidData(f"{name}_must_be_string")
    out = unicodedata.normalize("NFC", value).strip()
    if not allow_empty and not out:
        raise InsufficientData(f"{name}_empty")
    return out

def need_list(value: Any, name: str, *, allow_empty: bool = False) -> list[Any]:
    if not isinstance(value, list):
        raise InvalidData(f"{name}_must_be_list")
    if not value and not allow_empty:
        raise InsufficientData(f"{name}_empty")
    return value

def need_str_list(value: Any, name: str, *, allow_empty: bool = False) -> list[str]:
    raw = need_list(value, name, allow_empty=allow_empty)
    out: list[str] = []
    for item in raw:
        text = need_str(item, f"{name}_item")
        out.append(text)
    return out

def bounded_ratio_ppm(numerator: int, denominator: int) -> int:
    numerator = need_int(numerator, "ratio_numerator", minimum=0)
    denominator = need_int(denominator, "ratio_denominator", minimum=1)
    if numerator > denominator:
        raise InvalidData("ratio_numerator_exceeds_denominator")
    return (numerator * PPM) // denominator

def capped_ratio_ppm(numerator: int, denominator: int) -> int:
    numerator = need_int(numerator, "ratio_numerator", minimum=0)
    denominator = need_int(denominator, "ratio_denominator", minimum=1)
    if numerator >= denominator:
        return PPM
    return (numerator * PPM) // denominator

def complement_ppm(value: int) -> int:
    value = need_int(value, "ppm", minimum=0, maximum=PPM)
    return PPM - value

def normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())

def tokens(value: Any) -> list[str]:
    text = normalize_text(value)
    return [t for t in _TOKEN_RE.findall(text) if t]

def normalize_phone(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    digits = "".join(ch for ch in unicodedata.normalize("NFC", value) if ch.isdecimal())
    return digits if 7 <= len(digits) <= 18 else ""

def canonical_url_or_path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw = unicodedata.normalize("NFC", value).strip()
    if not raw:
        return ""
    if raw.startswith("/"):
        path = re.sub(r"/{2,}", "/", raw.split("?", 1)[0])
        return path or "/"
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname.casefold().rstrip(".")
    port = parsed.port
    netloc = host if port is None else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return urlunsplit((parsed.scheme.casefold(), netloc, path, parsed.query, ""))

def phrase_tokens(value: Any) -> tuple[str, ...]:
    return tuple(tokens(value))

def config_phrases(config: Mapping[str, Any], key: str) -> tuple[tuple[str, ...], ...]:
    raw = config.get(key)
    if not isinstance(raw, list):
        raise InsufficientData(f"{key}_missing")
    phrases = sorted({phrase_tokens(v) for v in raw if phrase_tokens(v)})
    if not phrases:
        raise InsufficientData(f"{key}_empty")
    return tuple(phrases)

def contains_phrase(seq: Sequence[str], phrase: Sequence[str]) -> bool:
    width = len(phrase)
    if width == 0 or width > len(seq):
        return False
    target = tuple(phrase)
    return any(tuple(seq[i:i+width]) == target for i in range(len(seq)-width+1))

def contains_any_phrase(seq: Sequence[str], phrases: Sequence[Sequence[str]]) -> bool:
    return any(contains_phrase(seq, phrase) for phrase in phrases)

def all_phrase_tokens(phrases: Sequence[Sequence[str]]) -> set[str]:
    return {token for phrase in phrases for token in phrase}

def jaccard_ppm(left: Iterable[str], right: Iterable[str]) -> int:
    a = set(left)
    b = set(right)
    if not a and not b:
        raise InsufficientData("jaccard_empty_sets")
    return bounded_ratio_ppm(len(a & b), len(a | b))

def shingle_set(seq: Sequence[str], width: int) -> set[tuple[str, ...]]:
    width = need_int(width, "shingle_width", minimum=1, maximum=20)
    if len(seq) < width:
        return set()
    return {tuple(seq[i:i+width]) for i in range(len(seq)-width+1)}

def lower_median(values: Sequence[int]) -> int:
    if not values:
        raise InsufficientData("median_empty")
    ordered = sorted(values)
    return ordered[(len(ordered)-1)//2]

def gini_ppm(values: Sequence[int]) -> int:
    checked = [need_int(v, "gini_value", minimum=0) for v in values]
    checked = [v for v in checked if v > 0]
    if not checked:
        raise InsufficientData("gini_requires_positive_weight")
    ordered = sorted(checked)
    total = sum(ordered)
    n = len(ordered)
    numerator = 0
    for i, value in enumerate(ordered, start=1):
        numerator += (2*i - n - 1) * value
    if numerator < 0:
        numerator = -numerator
    denominator = n * total
    return min(PPM, (numerator * PPM) // denominator)

def normalize_search_records(value: Any) -> tuple[list[dict[str, Any]], int]:
    rows = need_list(value, "search_performance_records", allow_empty=True)
    out: list[dict[str, Any]] = []
    invalid = 0
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            invalid += 1
            continue
        query = normalize_text(row.get("query"))
        page = canonical_url_or_path(row.get("page_url"))
        try:
            clicks = need_int(row.get("clicks"), "clicks", minimum=0, maximum=100_000_000_000)
            impressions = need_int(row.get("impressions"), "impressions", minimum=0, maximum=100_000_000_000)
            position = need_int(row.get("average_position_milli"), "average_position_milli", minimum=1, maximum=1_000_000)
        except (InvalidData, InsufficientData):
            invalid += 1
            continue
        if not query or not page or clicks > impressions:
            invalid += 1
            continue
        item = {
            "query": query,
            "query_tokens": tokens(query),
            "page_url": page,
            "clicks": clicks,
            "impressions": impressions,
            "average_position_milli": position,
        }
        key = (query, page)
        prior = seen.get(key)
        if prior is None:
            seen[key] = item
        elif prior != item:
            raise InvalidData(f"conflicting_search_observation:{query}:{page}")
    out = [seen[key] for key in sorted(seen)]
    return out, invalid

def normalize_content_documents(value: Any) -> tuple[list[dict[str, Any]], int]:
    rows = need_list(value, "content_documents", allow_empty=True)
    out: list[dict[str, Any]] = []
    invalid = 0
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            invalid += 1
            continue
        document_id = canonical_url_or_path(row.get("document_id")) or normalize_text(row.get("document_id"))
        text = row.get("text")
        if not document_id or not isinstance(text, str):
            invalid += 1
            continue
        normalized = normalize_text(text)
        item = {
            "document_id": document_id,
            "text": normalized,
            "tokens": tokens(normalized),
            "content_hash": hash_value({"text": normalized}),
        }
        prior = seen.get(document_id)
        if prior is None:
            seen[document_id] = item
        elif prior["content_hash"] != item["content_hash"]:
            raise InvalidData(f"conflicting_content_document:{document_id}")
    return [seen[key] for key in sorted(seen)], invalid

def normalize_local_records(value: Any) -> tuple[list[dict[str, Any]], int]:
    rows = need_list(value, "local_business_records", allow_empty=True)
    out: list[dict[str, Any]] = []
    invalid = 0
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            invalid += 1
            continue
        source_id = normalize_text(row.get("source_id"))
        if not source_id:
            invalid += 1
            continue
        item: dict[str, Any] = {
            "source_id": source_id,
            "name": normalize_text(row.get("name")),
            "address": normalize_text(row.get("address")),
            "phone": normalize_phone(row.get("phone")),
        }
        for key in ("latitude_e6", "longitude_e6"):
            raw = row.get(key)
            if raw is None:
                item[key] = None
            else:
                try:
                    item[key] = need_int(raw, key, minimum=-180_000_000, maximum=180_000_000)
                except InvalidData:
                    invalid += 1
                    item[key] = None
        prior = seen.get(source_id)
        if prior is None:
            seen[source_id] = item
        elif prior != item:
            raise InvalidData(f"conflicting_local_source:{source_id}")
    return [seen[key] for key in sorted(seen)], invalid

def make_receipt(
    *,
    module_id: str,
    source_module: str,
    operation: str,
    family: str,
    raw_input: Any,
    normalized_input: Any,
    module_config: Mapping[str, Any],
    execution_status: str,
    finding_status: str,
    reason_code: str,
    output: Mapping[str, Any],
) -> Dict[str, Any]:
    if execution_status not in {"SUCCESS","INSUFFICIENT_DATA","ERROR"}:
        raise InvalidData("execution_status_invalid")
    if finding_status not in {"FINDING","NO_FINDING","NOT_APPLICABLE"}:
        raise InvalidData("finding_status_invalid")
    algorithm = f"avengers2500_v1_{module_id.lower()}_{operation}"
    body: Dict[str, Any] = {
        "module": module_id,
        "source_module": source_module,
        "family": family,
        "operation": operation,
        "algorithm": algorithm,
        "algorithm_version": 1,
        "schema_version": 1,
        "raw_input_hash": hash_value(raw_input) if raw_input is not None else None,
        "normalized_input_hash": hash_value(normalized_input) if normalized_input is not None else None,
        "module_config_hash": hash_value(module_config),
        "policy_status": "SAFE_WHITE_HAT",
        "action_mode": "OBSERVE_ONLY",
        "execution_status": execution_status,
        "finding_status": finding_status,
        "reason_code": reason_code,
        "output": dict(output),
    }
    body["evidence_hash"] = hash_value(body)
    return body

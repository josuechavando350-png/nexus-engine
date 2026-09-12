from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, canonical_url_or_path,
    config_phrases, contains_any_phrase, contains_phrase, need_int, normalize_text,
    tokens,
)

def threshold_for(spec: Mapping[str, Any], config: Mapping[str, Any]) -> int:
    module_id = str(spec["module_id"]).lower()
    key = f"{module_id}_threshold_ppm"
    raw = config.get(key, spec["threshold_ppm"])
    if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= PPM:
        raise InvalidData(f"{key}_invalid")
    return raw

def scope_rows(
    spec: Mapping[str, Any],
    normalized: Mapping[str, Any],
    config: Mapping[str, Any],
) -> list[dict[str, Any]]:
    rows = normalized["search_performance_records"]
    scope_config = str(spec["params"].get("scope_config", "none"))
    if scope_config == "none":
        return [dict(row) for row in rows]
    phrases = config_phrases(config, scope_config)
    return [dict(row) for row in rows if contains_any_phrase(row["query_tokens"], phrases)]

def docs_by_id(normalized: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in normalized["content_documents"]:
        document_id = canonical_url_or_path(row["document_id"]) or str(row["document_id"])
        out[document_id] = dict(row)
    return out

def query_families(config: Mapping[str, Any]) -> tuple[tuple[str, tuple[tuple[str, ...], ...]], ...]:
    keys = (
        ("commercial", "local_commercial_terms"),
        ("service", "local_service_terms"),
        ("location", "local_location_terms"),
        ("urgency", "local_urgency_terms"),
        ("question", "local_question_terms"),
        ("brand", "local_brand_terms"),
    )
    out = []
    for label, key in keys:
        try:
            phrases = config_phrases(config, key)
        except InsufficientData:
            continue
        out.append((label, phrases))
    if not out:
        raise InsufficientData("intent_family_config_empty")
    return tuple(out)

def page_identity_support(
    document: Mapping[str, Any],
    local_records: Sequence[Mapping[str, Any]],
) -> bool:
    if not local_records:
        return False
    doc_tokens = document["tokens"]
    doc_text = str(document["text"])
    for row in local_records:
        name_tokens = tokens(row.get("name"))
        address_tokens = tokens(row.get("address"))
        phone = str(row.get("phone") or "")
        name_ok = bool(name_tokens) and contains_phrase(doc_tokens, name_tokens)
        address_ok = bool(address_tokens) and contains_phrase(doc_tokens, address_tokens)
        phone_digits = "".join(ch for ch in doc_text if ch.isdecimal())
        phone_ok = bool(phone) and phone in phone_digits
        if name_ok and (address_ok or phone_ok):
            return True
    return False

def normalize_funnel_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise InvalidData("revenue_funnel_records_must_be_list")
    out: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(value):
        if not isinstance(row, Mapping):
            raise InvalidData(f"revenue_funnel_record_not_mapping:{index}")
        source_id = normalize_text(row.get("source_id"))
        if not source_id:
            raise InvalidData(f"revenue_funnel_source_id_missing:{index}")
        sessions = need_int(row.get("sessions"), "sessions", minimum=0, maximum=1_000_000_000_000)
        lead = need_int(row.get("lead_conversion_ppm"), "lead_conversion_ppm", minimum=0, maximum=PPM)
        close = need_int(row.get("close_rate_ppm"), "close_rate_ppm", minimum=0, maximum=PPM)
        ticket = need_int(row.get("average_ticket_micros"), "average_ticket_micros", minimum=0, maximum=9_000_000_000_000_000)
        item = {
            "source_id": source_id,
            "sessions": sessions,
            "lead_conversion_ppm": lead,
            "close_rate_ppm": close,
            "average_ticket_micros": ticket,
        }
        prior = out.get(source_id)
        if prior is None:
            out[source_id] = item
        elif prior != item:
            raise InvalidData(f"conflicting_funnel_source:{source_id}")
    return [out[key] for key in sorted(out)]

def selected_funnel_rows(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows = normalize_funnel_records(normalized["revenue_funnel_records"])
    raw_ids = config.get("organic_funnel_source_ids")
    if not isinstance(raw_ids, list):
        raise InsufficientData("organic_funnel_source_ids_missing")
    wanted = {normalize_text(value) for value in raw_ids if normalize_text(value)}
    if not wanted:
        raise InsufficientData("organic_funnel_source_ids_empty")
    selected = [row for row in rows if row["source_id"] in wanted]
    if not selected:
        raise InsufficientData("organic_funnel_rows_missing")
    return selected

def aggregate_funnel(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, int]:
    rows = selected_funnel_rows(normalized, config)
    sessions = sum(row["sessions"] for row in rows)
    if sessions <= 0:
        raise InsufficientData("organic_funnel_sessions_empty")
    weighted_lead = sum(row["sessions"] * row["lead_conversion_ppm"] for row in rows) // sessions
    weighted_close_numerator = sum(
        row["sessions"] * row["lead_conversion_ppm"] * row["close_rate_ppm"]
        for row in rows
    )
    lead_weight = sum(row["sessions"] * row["lead_conversion_ppm"] for row in rows)
    weighted_close = weighted_close_numerator // lead_weight if lead_weight > 0 else 0
    weighted_ticket_numerator = sum(
        row["sessions"] * row["lead_conversion_ppm"] * row["close_rate_ppm"] * row["average_ticket_micros"]
        for row in rows
    )
    close_weight = weighted_close_numerator
    weighted_ticket = weighted_ticket_numerator // close_weight if close_weight > 0 else 0
    composed = (weighted_lead * weighted_close) // PPM
    return {
        "sessions": sessions,
        "lead_conversion_ppm": weighted_lead,
        "close_rate_ppm": weighted_close,
        "composed_conversion_ppm": composed,
        "average_ticket_micros": weighted_ticket,
    }

def weighted_share(rows: Sequence[Mapping[str, Any]], selected: Sequence[Mapping[str, Any]], field: str) -> int:
    total = sum(int(row[field]) for row in rows)
    if total <= 0:
        raise InsufficientData(f"{field}_weight_empty")
    selected_total = sum(int(row[field]) for row in selected)
    if selected_total > total:
        raise InvalidData(f"{field}_selected_exceeds_total")
    return bounded_ratio_ppm(selected_total, total)

def group_by_page(rows: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        out[str(row["page_url"])].append(dict(row))
    return dict(out)

def group_by_query(rows: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        out[str(row["query"])].append(dict(row))
    return dict(out)

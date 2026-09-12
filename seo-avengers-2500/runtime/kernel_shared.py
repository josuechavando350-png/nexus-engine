from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, canonical_url_or_path,
    config_phrases, contains_any_phrase, contains_phrase, hash_value, jaccard_ppm,
    lower_median, normalize_text, phrase_tokens, shingle_set, tokens,
)


def _ctr_ppm(row: Mapping[str, Any]) -> int:
    impressions = int(row["impressions"])
    if impressions <= 0:
        raise InsufficientData("zero_impressions")
    return (int(row["clicks"]) * PPM) // impressions

def _phrases_for_spec(spec: Mapping[str, Any], config: Mapping[str, Any]) -> tuple[tuple[str, ...], ...]:
    keys = list(spec.get("config_terms", []))
    if not keys:
        return ()
    phrases: list[tuple[str, ...]] = []
    for key in keys:
        if key in {"local_service_groups", "local_location_groups"}:
            continue
        phrases.extend(config_phrases(config, key))
    deduped = sorted(set(phrases))
    return tuple(deduped)

def _filter_search_rows(rows: Sequence[Mapping[str, Any]], phrases: Sequence[Sequence[str]]) -> list[dict[str, Any]]:
    if not phrases:
        return [dict(row) for row in rows]
    return [dict(row) for row in rows if contains_any_phrase(row["query_tokens"], phrases)]

def _modal(values: Iterable[str]) -> tuple[str, int, int]:
    clean = [v for v in values if v]
    if not clean:
        raise InsufficientData("modal_values_empty")
    counts = Counter(clean)
    value, count = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    return value, count, len(clean)

def _record_field(record: Mapping[str, Any], field: str) -> str:
    if field == "phone":
        return str(record.get("phone") or "")
    value = record.get(field)
    return normalize_text(value) if isinstance(value, str) else ""

def _document_matches_field(document: Mapping[str, Any], field_value: str, field: str) -> bool:
    if not field_value:
        return False
    if field == "phone":
        digits = "".join(ch for ch in str(document.get("text","")) if ch.isdecimal())
        return field_value in digits
    field_tokens = tokens(field_value)
    doc_tokens = document["tokens"]
    if not field_tokens:
        return False
    return contains_phrase(doc_tokens, field_tokens)

def _select_scope_documents(
    documents: Sequence[Mapping[str, Any]],
    search_rows: Sequence[Mapping[str, Any]],
    scope: str,
    config: Mapping[str, Any],
) -> list[dict[str, Any]]:
    docs = {str(d["document_id"]): dict(d) for d in documents}
    if scope == "all":
        return [docs[key] for key in sorted(docs)]
    if scope == "top_demand":
        impressions_by_page: dict[str, int] = defaultdict(int)
        for row in search_rows:
            impressions_by_page[str(row["page_url"])] += int(row["impressions"])
        ranked = sorted(impressions_by_page.items(), key=lambda kv: (-kv[1], kv[0]))
        wanted = {page for page, _ in ranked[: max(1, min(10, len(ranked)))]}
        return [d for key,d in docs.items() if key in wanted or canonical_url_or_path(key) in wanted]
    scope_key = {
        "commercial":"local_commercial_terms",
        "service":"local_service_terms",
        "location":"local_location_terms",
    }.get(scope)
    if scope_key is None:
        raise InvalidData(f"unsupported_document_scope:{scope}")
    phrases = config_phrases(config, scope_key)
    wanted: set[str] = set()
    for row in search_rows:
        if contains_any_phrase(row["query_tokens"], phrases):
            wanted.add(str(row["page_url"]))
    return [d for key,d in docs.items() if key in wanted or canonical_url_or_path(key) in wanted]

def _service_location_groups(config: Mapping[str, Any], key: str) -> dict[str, tuple[tuple[str,...],...]]:
    raw = config.get(key)
    if not isinstance(raw, Mapping):
        raise InsufficientData(f"{key}_missing")
    out: dict[str, tuple[tuple[str,...],...]] = {}
    for group, values in raw.items():
        if not isinstance(group, str) or not isinstance(values, list):
            raise InvalidData(f"{key}_invalid_group")
        phrases = sorted({phrase_tokens(v) for v in values if phrase_tokens(v)})
        if phrases:
            out[normalize_text(group)] = tuple(phrases)
    if not out:
        raise InsufficientData(f"{key}_empty")
    return out

def _coord_distance(a,b):
    if a.get("latitude_e6") is None or a.get("longitude_e6") is None or b.get("latitude_e6") is None or b.get("longitude_e6") is None:
        return None
    return abs(a["latitude_e6"]-b["latitude_e6"])+abs(a["longitude_e6"]-b["longitude_e6"])

def _phrase_positions(seq, phrases):
    positions=[]
    for phrase in phrases:
        w=len(phrase)
        for i in range(max(0,len(seq)-w+1)):
            if tuple(seq[i:i+w])==tuple(phrase): positions.append(i)
    return positions

def _similar_pairs(docs, shingle_size, threshold, *, strip_terms=None):
    prepared=[]
    strip_terms=strip_terms or set()
    for d in docs:
        seq=[t for t in d["tokens"] if t not in strip_terms]
        shingles=shingle_set(seq,shingle_size)
        if shingles: prepared.append((d["document_id"],shingles))
    findings=[]
    for i,(a,sa) in enumerate(prepared):
        for b,sb in prepared[i+1:]:
            score=jaccard_ppm(sa,sb)
            if score>=threshold: findings.append({"document_a":a,"document_b":b,"similarity_ppm":score})
    findings.sort(key=lambda x:(-x["similarity_ppm"],x["document_a"],x["document_b"]))
    return findings, len(prepared)

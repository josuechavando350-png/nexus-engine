from __future__ import annotations

import re
import unicodedata
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

from .seo_avengers_1200 import (
    PPM_SCALE,
    canonical_hash,
    canonicalize_url_or_path,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
    normalize_text,
)


def _token_sequence(text: str) -> List[str]:
    normalized = unicodedata.normalize("NFC", text).casefold()
    return [token for token in re.findall(r"\w+", normalized, flags=re.UNICODE) if len(token) > 2]


def _normalize_phrase(value: Any) -> Optional[Tuple[str, ...]]:
    if not isinstance(value, str):
        return None
    tokens = tuple(_token_sequence(value))
    return tokens or None


def _contains_phrase(tokens: List[str], phrase: Tuple[str, ...]) -> bool:
    if not phrase or len(phrase) > len(tokens):
        return False
    width = len(phrase)
    return any(tuple(tokens[index:index + width]) == phrase for index in range(len(tokens) - width + 1))


def _signed_integer(value: Any, minimum: int, maximum: int) -> Optional[int]:
    if value is None or type(value) is bool or not isinstance(value, int):
        return None
    return value if minimum <= value <= maximum else None


def _normalize_phone(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value).strip()
    digits = "".join(ch for ch in normalized if ch.isdecimal())
    return digits if 7 <= len(digits) <= 18 else None


def _normalize_nap_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value).casefold()
    collapsed = " ".join(normalized.strip().split())
    return collapsed or None


def run_m601(documents: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Internal content similarity via deterministic token-shingle Jaccard PPM.

    This detector is intentionally batch-oriented. It never mutates content and
    never runs an embedding/provider call. Similarity means lexical shingle
    overlap under the declared tokenizer/shingle contract, nothing broader.
    """
    try:
        raw_hash = canonical_hash({"content_documents": documents})
    except (TypeError, ValueError):
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )

    if not isinstance(documents, list):
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    threshold = normalize_integer(config.get("m601_similarity_threshold_ppm", 850_000), PPM_SCALE)
    shingle_size = normalize_integer(config.get("m601_shingle_size", 5), 10)
    min_tokens = normalize_integer(config.get("m601_min_tokens", 20), 5_000)
    max_documents = normalize_integer(config.get("m601_max_documents", 500), 2_000)
    cfg_hash = canonical_hash({
        "similarity_threshold_ppm": threshold if threshold is not None else "INVALID",
        "shingle_size": shingle_size if shingle_size is not None else "INVALID",
        "min_tokens": min_tokens if min_tokens is not None else "INVALID",
        "max_documents": max_documents if max_documents is not None else "INVALID",
        "tokenizer": "unicode_nfc_casefold_word_len_gt_2_v1",
        "similarity": "jaccard_token_shingles_ppm",
    })
    if (
        threshold is None
        or shingle_size is None
        or shingle_size < 2
        or min_tokens is None
        or min_tokens < shingle_size
        or max_documents is None
        or max_documents < 2
    ):
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )
    if len(documents) > max_documents:
        norm_hash = canonical_hash({"input_document_count": len(documents)})
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
            "INPUT_DOCUMENT_LIMIT_EXCEEDED", {"input_document_count": len(documents)},
        )

    registry: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    duplicate_conflicts: List[Dict[str, str]] = []

    for row in documents:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        document_id = normalize_text(row.get("document_id"))
        text = row.get("text")
        if not document_id or not isinstance(text, str):
            invalid_count += 1
            continue
        normalized_text = " ".join(unicodedata.normalize("NFC", text).casefold().split())
        tokens = _token_sequence(normalized_text)
        content_hash = canonical_hash({"normalized_text": normalized_text})
        item = {
            "document_id": document_id,
            "content_hash": content_hash,
            "token_count": len(tokens),
            "tokens": tokens,
        }
        prior = registry.get(document_id)
        if prior is None:
            registry[document_id] = item
        elif prior["content_hash"] != content_hash:
            duplicate_conflicts.append({
                "document_id": document_id,
                "first_content_hash": prior["content_hash"],
                "conflicting_content_hash": content_hash,
            })

    duplicate_conflicts.sort(key=lambda item: (item["document_id"], item["first_content_hash"], item["conflicting_content_hash"]))
    dataset = [
        {
            "document_id": item["document_id"],
            "content_hash": item["content_hash"],
            "token_count": item["token_count"],
        }
        for _, item in sorted(registry.items())
    ]
    norm_hash = canonical_hash({
        "documents": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_document_conflicts": duplicate_conflicts,
    })

    if duplicate_conflicts:
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_DOCUMENT_CONFLICT",
            {
                "invalid_records_count": invalid_count,
                "duplicate_document_conflicts": duplicate_conflicts,
            },
        )

    analyzable: List[Tuple[str, Set[Tuple[str, ...]]]] = []
    insufficient_documents = 0
    for document_id, item in sorted(registry.items()):
        tokens = item["tokens"]
        if len(tokens) < min_tokens or len(tokens) < shingle_size:
            insufficient_documents += 1
            continue
        shingles = {
            tuple(tokens[index:index + shingle_size])
            for index in range(len(tokens) - shingle_size + 1)
        }
        if not shingles:
            insufficient_documents += 1
            continue
        analyzable.append((document_id, shingles))

    if len(analyzable) < 2:
        return compile_receipt(
            "M601", "internal_content_similarity_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
            "INSUFFICIENT_ANALYZABLE_DOCUMENT_PAIRS",
            {
                "valid_documents_count": len(registry),
                "analyzable_documents_count": len(analyzable),
                "insufficient_documents_count": insufficient_documents,
                "invalid_records_count": invalid_count,
            },
        )

    matches: List[Dict[str, Any]] = []
    analyzed_pairs = 0
    for left_index, (left_id, left_shingles) in enumerate(analyzable):
        for right_id, right_shingles in analyzable[left_index + 1:]:
            analyzed_pairs += 1
            union_count = len(left_shingles.union(right_shingles))
            intersection_count = len(left_shingles.intersection(right_shingles))
            similarity = div_round_half_even(intersection_count, union_count, PPM_SCALE)
            if similarity is None:
                return compile_receipt(
                    "M601", "internal_content_similarity_detector", 1, 1,
                    raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                    "ARITHMETIC_RANGE_EXCEEDED", {},
                )
            if similarity >= threshold:
                matches.append({
                    "document_a": left_id,
                    "document_b": right_id,
                    "jaccard_similarity_ppm": similarity,
                })

    matches.sort(key=lambda item: (-item["jaccard_similarity_ppm"], item["document_a"], item["document_b"]))
    output = {
        "similarity_scale": PPM_SCALE,
        "analyzable_documents_count": len(analyzable),
        "analyzed_pairs_count": analyzed_pairs,
        "insufficient_documents_count": insufficient_documents,
        "invalid_records_count": invalid_count,
        "similar_document_pairs": matches,
    }
    return compile_receipt(
        "M601", "internal_content_similarity_detector", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if matches else "NO_FINDING",
        "HIGH_INTERNAL_CONTENT_SIMILARITY_FOUND" if matches else "NO_HIGH_INTERNAL_CONTENT_SIMILARITY",
        output,
    )


def run_m602(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect review candidates from like-for-like historical traffic decay."""
    try:
        raw_hash = canonical_hash({"content_decay_records": records})
    except (TypeError, ValueError):
        return compile_receipt(
            "M602", "content_decay_review_candidate_detector", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(records, list):
        return compile_receipt(
            "M602", "content_decay_review_candidate_detector", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    threshold = normalize_integer(config.get("m602_min_decline_ppm", 300_000), PPM_SCALE)
    min_age_days = normalize_integer(config.get("m602_min_age_days", 60), 36_500)
    min_baseline_clicks = normalize_integer(config.get("m602_min_baseline_clicks", 10), 1_000_000_000)
    min_baseline_impressions = normalize_integer(config.get("m602_min_baseline_impressions", 100), 10_000_000_000)
    cfg_hash = canonical_hash({
        "min_decline_ppm": threshold if threshold is not None else "INVALID",
        "min_age_days": min_age_days if min_age_days is not None else "INVALID",
        "min_baseline_clicks": min_baseline_clicks if min_baseline_clicks is not None else "INVALID",
        "min_baseline_impressions": min_baseline_impressions if min_baseline_impressions is not None else "INVALID",
        "window_policy": "equal_duration_required",
    })
    if None in (threshold, min_age_days, min_baseline_clicks, min_baseline_impressions):
        return compile_receipt(
            "M602", "content_decay_review_candidate_detector", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )

    registry: Dict[str, Dict[str, int]] = {}
    invalid_count = 0
    duplicate_conflicts: List[str] = []

    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        document_id = normalize_text(row.get("document_id"))
        baseline_clicks = normalize_integer(row.get("baseline_clicks"), 10_000_000_000)
        current_clicks = normalize_integer(row.get("current_clicks"), 10_000_000_000)
        baseline_impressions = normalize_integer(row.get("baseline_impressions"), 100_000_000_000)
        current_impressions = normalize_integer(row.get("current_impressions"), 100_000_000_000)
        baseline_window_days = normalize_integer(row.get("baseline_window_days"), 3660)
        current_window_days = normalize_integer(row.get("current_window_days"), 3660)
        age_days = normalize_integer(row.get("age_days"), 36_500)
        values = (
            baseline_clicks,
            current_clicks,
            baseline_impressions,
            current_impressions,
            baseline_window_days,
            current_window_days,
            age_days,
        )
        if (
            not document_id
            or any(value is None for value in values)
            or baseline_window_days == 0
            or current_window_days == 0
            or baseline_window_days != current_window_days
        ):
            invalid_count += 1
            continue
        item = {
            "baseline_clicks": baseline_clicks,
            "current_clicks": current_clicks,
            "baseline_impressions": baseline_impressions,
            "current_impressions": current_impressions,
            "window_days": baseline_window_days,
            "age_days": age_days,
        }
        prior = registry.get(document_id)
        if prior is None:
            registry[document_id] = item
        elif prior != item:
            duplicate_conflicts.append(document_id)

    duplicate_conflicts = sorted(set(duplicate_conflicts))
    dataset = [
        {"document_id": document_id, **item}
        for document_id, item in sorted(registry.items())
    ]
    norm_hash = canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_document_conflicts": duplicate_conflicts,
    })
    if duplicate_conflicts:
        return compile_receipt(
            "M602", "content_decay_review_candidate_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_DECAY_RECORD_CONFLICT",
            {"duplicate_document_conflicts": duplicate_conflicts, "invalid_records_count": invalid_count},
        )

    candidates: List[Dict[str, Any]] = []
    analyzable_count = 0
    insufficient_baseline_count = 0
    for item in dataset:
        click_decline: Optional[int] = None
        impression_decline: Optional[int] = None
        if item["baseline_clicks"] >= min_baseline_clicks and item["baseline_clicks"] > 0:
            analyzable_count += 1
            click_drop = max(0, item["baseline_clicks"] - item["current_clicks"])
            click_decline = div_round_half_even(click_drop, item["baseline_clicks"], PPM_SCALE)
        if item["baseline_impressions"] >= min_baseline_impressions and item["baseline_impressions"] > 0:
            if click_decline is None:
                analyzable_count += 1
            impression_drop = max(0, item["baseline_impressions"] - item["current_impressions"])
            impression_decline = div_round_half_even(impression_drop, item["baseline_impressions"], PPM_SCALE)
        if click_decline is None and impression_decline is None:
            insufficient_baseline_count += 1
            continue
        if (click_decline is None and impression_decline is None) or (
            click_decline is not None and click_decline < 0
        ):
            return compile_receipt(
                "M602", "content_decay_review_candidate_detector", 1, 1,
                raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {},
            )
        signals = [value for value in (click_decline, impression_decline) if value is not None]
        strongest_decline = max(signals)
        if item["age_days"] >= min_age_days and strongest_decline >= threshold:
            candidates.append({
                "document_id": item["document_id"],
                "age_days": item["age_days"],
                "window_days": item["window_days"],
                "click_decline_ppm": click_decline,
                "impression_decline_ppm": impression_decline,
                "strongest_decline_ppm": strongest_decline,
                "review_recommended": True,
            })

    candidates.sort(key=lambda item: (-item["strongest_decline_ppm"], item["document_id"]))
    if analyzable_count == 0:
        return compile_receipt(
            "M602", "content_decay_review_candidate_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_BASELINE_TRAFFIC",
            {
                "valid_records_count": len(dataset),
                "insufficient_baseline_count": insufficient_baseline_count,
                "invalid_records_count": invalid_count,
            },
        )
    output = {
        "decline_scale": PPM_SCALE,
        "analyzable_records_count": analyzable_count,
        "insufficient_baseline_count": insufficient_baseline_count,
        "invalid_records_count": invalid_count,
        "review_candidates": candidates,
    }
    return compile_receipt(
        "M602", "content_decay_review_candidate_detector", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if candidates else "NO_FINDING",
        "CONTENT_DECAY_REVIEW_CANDIDATE_FOUND" if candidates else "NO_CONTENT_DECAY_REVIEW_CANDIDATE",
        output,
    )


class _EligibleTextLinkParser(HTMLParser):
    _NON_CONTENT_TAGS = {"script", "style", "noscript", "template"}

    def __init__(self, source_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.source_url = source_url
        self._stack: List[Tuple[str, bool]] = []
        self._hidden_depth = 0
        self.text_parts: List[str] = []
        self.link_hosts: Set[str] = set()

    @staticmethod
    def _is_hidden(tag: str, attrs: Dict[str, Optional[str]]) -> bool:
        if tag in _EligibleTextLinkParser._NON_CONTENT_TAGS:
            return True
        if "hidden" in attrs:
            return True
        if (attrs.get("aria-hidden") or "").strip().casefold() == "true":
            return True
        style = (attrs.get("style") or "").replace(" ", "").casefold()
        return "display:none" in style or "visibility:hidden" in style

    def handle_starttag(self, tag: str, attrs_list: List[Tuple[str, Optional[str]]]) -> None:
        tag = tag.casefold()
        attrs = {key.casefold(): value for key, value in attrs_list}
        hidden = self._is_hidden(tag, attrs)
        self._stack.append((tag, hidden))
        if hidden:
            self._hidden_depth += 1
        if tag == "a" and self._hidden_depth == 0:
            href = attrs.get("href")
            if isinstance(href, str) and href.strip():
                try:
                    resolved = urlparse(urljoin(self.source_url, href.strip()))
                    if resolved.scheme.lower() in {"http", "https"} and resolved.hostname:
                        self.link_hosts.add(resolved.hostname.lower().rstrip("."))
                except ValueError:
                    pass

    def handle_startendtag(self, tag: str, attrs_list: List[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs_list)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        while self._stack:
            open_tag, hidden = self._stack.pop()
            if hidden:
                self._hidden_depth = max(0, self._hidden_depth - 1)
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if self._hidden_depth == 0 and data.strip():
            self.text_parts.append(data)

    def result(self) -> Tuple[List[str], List[str]]:
        text = " ".join(self.text_parts)
        return _token_sequence(text), sorted(self.link_hosts)


def _normalize_host(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    raw = value.strip().casefold().rstrip(".")
    if not raw:
        return None
    try:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
        if not parsed.hostname:
            return None
        return parsed.hostname.casefold().rstrip(".")
    except ValueError:
        return None


def _host_is_owned(host: str, owned_hosts: Set[str]) -> bool:
    return any(host == owned or host.endswith("." + owned) for owned in owned_hosts)


def _prepare_external_pages(pages: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"external_pages": pages})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(pages, list):
        return raw_hash, [], 1, []

    registry: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in pages:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_url = canonicalize_url_or_path(row.get("source_url"))
        html = row.get("html")
        authority = normalize_integer(row.get("authority_score_ppm", 0), PPM_SCALE)
        if not source_url or not source_url.startswith(("http://", "https://")) or not isinstance(html, str) or authority is None:
            invalid_count += 1
            continue
        html_hash = canonical_hash({"html": unicodedata.normalize("NFC", html)})
        prior = registry.get(source_url)
        if prior is None:
            registry[source_url] = {
                "source_url": source_url,
                "html": html,
                "html_hash": html_hash,
                "authority_score_ppm": authority,
            }
        elif prior["html_hash"] != html_hash:
            conflicts.add(source_url)
        else:
            prior["authority_score_ppm"] = max(prior["authority_score_ppm"], authority)

    return raw_hash, [registry[key] for key in sorted(registry)], invalid_count, sorted(conflicts)


def run_m701(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Find external documents that mention the brand but contain no owned-host link."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt(
            "M701", "unlinked_brand_mention_detector", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(pages, list):
        return compile_receipt(
            "M701", "unlinked_brand_mention_detector", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    raw_brand_terms = config.get("m701_brand_terms", [])
    raw_owned_hosts = config.get("m701_owned_hosts", [])
    if not isinstance(raw_brand_terms, list) or not isinstance(raw_owned_hosts, list):
        brand_phrases: List[Tuple[str, ...]] = []
        owned_hosts: Set[str] = set()
    else:
        brand_phrases = sorted({phrase for value in raw_brand_terms if (phrase := _normalize_phrase(value))})
        owned_hosts = {host for value in raw_owned_hosts if (host := _normalize_host(value))}
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "owned_hosts": sorted(owned_hosts),
        "text_policy": "eligible_parser_text_v1",
        "link_policy": "document_has_owned_http_anchor_v1",
    })
    if not brand_phrases or not owned_hosts:
        return compile_receipt(
            "M701", "unlinked_brand_mention_detector", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )

    normalized_docs: List[Dict[str, Any]] = []
    candidates: List[Dict[str, Any]] = []
    analyzed_count = 0
    for item in prepared:
        source_host = _normalize_host(item["source_url"])
        if source_host and _host_is_owned(source_host, owned_hosts):
            continue
        parser = _EligibleTextLinkParser(item["source_url"])
        try:
            parser.feed(item["html"])
            parser.close()
        except Exception:
            invalid_count += 1
            continue
        tokens, link_hosts = parser.result()
        matched = [phrase for phrase in brand_phrases if _contains_phrase(tokens, phrase)]
        normalized_docs.append({
            "source_url": item["source_url"],
            "html_hash": item["html_hash"],
            "authority_score_ppm": item["authority_score_ppm"],
            "matched_brand_terms": [" ".join(phrase) for phrase in matched],
            "link_hosts": link_hosts,
        })
        analyzed_count += 1
        if matched and not any(_host_is_owned(host, owned_hosts) for host in link_hosts):
            candidates.append({
                "source_url": item["source_url"],
                "authority_score_ppm": item["authority_score_ppm"],
                "matched_brand_terms": [" ".join(phrase) for phrase in matched],
                "outreach_candidate": True,
            })

    normalized_docs.sort(key=lambda item: item["source_url"])
    candidates.sort(key=lambda item: (-item["authority_score_ppm"], item["source_url"]))
    norm_hash = canonical_hash({
        "documents": normalized_docs,
        "invalid_records_count": invalid_count,
        "duplicate_document_conflicts": conflicts,
    })
    if conflicts:
        return compile_receipt(
            "M701", "unlinked_brand_mention_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
            {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count},
        )
    if analyzed_count == 0:
        return compile_receipt(
            "M701", "unlinked_brand_mention_detector", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_EXTERNAL_DOCUMENTS",
            {"invalid_records_count": invalid_count},
        )
    output = {
        "analyzed_documents_count": analyzed_count,
        "invalid_records_count": invalid_count,
        "unlinked_brand_mentions": candidates,
    }
    return compile_receipt(
        "M701", "unlinked_brand_mention_detector", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if candidates else "NO_FINDING",
        "UNLINKED_BRAND_MENTION_FOUND" if candidates else "NO_UNLINKED_BRAND_MENTIONS",
        output,
    )


def run_m702(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor brand mention share inside an explicitly supplied external corpus."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(pages, list):
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    raw_brand_terms = config.get("m702_brand_terms", [])
    raw_competitor_terms = config.get("m702_competitor_terms", [])
    min_sample = normalize_integer(config.get("m702_min_sample_documents", 10), 100_000)
    min_share = normalize_integer(config.get("m702_min_brand_share_ppm", 250_000), PPM_SCALE)
    brand_phrases = sorted({phrase for value in raw_brand_terms if (phrase := _normalize_phrase(value))}) if isinstance(raw_brand_terms, list) else []
    competitor_phrases = sorted({phrase for value in raw_competitor_terms if (phrase := _normalize_phrase(value))}) if isinstance(raw_competitor_terms, list) else []
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "competitor_terms": [list(phrase) for phrase in competitor_phrases],
        "min_sample_documents": min_sample if min_sample is not None else "INVALID",
        "min_brand_share_ppm": min_share if min_share is not None else "INVALID",
        "share_definition": "brand_mention_documents/relevant_tracked_mention_documents",
    })
    if not brand_phrases or not competitor_phrases or min_sample is None or min_sample < 1 or min_share is None:
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )

    normalized_docs: List[Dict[str, Any]] = []
    relevant_count = 0
    brand_count = 0
    for item in prepared:
        parser = _EligibleTextLinkParser(item["source_url"])
        try:
            parser.feed(item["html"])
            parser.close()
        except Exception:
            invalid_count += 1
            continue
        tokens, _ = parser.result()
        brand_mentioned = any(_contains_phrase(tokens, phrase) for phrase in brand_phrases)
        competitor_mentioned = any(_contains_phrase(tokens, phrase) for phrase in competitor_phrases)
        if brand_mentioned or competitor_mentioned:
            relevant_count += 1
            if brand_mentioned:
                brand_count += 1
        normalized_docs.append({
            "source_url": item["source_url"],
            "html_hash": item["html_hash"],
            "brand_mentioned": brand_mentioned,
            "competitor_mentioned": competitor_mentioned,
        })

    normalized_docs.sort(key=lambda item: item["source_url"])
    norm_hash = canonical_hash({
        "documents": normalized_docs,
        "invalid_records_count": invalid_count,
        "duplicate_document_conflicts": conflicts,
    })
    if conflicts:
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
            {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count},
        )
    if relevant_count < min_sample:
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_PROMINENCE_SAMPLE",
            {
                "relevant_sample_documents_count": relevant_count,
                "required_sample_documents_count": min_sample,
                "invalid_records_count": invalid_count,
            },
        )

    share = div_round_half_even(brand_count, relevant_count, PPM_SCALE)
    if share is None:
        return compile_receipt(
            "M702", "brand_prominence_share_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {},
        )
    low_share = share < min_share
    output = {
        "share_scale": PPM_SCALE,
        "relevant_sample_documents_count": relevant_count,
        "brand_mention_documents_count": brand_count,
        "corpus_brand_share_ppm": share,
        "invalid_records_count": invalid_count,
    }
    return compile_receipt(
        "M702", "brand_prominence_share_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if low_share else "NO_FINDING",
        "LOW_BRAND_PROMINENCE_SHARE_FOUND" if low_share else "BRAND_PROMINENCE_SHARE_WITHIN_POLICY",
        output,
    )


def run_m801(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Strict local NAP consistency against an explicit canonical business record."""
    try:
        raw_hash = canonical_hash({"local_business_records": records})
    except (TypeError, ValueError):
        return compile_receipt(
            "M801", "strict_local_nap_consistency_auditor", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(records, list):
        return compile_receipt(
            "M801", "strict_local_nap_consistency_auditor", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    canonical_nap = config.get("m801_canonical_nap")
    if isinstance(canonical_nap, dict):
        expected_name = _normalize_nap_text(canonical_nap.get("name"))
        expected_address = _normalize_nap_text(canonical_nap.get("address"))
        expected_phone = _normalize_phone(canonical_nap.get("phone"))
    else:
        expected_name = expected_address = expected_phone = None
    cfg_hash = canonical_hash({
        "canonical_name": expected_name if expected_name is not None else "INVALID",
        "canonical_address": expected_address if expected_address is not None else "INVALID",
        "canonical_phone_digits": expected_phone if expected_phone is not None else "INVALID",
        "comparison_policy": "strict_after_declared_normalization_v1",
    })
    if not expected_name or not expected_address or not expected_phone:
        return compile_receipt(
            "M801", "strict_local_nap_consistency_auditor", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )

    registry: Dict[str, Dict[str, str]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_id = normalize_text(row.get("source_id"))
        name = _normalize_nap_text(row.get("name"))
        address = _normalize_nap_text(row.get("address"))
        phone = _normalize_phone(row.get("phone"))
        if not source_id or not name or not address or not phone:
            invalid_count += 1
            continue
        item = {"name": name, "address": address, "phone_digits": phone}
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)

    dataset = [{"source_id": source_id, **item} for source_id, item in sorted(registry.items())]
    norm_hash = canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_source_conflicts": sorted(conflicts),
    })
    if conflicts:
        return compile_receipt(
            "M801", "strict_local_nap_consistency_auditor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_LOCAL_SOURCE_CONFLICT",
            {"duplicate_source_conflicts": sorted(conflicts), "invalid_records_count": invalid_count},
        )
    if not dataset:
        return compile_receipt(
            "M801", "strict_local_nap_consistency_auditor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_LOCAL_NAP_RECORDS",
            {"invalid_records_count": invalid_count},
        )

    mismatches: List[Dict[str, Any]] = []
    for item in dataset:
        fields: List[str] = []
        if item["name"] != expected_name:
            fields.append("name")
        if item["address"] != expected_address:
            fields.append("address")
        if item["phone_digits"] != expected_phone:
            fields.append("phone")
        if fields:
            mismatches.append({"source_id": item["source_id"], "mismatched_fields": fields})

    mismatches.sort(key=lambda item: item["source_id"])
    output = {
        "checked_sources_count": len(dataset),
        "invalid_records_count": invalid_count,
        "inconsistent_sources": mismatches,
    }
    return compile_receipt(
        "M801", "strict_local_nap_consistency_auditor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if mismatches else "NO_FINDING",
        "LOCAL_NAP_INCONSISTENCY_FOUND" if mismatches else "LOCAL_NAP_CONSISTENT",
        output,
    )


def run_m802(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """L1 deviation monitor in integer microdegrees; not a meter-distance claim."""
    try:
        raw_hash = canonical_hash({"local_business_records": records})
    except (TypeError, ValueError):
        return compile_receipt(
            "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
            None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(records, list):
        return compile_receipt(
            "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
            raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    reference_lat = _signed_integer(config.get("m802_reference_latitude_e6"), -90_000_000, 90_000_000)
    reference_lon = _signed_integer(config.get("m802_reference_longitude_e6"), -180_000_000, 180_000_000)
    max_deviation = normalize_integer(config.get("m802_max_l1_deviation_e6", 10_000), 540_000_000)
    cfg_hash = canonical_hash({
        "reference_latitude_e6": reference_lat if reference_lat is not None else "INVALID",
        "reference_longitude_e6": reference_lon if reference_lon is not None else "INVALID",
        "max_l1_deviation_e6": max_deviation if max_deviation is not None else "INVALID",
        "metric": "abs(lat_e6-ref_lat_e6)+abs(lon_e6-ref_lon_e6)",
    })
    if reference_lat is None or reference_lon is None or max_deviation is None:
        return compile_receipt(
            "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
            raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )

    registry: Dict[str, Tuple[int, int]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_id = normalize_text(row.get("source_id"))
        latitude = _signed_integer(row.get("latitude_e6"), -90_000_000, 90_000_000)
        longitude = _signed_integer(row.get("longitude_e6"), -180_000_000, 180_000_000)
        if not source_id or latitude is None or longitude is None:
            invalid_count += 1
            continue
        coords = (latitude, longitude)
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = coords
        elif prior != coords:
            conflicts.add(source_id)

    dataset = [
        {"source_id": source_id, "latitude_e6": coords[0], "longitude_e6": coords[1]}
        for source_id, coords in sorted(registry.items())
    ]
    norm_hash = canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_source_conflicts": sorted(conflicts),
    })
    if conflicts:
        return compile_receipt(
            "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING", "DUPLICATE_LOCAL_GEO_SOURCE_CONFLICT",
            {"duplicate_source_conflicts": sorted(conflicts), "invalid_records_count": invalid_count},
        )
    if not dataset:
        return compile_receipt(
            "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
            raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_LOCAL_GEO_RECORDS",
            {"invalid_records_count": invalid_count},
        )

    deviations: List[Dict[str, Any]] = []
    for item in dataset:
        deviation = abs(item["latitude_e6"] - reference_lat) + abs(item["longitude_e6"] - reference_lon)
        if deviation > max_deviation:
            deviations.append({
                "source_id": item["source_id"],
                "latitude_e6": item["latitude_e6"],
                "longitude_e6": item["longitude_e6"],
                "l1_deviation_e6": deviation,
            })

    deviations.sort(key=lambda item: (-item["l1_deviation_e6"], item["source_id"]))
    output = {
        "coordinate_scale": 1_000_000,
        "metric_unit": "microdegree_l1",
        "checked_sources_count": len(dataset),
        "invalid_records_count": invalid_count,
        "out_of_policy_sources": deviations,
    }
    return compile_receipt(
        "M802", "local_geolocation_l1_deviation_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if deviations else "NO_FINDING",
        "LOCAL_GEOLOCATION_DEVIATION_FOUND" if deviations else "LOCAL_GEOLOCATION_WITHIN_POLICY",
        output,
    )

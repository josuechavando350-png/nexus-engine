from __future__ import annotations

import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from .batch_203_504 import _checked_add
from .batch_601_802 import (
    _EligibleTextLinkParser,
    _contains_phrase,
    _host_is_owned,
    _normalize_host,
    _normalize_nap_text,
    _normalize_phone,
    _normalize_phrase,
    _prepare_external_pages,
    _signed_integer,
    _token_sequence,
)
from .seo_avengers_1200 import (
    PPM_SCALE,
    canonical_hash,
    canonicalize_url_or_path,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
    normalize_text,
)


def _prepare_content_documents(documents: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"content_documents": documents})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(documents, list):
        return raw_hash, [], 1, []

    registry: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
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
            "unique_token_count": len(set(tokens)),
        }
        prior = registry.get(document_id)
        if prior is None:
            registry[document_id] = item
        elif prior["content_hash"] != content_hash:
            conflicts.add(document_id)

    return raw_hash, [registry[key] for key in sorted(registry)], invalid_count, sorted(conflicts)


def run_m603(documents: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure per-document lexical breadth as unique eligible tokens over eligible tokens."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_content_documents(documents)
    if raw_hash is None:
        return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(documents, list):
        return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_tokens = normalize_integer(config.get("m603_min_tokens", 50), 100_000)
    min_breadth = normalize_integer(config.get("m603_min_unique_token_share_ppm", 300_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_tokens": min_tokens if min_tokens is not None else "INVALID",
        "min_unique_token_share_ppm": min_breadth if min_breadth is not None else "INVALID",
        "tokenizer": "unicode_nfc_casefold_word_len_gt_2_v1",
        "metric": "unique_eligible_tokens/eligible_tokens",
    })
    norm_hash = canonical_hash({"documents": dataset, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if min_tokens is None or min_tokens < 1 or min_breadth is None:
        return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "FINDING", "DUPLICATE_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["token_count"] < min_tokens or item["token_count"] == 0:
            continue
        analyzable += 1
        share = div_round_half_even(item["unique_token_count"], item["token_count"], PPM_SCALE)
        if share is None:
            return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        if share < min_breadth:
            findings.append({"document_id": item["document_id"], "token_count": item["token_count"],
                             "unique_token_count": item["unique_token_count"],
                             "unique_token_share_ppm": share, "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_CONTENT_TOKEN_SAMPLE",
                               {"valid_documents_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["unique_token_share_ppm"], -item["token_count"], item["document_id"]))
    return compile_receipt(
        "M603", "content_lexical_breadth_monitor", 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "LOW_CONTENT_LEXICAL_BREADTH_FOUND" if findings else "CONTENT_LEXICAL_BREADTH_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "analyzed_documents_count": analyzable,
         "invalid_records_count": invalid_count, "low_breadth_documents": findings},
    )


def run_m604(documents: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect documents materially shorter than the lower median of the supplied corpus."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_content_documents(documents)
    if raw_hash is None:
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(documents, list):
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_documents = normalize_integer(config.get("m604_min_documents", 3), 10_000)
    min_tokens = normalize_integer(config.get("m604_min_document_tokens", 10), 100_000)
    min_ratio = normalize_integer(config.get("m604_min_relative_length_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_documents": min_documents if min_documents is not None else "INVALID",
        "min_document_tokens": min_tokens if min_tokens is not None else "INVALID",
        "min_relative_length_ppm": min_ratio if min_ratio is not None else "INVALID",
        "reference": "lower_median_token_count",
    })
    norm_hash = canonical_hash({"documents": dataset, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if min_documents is None or min_documents < 2 or min_tokens is None or min_tokens < 1 or min_ratio is None:
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})

    analyzable = [item for item in dataset if item["token_count"] >= min_tokens]
    if len(analyzable) < min_documents:
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_CONTENT_CORPUS",
                               {"analyzable_documents_count": len(analyzable),
                                "invalid_records_count": invalid_count})
    counts = sorted(item["token_count"] for item in analyzable)
    median = counts[(len(counts) - 1) // 2]
    if median <= 0:
        return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MEDIAN_BASELINE", {})

    findings: List[Dict[str, Any]] = []
    for item in analyzable:
        ratio = div_round_half_even(item["token_count"], median, PPM_SCALE)
        if ratio is None:
            return compile_receipt("M604", "relative_content_length_outlier_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        if ratio < min_ratio:
            findings.append({"document_id": item["document_id"], "token_count": item["token_count"],
                             "relative_to_lower_median_ppm": ratio, "review_recommended": True})
    findings.sort(key=lambda item: (item["relative_to_lower_median_ppm"], item["token_count"], item["document_id"]))
    return compile_receipt(
        "M604", "relative_content_length_outlier_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS",
        "FINDING" if findings else "NO_FINDING",
        "SHORT_CONTENT_OUTLIER_FOUND" if findings else "CONTENT_LENGTH_DISTRIBUTION_WITHIN_POLICY",
        {"ratio_scale": PPM_SCALE, "analyzed_documents_count": len(analyzable),
         "lower_median_token_count": median, "invalid_records_count": invalid_count,
         "short_content_outliers": findings},
    )


def run_m703(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure owned-link coverage among external documents that explicitly mention the brand."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(pages, list):
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    raw_terms = config.get("m703_brand_terms", [])
    raw_hosts = config.get("m703_owned_hosts", [])
    min_mentions = normalize_integer(config.get("m703_min_mention_documents", 3), 100_000)
    min_share = normalize_integer(config.get("m703_min_linked_mention_share_ppm", 500_000), PPM_SCALE)
    brand_phrases = sorted({phrase for value in raw_terms if (phrase := _normalize_phrase(value))}) if isinstance(raw_terms, list) else []
    owned_hosts = {host for value in raw_hosts if (host := _normalize_host(value))} if isinstance(raw_hosts, list) else set()
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "owned_hosts": sorted(owned_hosts),
        "min_mention_documents": min_mentions if min_mentions is not None else "INVALID",
        "min_linked_mention_share_ppm": min_share if min_share is not None else "INVALID",
        "link_policy": "eligible_http_anchor_to_owned_host_v1",
    })
    if not brand_phrases or not owned_hosts or min_mentions is None or min_mentions < 1 or min_share is None:
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1,
                               raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})

    normalized_docs: List[Dict[str, Any]] = []
    mention_count = 0
    linked_count = 0
    unlinked: List[str] = []
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
        mentioned = any(_contains_phrase(tokens, phrase) for phrase in brand_phrases)
        linked = mentioned and any(_host_is_owned(host, owned_hosts) for host in link_hosts)
        normalized_docs.append({"source_url": item["source_url"], "html_hash": item["html_hash"],
                                "brand_mentioned": mentioned, "owned_link_present": linked})
        if mentioned:
            mention_count += 1
            if linked:
                linked_count += 1
            else:
                unlinked.append(item["source_url"])

    normalized_docs.sort(key=lambda item: item["source_url"])
    unlinked.sort()
    norm_hash = canonical_hash({"documents": normalized_docs, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if conflicts:
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})
    if mention_count < min_mentions:
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_BRAND_MENTION_SAMPLE",
                               {"brand_mention_documents_count": mention_count,
                                "invalid_records_count": invalid_count})
    share = div_round_half_even(linked_count, mention_count, PPM_SCALE)
    if share is None:
        return compile_receipt("M703", "linked_brand_mention_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    return compile_receipt(
        "M703", "linked_brand_mention_coverage_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low else "NO_FINDING",
        "LINKED_BRAND_MENTION_COVERAGE_LOW" if low else "LINKED_BRAND_MENTION_COVERAGE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "brand_mention_documents_count": mention_count,
         "linked_brand_mention_documents_count": linked_count,
         "linked_mention_share_ppm": share, "unlinked_mention_sources": unlinked,
         "invalid_records_count": invalid_count},
    )


def run_m704(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure authority-score-weighted brand presence in a tracked brand/competitor corpus."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(pages, list):
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    raw_brand = config.get("m704_brand_terms", [])
    raw_competitors = config.get("m704_competitor_terms", [])
    min_authority = normalize_integer(config.get("m704_min_relevant_authority_ppm", 1), 100_000_000_000)
    min_share = normalize_integer(config.get("m704_min_weighted_brand_share_ppm", 250_000), PPM_SCALE)
    brand_phrases = sorted({phrase for value in raw_brand if (phrase := _normalize_phrase(value))}) if isinstance(raw_brand, list) else []
    competitor_phrases = sorted({phrase for value in raw_competitors if (phrase := _normalize_phrase(value))}) if isinstance(raw_competitors, list) else []
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "competitor_terms": [list(phrase) for phrase in competitor_phrases],
        "min_relevant_authority_ppm": min_authority if min_authority is not None else "INVALID",
        "min_weighted_brand_share_ppm": min_share if min_share is not None else "INVALID",
        "weight": "authority_score_ppm",
    })
    if not brand_phrases or not competitor_phrases or min_authority is None or min_share is None:
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                               raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})

    normalized_docs: List[Dict[str, Any]] = []
    relevant_authority = 0
    brand_authority = 0
    relevant_docs = 0
    for item in prepared:
        parser = _EligibleTextLinkParser(item["source_url"])
        try:
            parser.feed(item["html"])
            parser.close()
        except Exception:
            invalid_count += 1
            continue
        tokens, _ = parser.result()
        brand = any(_contains_phrase(tokens, phrase) for phrase in brand_phrases)
        competitor = any(_contains_phrase(tokens, phrase) for phrase in competitor_phrases)
        normalized_docs.append({"source_url": item["source_url"], "html_hash": item["html_hash"],
                                "authority_score_ppm": item["authority_score_ppm"],
                                "brand_mentioned": brand, "competitor_mentioned": competitor})
        if not (brand or competitor):
            continue
        relevant_docs += 1
        next_relevant = _checked_add(relevant_authority, item["authority_score_ppm"])
        if next_relevant is None:
            return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                                   raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        relevant_authority = next_relevant
        if brand:
            next_brand = _checked_add(brand_authority, item["authority_score_ppm"])
            if next_brand is None:
                return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                                       raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                       "ARITHMETIC_RANGE_EXCEEDED", {})
            brand_authority = next_brand

    normalized_docs.sort(key=lambda item: item["source_url"])
    norm_hash = canonical_hash({"documents": normalized_docs, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if conflicts:
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})
    if relevant_authority < min_authority or relevant_authority == 0:
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_AUTHORITY_WEIGHTED_CORPUS",
                               {"relevant_documents_count": relevant_docs,
                                "relevant_authority_ppm": relevant_authority,
                                "invalid_records_count": invalid_count})
    share = div_round_half_even(brand_authority, relevant_authority, PPM_SCALE)
    if share is None:
        return compile_receipt("M704", "authority_weighted_brand_presence_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    return compile_receipt(
        "M704", "authority_weighted_brand_presence_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low else "NO_FINDING",
        "AUTHORITY_WEIGHTED_BRAND_PRESENCE_LOW" if low else "AUTHORITY_WEIGHTED_BRAND_PRESENCE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "relevant_documents_count": relevant_docs,
         "relevant_authority_ppm": relevant_authority, "brand_authority_ppm": brand_authority,
         "weighted_brand_share_ppm": share, "invalid_records_count": invalid_count},
    )


def _prepare_local_listing_records(records: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    try:
        raw_hash = canonical_hash({"local_business_records": records})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(records, list):
        return raw_hash, [], 1, []
    registry: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    conflicts: Set[str] = set()
    for row in records:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        source_id = normalize_text(row.get("source_id"))
        if not source_id:
            invalid_count += 1
            continue
        item = {
            "name": _normalize_nap_text(row.get("name")),
            "address": _normalize_nap_text(row.get("address")),
            "phone_digits": _normalize_phone(row.get("phone")),
            "latitude_e6": _signed_integer(row.get("latitude_e6"), -90_000_000, 90_000_000),
            "longitude_e6": _signed_integer(row.get("longitude_e6"), -180_000_000, 180_000_000),
        }
        prior = registry.get(source_id)
        if prior is None:
            registry[source_id] = item
        elif prior != item:
            conflicts.add(source_id)
    return raw_hash, [{"source_id": key, **registry[key]} for key in sorted(registry)], invalid_count, sorted(conflicts)


def run_m803(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Audit NAP+coordinate field-presence coverage across explicitly supplied local sources."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_local_listing_records(records)
    if raw_hash is None:
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_sources = normalize_integer(config.get("m803_min_sources", 2), 100_000)
    min_complete_share = normalize_integer(config.get("m803_min_complete_source_share_ppm", 800_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_sources": min_sources if min_sources is not None else "INVALID",
        "min_complete_source_share_ppm": min_complete_share if min_complete_share is not None else "INVALID",
        "required_fields": ["name", "address", "phone", "latitude_e6", "longitude_e6"],
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sources is None or min_sources < 1 or min_complete_share is None:
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_LOCAL_SOURCE_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})
    if len(dataset) < min_sources:
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_LOCAL_SOURCE_SAMPLE",
                               {"valid_sources_count": len(dataset), "invalid_records_count": invalid_count})

    incomplete: List[Dict[str, Any]] = []
    complete_count = 0
    for item in dataset:
        missing: List[str] = []
        if not item["name"]:
            missing.append("name")
        if not item["address"]:
            missing.append("address")
        if not item["phone_digits"]:
            missing.append("phone")
        if item["latitude_e6"] is None:
            missing.append("latitude_e6")
        if item["longitude_e6"] is None:
            missing.append("longitude_e6")
        if missing:
            incomplete.append({"source_id": item["source_id"], "missing_fields": missing})
        else:
            complete_count += 1
    share = div_round_half_even(complete_count, len(dataset), PPM_SCALE)
    if share is None:
        return compile_receipt("M803", "local_listing_field_completeness_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_complete_share
    incomplete.sort(key=lambda item: item["source_id"])
    return compile_receipt(
        "M803", "local_listing_field_completeness_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low else "NO_FINDING",
        "LOCAL_LISTING_COMPLETENESS_LOW" if low else "LOCAL_LISTING_COMPLETENESS_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "checked_sources_count": len(dataset),
         "complete_sources_count": complete_count, "complete_source_share_ppm": share,
         "incomplete_sources": incomplete, "invalid_records_count": invalid_count},
    )


def run_m804(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure maximum pairwise coordinate disagreement in integer microdegree L1 units."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_local_listing_records(records)
    if raw_hash is None:
        return compile_receipt("M804", "local_coordinate_consensus_spread_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M804", "local_coordinate_consensus_spread_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_sources = normalize_integer(config.get("m804_min_coordinate_sources", 2), 100_000)
    max_spread = normalize_integer(config.get("m804_max_pairwise_l1_spread_e6", 10_000), 540_000_000)
    cfg_hash = canonical_hash({
        "min_coordinate_sources": min_sources if min_sources is not None else "INVALID",
        "max_pairwise_l1_spread_e6": max_spread if max_spread is not None else "INVALID",
        "metric": "max_pairwise_abs_lat_e6_plus_abs_lon_e6",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sources is None or min_sources < 2 or max_spread is None:
        return compile_receipt("M804", "local_coordinate_consensus_spread_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M804", "local_coordinate_consensus_spread_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_LOCAL_SOURCE_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    coordinates = [item for item in dataset if item["latitude_e6"] is not None and item["longitude_e6"] is not None]
    missing_coordinates_count = len(dataset) - len(coordinates)
    if len(coordinates) < min_sources:
        return compile_receipt("M804", "local_coordinate_consensus_spread_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_LOCAL_COORDINATE_SAMPLE",
                               {"coordinate_sources_count": len(coordinates),
                                "missing_coordinate_sources_count": missing_coordinates_count,
                                "invalid_records_count": invalid_count})
    max_observed = -1
    max_pair: Optional[Tuple[str, str]] = None
    for left_index, left in enumerate(coordinates):
        for right in coordinates[left_index + 1:]:
            spread = abs(left["latitude_e6"] - right["latitude_e6"]) + abs(left["longitude_e6"] - right["longitude_e6"])
            pair = tuple(sorted((left["source_id"], right["source_id"])))
            if spread > max_observed or (spread == max_observed and (max_pair is None or pair < max_pair)):
                max_observed = spread
                max_pair = pair
    high = max_observed > max_spread
    return compile_receipt(
        "M804", "local_coordinate_consensus_spread_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "LOCAL_COORDINATE_CONSENSUS_SPREAD_HIGH" if high else "LOCAL_COORDINATE_CONSENSUS_WITHIN_POLICY",
        {"metric_unit": "microdegree_l1", "coordinate_sources_count": len(coordinates),
         "missing_coordinate_sources_count": missing_coordinates_count,
         "max_pairwise_l1_spread_e6": max_observed,
         "max_spread_source_pair": list(max_pair) if max_pair else [],
         "invalid_records_count": invalid_count},
    )


def _normalize_alt_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value).casefold()
    collapsed = " ".join(normalized.strip().split())
    return collapsed or None


def _prepare_image_occurrences(images: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[Dict[str, str]]]:
    try:
        raw_hash = canonical_hash({"site_images_data": images})
    except (TypeError, ValueError):
        return None, [], 1, []
    if not isinstance(images, list):
        return raw_hash, [], 1, []
    registry: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    invalid_count = 0
    conflicts: List[Dict[str, str]] = []
    for row in images:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        image_url = canonicalize_url_or_path(row.get("image_url"))
        page_url = canonicalize_url_or_path(row.get("page_url_context"))
        if not image_url or not page_url:
            invalid_count += 1
            continue
        occurrence = normalize_text(row.get("occurrence_id"))
        identity = occurrence or "PAGE_IMAGE_FALLBACK"
        key = (image_url, page_url, identity)
        item = {
            "image_url": image_url,
            "page_url_context": page_url,
            "occurrence_id": occurrence,
            "alt_text_normalized": _normalize_alt_text(row.get("alt_text")),
        }
        prior = registry.get(key)
        if prior is None:
            registry[key] = item
        elif prior != item:
            conflicts.append({"image_url": image_url, "page_url_context": page_url,
                              "occurrence_identity": identity})
    conflicts.sort(key=lambda item: (item["image_url"], item["page_url_context"], item["occurrence_identity"]))
    dataset = [registry[key] for key in sorted(registry)]
    return raw_hash, dataset, invalid_count, conflicts


def run_m1003(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure non-empty alt-text presence across unique image/page occurrences."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_image_occurrences(images)
    if raw_hash is None:
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(images, list):
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_occurrences = normalize_integer(config.get("m1003_min_occurrences", 1), 100_000)
    min_share = normalize_integer(config.get("m1003_min_alt_presence_share_ppm", 900_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_occurrences": min_occurrences if min_occurrences is not None else "INVALID",
        "min_alt_presence_share_ppm": min_share if min_share is not None else "INVALID",
        "identity_policy": "occurrence_id_else_page_image_pair",
        "metric": "non_empty_alt_occurrences/all_valid_occurrences",
    })
    norm_hash = canonical_hash({"occurrences": dataset, "invalid_records_count": invalid_count,
                                "duplicate_occurrence_conflicts": conflicts})
    if min_occurrences is None or min_occurrences < 1 or min_share is None:
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_IMAGE_OCCURRENCE_CONFLICT",
                               {"duplicate_occurrence_conflicts": conflicts,
                                "invalid_records_count": invalid_count})
    if len(dataset) < min_occurrences:
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_IMAGE_OCCURRENCES",
                               {"valid_occurrences_count": len(dataset), "invalid_records_count": invalid_count})
    present = sum(1 for item in dataset if item["alt_text_normalized"])
    share = div_round_half_even(present, len(dataset), PPM_SCALE)
    if share is None:
        return compile_receipt("M1003", "image_alt_presence_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    missing = [
        {"image_url": item["image_url"], "page_url_context": item["page_url_context"],
         "occurrence_id": item["occurrence_id"]}
        for item in dataset if not item["alt_text_normalized"]
    ]
    return compile_receipt(
        "M1003", "image_alt_presence_coverage_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low else "NO_FINDING",
        "IMAGE_ALT_PRESENCE_COVERAGE_LOW" if low else "IMAGE_ALT_PRESENCE_COVERAGE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "checked_occurrences_count": len(dataset),
         "alt_present_occurrences_count": present, "alt_presence_share_ppm": share,
         "missing_alt_occurrences": missing, "invalid_records_count": invalid_count},
    )


def run_m1004(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect identical normalized alt text reused across distinct image assets."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_image_occurrences(images)
    if raw_hash is None:
        return compile_receipt("M1004", "duplicate_alt_text_across_assets_detector", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(images, list):
        return compile_receipt("M1004", "duplicate_alt_text_across_assets_detector", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_assets = normalize_integer(config.get("m1004_min_distinct_images_per_alt", 2), 100_000)
    min_tokens = normalize_integer(config.get("m1004_min_alt_tokens", 2), 1000)
    cfg_hash = canonical_hash({
        "min_distinct_images_per_alt": min_assets if min_assets is not None else "INVALID",
        "min_alt_tokens": min_tokens if min_tokens is not None else "INVALID",
        "normalization": "unicode_nfc_casefold_whitespace_v1",
        "asset_identity": "canonical_image_url",
    })
    norm_hash = canonical_hash({"occurrences": dataset, "invalid_records_count": invalid_count,
                                "duplicate_occurrence_conflicts": conflicts})
    if min_assets is None or min_assets < 2 or min_tokens is None or min_tokens < 1:
        return compile_receipt("M1004", "duplicate_alt_text_across_assets_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M1004", "duplicate_alt_text_across_assets_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_IMAGE_OCCURRENCE_CONFLICT",
                               {"duplicate_occurrence_conflicts": conflicts,
                                "invalid_records_count": invalid_count})

    by_alt: Dict[str, Set[str]] = {}
    analyzable_assets: Set[str] = set()
    for item in dataset:
        alt = item["alt_text_normalized"]
        if not alt or len(_token_sequence(alt)) < min_tokens:
            continue
        analyzable_assets.add(item["image_url"])
        by_alt.setdefault(alt, set()).add(item["image_url"])
    if len(analyzable_assets) < min_assets:
        return compile_receipt("M1004", "duplicate_alt_text_across_assets_detector", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_ALT_TEXT_ASSET_SAMPLE",
                               {"analyzable_distinct_images_count": len(analyzable_assets),
                                "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    for alt in sorted(by_alt):
        images_for_alt = sorted(by_alt[alt])
        if len(images_for_alt) >= min_assets:
            findings.append({"normalized_alt_text": alt,
                             "distinct_image_count": len(images_for_alt),
                             "image_urls": images_for_alt,
                             "review_recommended": True})
    findings.sort(key=lambda item: (-item["distinct_image_count"], item["normalized_alt_text"]))
    return compile_receipt(
        "M1004", "duplicate_alt_text_across_assets_detector", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "DUPLICATE_ALT_TEXT_ACROSS_ASSETS_FOUND" if findings else "ALT_TEXT_REUSE_WITHIN_POLICY",
        {"analyzable_distinct_images_count": len(analyzable_assets),
         "invalid_records_count": invalid_count, "duplicate_alt_groups": findings},
    )

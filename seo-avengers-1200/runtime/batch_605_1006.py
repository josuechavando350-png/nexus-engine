from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

from .batch_203_504 import _checked_add
from .batch_601_802 import (
    _EligibleTextLinkParser,
    _contains_phrase,
    _host_is_owned,
    _normalize_host,
    _normalize_phrase,
    _prepare_external_pages,
    _token_sequence,
)
from .batch_603_1004 import (
    _prepare_content_documents,
    _prepare_image_occurrences,
    _prepare_local_listing_records,
)
from .seo_avengers_1200 import (
    PPM_SCALE,
    canonical_hash,
    compile_receipt,
    div_round_half_even,
    normalize_integer,
)


def _document_token_rows(documents: Any) -> Tuple[Optional[str], List[Dict[str, Any]], int, List[str]]:
    """Prepare content rows while retaining deterministic token frequencies."""
    raw_hash, summary, invalid_count, conflicts = _prepare_content_documents(documents)
    if raw_hash is None or not isinstance(documents, list):
        return raw_hash, summary, invalid_count, conflicts

    # `_prepare_content_documents` already validates identity/content conflict.
    # Rebuild token counts only for the accepted document ids and verify the same
    # normalized content hash before use, so this helper cannot silently diverge.
    accepted = {item["document_id"]: item["content_hash"] for item in summary}
    registry: Dict[str, Dict[str, Any]] = {}
    for row in documents:
        if not isinstance(row, dict):
            continue
        document_id = row.get("document_id")
        text = row.get("text")
        if not isinstance(document_id, str) or not isinstance(text, str):
            continue
        # Match the normalization contract through the prepared summary rather
        # than treating a second parser as an independent source of truth.
        import unicodedata
        clean_id = unicodedata.normalize("NFC", document_id).strip()
        if clean_id not in accepted:
            continue
        normalized_text = " ".join(unicodedata.normalize("NFC", text).casefold().split())
        if canonical_hash({"normalized_text": normalized_text}) != accepted[clean_id]:
            continue
        tokens = _token_sequence(normalized_text)
        prior = registry.get(clean_id)
        if prior is None:
            registry[clean_id] = {
                "document_id": clean_id,
                "token_count": len(tokens),
                "token_counts": sorted(Counter(tokens).items()),
            }
    return raw_hash, [registry[key] for key in sorted(registry)], invalid_count, conflicts


def run_m605(documents: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Monitor the largest single-token share in each explicit content document."""
    raw_hash, dataset, invalid_count, conflicts = _document_token_rows(documents)
    if raw_hash is None:
        return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(documents, list):
        return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_tokens = normalize_integer(config.get("m605_min_tokens", 50), 100_000)
    max_share = normalize_integer(config.get("m605_max_dominant_token_share_ppm", 150_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_tokens": min_tokens if min_tokens is not None else "INVALID",
        "max_dominant_token_share_ppm": max_share if max_share is not None else "INVALID",
        "tokenizer": "unicode_nfc_casefold_word_len_gt_2_v1",
        "metric": "max_token_frequency/eligible_token_count",
    })
    norm_hash = canonical_hash({"documents": dataset, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if min_tokens is None or min_tokens < 1 or max_share is None:
        return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})

    findings: List[Dict[str, Any]] = []
    analyzable = 0
    for item in dataset:
        if item["token_count"] < min_tokens or item["token_count"] == 0:
            continue
        analyzable += 1
        ranked = sorted(item["token_counts"], key=lambda pair: (-pair[1], pair[0]))
        dominant_token, dominant_count = ranked[0]
        share = div_round_half_even(dominant_count, item["token_count"], PPM_SCALE)
        if share is None:
            return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        if share > max_share:
            findings.append({"document_id": item["document_id"], "token_count": item["token_count"],
                             "dominant_token": dominant_token, "dominant_token_count": dominant_count,
                             "dominant_token_share_ppm": share, "review_recommended": True})
    if analyzable == 0:
        return compile_receipt("M605", "dominant_token_concentration_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_CONTENT_TOKEN_SAMPLE",
                               {"valid_documents_count": len(dataset), "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (-item["dominant_token_share_ppm"], item["document_id"], item["dominant_token"]))
    return compile_receipt(
        "M605", "dominant_token_concentration_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "DOMINANT_TOKEN_CONCENTRATION_HIGH" if findings else "DOMINANT_TOKEN_CONCENTRATION_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "analyzed_documents_count": analyzable,
         "invalid_records_count": invalid_count, "high_concentration_documents": findings},
    )


def run_m606(documents: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure corpus token-count mean absolute deviation relative to its mean."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_content_documents(documents)
    if raw_hash is None:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(documents, list):
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    min_documents = normalize_integer(config.get("m606_min_documents", 3), 10_000)
    min_tokens = normalize_integer(config.get("m606_min_document_tokens", 10), 100_000)
    max_dispersion = normalize_integer(config.get("m606_max_relative_mad_ppm", 500_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_documents": min_documents if min_documents is not None else "INVALID",
        "min_document_tokens": min_tokens if min_tokens is not None else "INVALID",
        "max_relative_mad_ppm": max_dispersion if max_dispersion is not None else "INVALID",
        "metric": "mean_absolute_deviation_of_token_counts_over_mean_ppm",
    })
    norm_hash = canonical_hash({"documents": dataset, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if min_documents is None or min_documents < 2 or min_tokens is None or min_tokens < 1 or max_dispersion is None:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})
    counts = [item["token_count"] for item in dataset if item["token_count"] >= min_tokens]
    if len(counts) < min_documents:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_CONTENT_CORPUS",
                               {"analyzable_documents_count": len(counts), "invalid_records_count": invalid_count})

    total = sum(counts)
    count = len(counts)
    if total <= 0:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_CONTENT_LENGTH_BASELINE", {})
    # MAD/mean = sum(|x*n-total|) / (n*total), avoiding floats.
    scaled_abs_dev = sum(abs(value * count - total) for value in counts)
    denominator = count * total
    dispersion = div_round_half_even(scaled_abs_dev, denominator, PPM_SCALE)
    if dispersion is None:
        return compile_receipt("M606", "content_length_dispersion_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = dispersion > max_dispersion
    return compile_receipt(
        "M606", "content_length_dispersion_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "CONTENT_LENGTH_DISPERSION_HIGH" if high else "CONTENT_LENGTH_DISPERSION_WITHIN_POLICY",
        {"dispersion_scale": PPM_SCALE, "analyzed_documents_count": count,
         "total_tokens": total, "relative_mad_ppm": dispersion,
         "invalid_records_count": invalid_count},
    )


def run_m705(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure brand/competitor co-mention share in an explicit tracked external corpus."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(pages, list):
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    raw_brand = config.get("m705_brand_terms", [])
    raw_competitors = config.get("m705_competitor_terms", [])
    min_sample = normalize_integer(config.get("m705_min_relevant_documents", 3), 100_000)
    max_share = normalize_integer(config.get("m705_max_comention_share_ppm", 500_000), PPM_SCALE)
    brand_phrases = sorted({phrase for value in raw_brand if (phrase := _normalize_phrase(value))}) if isinstance(raw_brand, list) else []
    competitor_phrases = sorted({phrase for value in raw_competitors if (phrase := _normalize_phrase(value))}) if isinstance(raw_competitors, list) else []
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "competitor_terms": [list(phrase) for phrase in competitor_phrases],
        "min_relevant_documents": min_sample if min_sample is not None else "INVALID",
        "max_comention_share_ppm": max_share if max_share is not None else "INVALID",
        "denominator": "documents_mentioning_brand_or_tracked_competitor",
    })
    if not brand_phrases or not competitor_phrases or min_sample is None or min_sample < 1 or max_share is None:
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1,
                               raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})

    normalized_docs: List[Dict[str, Any]] = []
    relevant = 0
    comention = 0
    sources: List[str] = []
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
                                "brand_mentioned": brand, "competitor_mentioned": competitor})
        if brand or competitor:
            relevant += 1
        if brand and competitor:
            comention += 1
            sources.append(item["source_url"])
    normalized_docs.sort(key=lambda item: item["source_url"])
    sources.sort()
    norm_hash = canonical_hash({"documents": normalized_docs, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if conflicts:
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})
    if relevant < min_sample:
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_COMENTION_SAMPLE",
                               {"relevant_documents_count": relevant, "invalid_records_count": invalid_count})
    share = div_round_half_even(comention, relevant, PPM_SCALE)
    if share is None:
        return compile_receipt("M705", "brand_competitor_comention_share_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    high = share > max_share
    return compile_receipt(
        "M705", "brand_competitor_comention_share_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "BRAND_COMPETITOR_COMENTION_SHARE_HIGH" if high else "BRAND_COMPETITOR_COMENTION_SHARE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "relevant_documents_count": relevant,
         "comention_documents_count": comention, "comention_share_ppm": share,
         "comention_sources": sources, "invalid_records_count": invalid_count},
    )


def run_m706(pages: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure authority-weighted owned-link coverage among explicit brand-mention documents."""
    raw_hash, prepared, invalid_count, conflicts = _prepare_external_pages(pages)
    if raw_hash is None:
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               None, None, None, "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(pages, list):
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               raw_hash, None, None, "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})

    raw_brand = config.get("m706_brand_terms", [])
    raw_hosts = config.get("m706_owned_hosts", [])
    min_weight = normalize_integer(config.get("m706_min_brand_mention_authority_ppm", 1), 100_000_000_000)
    min_share = normalize_integer(config.get("m706_min_weighted_link_coverage_ppm", 500_000), PPM_SCALE)
    brand_phrases = sorted({phrase for value in raw_brand if (phrase := _normalize_phrase(value))}) if isinstance(raw_brand, list) else []
    owned_hosts = {host for value in raw_hosts if (host := _normalize_host(value))} if isinstance(raw_hosts, list) else set()
    cfg_hash = canonical_hash({
        "brand_terms": [list(phrase) for phrase in brand_phrases],
        "owned_hosts": sorted(owned_hosts),
        "min_brand_mention_authority_ppm": min_weight if min_weight is not None else "INVALID",
        "min_weighted_link_coverage_ppm": min_share if min_share is not None else "INVALID",
        "weight": "authority_score_ppm",
    })
    if not brand_phrases or not owned_hosts or min_weight is None or min_share is None:
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})

    normalized_docs: List[Dict[str, Any]] = []
    mention_authority = 0
    linked_authority = 0
    mention_documents = 0
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
                                "authority_score_ppm": item["authority_score_ppm"],
                                "brand_mentioned": mentioned, "owned_link_present": linked})
        if not mentioned:
            continue
        mention_documents += 1
        next_mention = _checked_add(mention_authority, item["authority_score_ppm"])
        if next_mention is None:
            return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                                   raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        mention_authority = next_mention
        if linked:
            next_linked = _checked_add(linked_authority, item["authority_score_ppm"])
            if next_linked is None:
                return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                                       raw_hash, None, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                       "ARITHMETIC_RANGE_EXCEEDED", {})
            linked_authority = next_linked

    normalized_docs.sort(key=lambda item: item["source_url"])
    norm_hash = canonical_hash({"documents": normalized_docs, "invalid_records_count": invalid_count,
                                "duplicate_document_conflicts": conflicts})
    if conflicts:
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_EXTERNAL_DOCUMENT_CONFLICT",
                               {"duplicate_document_conflicts": conflicts, "invalid_records_count": invalid_count})
    if mention_authority == 0 or mention_authority < min_weight:
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_BRAND_MENTION_AUTHORITY",
                               {"brand_mention_documents_count": mention_documents,
                                "brand_mention_authority_ppm": mention_authority,
                                "invalid_records_count": invalid_count})
    share = div_round_half_even(linked_authority, mention_authority, PPM_SCALE)
    if share is None:
        return compile_receipt("M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "ARITHMETIC_RANGE_EXCEEDED", {})
    low = share < min_share
    return compile_receipt(
        "M706", "authority_weighted_linked_brand_coverage_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low else "NO_FINDING",
        "AUTHORITY_WEIGHTED_LINKED_BRAND_COVERAGE_LOW" if low else "AUTHORITY_WEIGHTED_LINKED_BRAND_COVERAGE_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "brand_mention_documents_count": mention_documents,
         "brand_mention_authority_ppm": mention_authority, "linked_brand_authority_ppm": linked_authority,
         "weighted_link_coverage_ppm": share, "invalid_records_count": invalid_count},
    )


def run_m805(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure modal consensus for normalized NAP fields without requiring a canonical record."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_local_listing_records(records)
    if raw_hash is None:
        return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_sources = normalize_integer(config.get("m805_min_sources_per_field", 2), 100_000)
    min_consensus = normalize_integer(config.get("m805_min_modal_consensus_ppm", 800_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_sources_per_field": min_sources if min_sources is not None else "INVALID",
        "min_modal_consensus_ppm": min_consensus if min_consensus is not None else "INVALID",
        "fields": ["name", "address", "phone_digits"],
        "tie_policy": "lexicographically_smallest_value",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sources is None or min_sources < 2 or min_consensus is None:
        return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_LOCAL_SOURCE_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})

    field_results: List[Dict[str, Any]] = []
    low_fields: List[Dict[str, Any]] = []
    for field in ("name", "address", "phone_digits"):
        values = [item[field] for item in dataset if item[field]]
        if len(values) < min_sources:
            continue
        counts = Counter(values)
        modal_count = max(counts.values())
        modal_value = min(value for value, count in counts.items() if count == modal_count)
        share = div_round_half_even(modal_count, len(values), PPM_SCALE)
        if share is None:
            return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1,
                                   raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                                   "ARITHMETIC_RANGE_EXCEEDED", {})
        result = {"field": field, "observed_sources_count": len(values), "modal_value": modal_value,
                  "modal_sources_count": modal_count, "modal_consensus_ppm": share}
        field_results.append(result)
        if share < min_consensus:
            low_fields.append(result)
    if not field_results:
        return compile_receipt("M805", "local_nap_modal_consensus_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_LOCAL_NAP_CONSENSUS_SAMPLE",
                               {"valid_sources_count": len(dataset), "invalid_records_count": invalid_count})
    field_results.sort(key=lambda item: item["field"])
    low_fields.sort(key=lambda item: (item["modal_consensus_ppm"], item["field"]))
    return compile_receipt(
        "M805", "local_nap_modal_consensus_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if low_fields else "NO_FINDING",
        "LOCAL_NAP_MODAL_CONSENSUS_LOW" if low_fields else "LOCAL_NAP_MODAL_CONSENSUS_WITHIN_POLICY",
        {"share_scale": PPM_SCALE, "field_consensus": field_results,
         "low_consensus_fields": low_fields, "invalid_records_count": invalid_count},
    )


def run_m806(records: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Measure maximum L1 microdegree deviation from a component-wise lower median coordinate."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_local_listing_records(records)
    if raw_hash is None:
        return compile_receipt("M806", "local_coordinate_median_deviation_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(records, list):
        return compile_receipt("M806", "local_coordinate_median_deviation_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_sources = normalize_integer(config.get("m806_min_coordinate_sources", 3), 100_000)
    max_deviation = normalize_integer(config.get("m806_max_l1_median_deviation_e6", 10_000), 540_000_000)
    cfg_hash = canonical_hash({
        "min_coordinate_sources": min_sources if min_sources is not None else "INVALID",
        "max_l1_median_deviation_e6": max_deviation if max_deviation is not None else "INVALID",
        "center": "component_wise_lower_median",
        "metric": "abs(lat_e6-median_lat_e6)+abs(lon_e6-median_lon_e6)",
    })
    norm_hash = canonical_hash({"records": dataset, "invalid_records_count": invalid_count,
                                "duplicate_source_conflicts": conflicts})
    if min_sources is None or min_sources < 2 or max_deviation is None:
        return compile_receipt("M806", "local_coordinate_median_deviation_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M806", "local_coordinate_median_deviation_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_LOCAL_SOURCE_CONFLICT",
                               {"duplicate_source_conflicts": conflicts, "invalid_records_count": invalid_count})
    coordinates = [item for item in dataset if item["latitude_e6"] is not None and item["longitude_e6"] is not None]
    if len(coordinates) < min_sources:
        return compile_receipt("M806", "local_coordinate_median_deviation_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_LOCAL_COORDINATE_SAMPLE",
                               {"coordinate_sources_count": len(coordinates), "invalid_records_count": invalid_count})
    lats = sorted(item["latitude_e6"] for item in coordinates)
    lons = sorted(item["longitude_e6"] for item in coordinates)
    median_lat = lats[(len(lats) - 1) // 2]
    median_lon = lons[(len(lons) - 1) // 2]
    deviations = [
        {"source_id": item["source_id"],
         "l1_median_deviation_e6": abs(item["latitude_e6"] - median_lat) + abs(item["longitude_e6"] - median_lon)}
        for item in coordinates
    ]
    deviations.sort(key=lambda item: (-item["l1_median_deviation_e6"], item["source_id"]))
    max_observed = deviations[0]["l1_median_deviation_e6"]
    high = max_observed > max_deviation
    outliers = [item for item in deviations if item["l1_median_deviation_e6"] > max_deviation]
    return compile_receipt(
        "M806", "local_coordinate_median_deviation_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if high else "NO_FINDING",
        "LOCAL_COORDINATE_MEDIAN_DEVIATION_HIGH" if high else "LOCAL_COORDINATE_MEDIAN_DEVIATION_WITHIN_POLICY",
        {"metric_unit": "microdegree_l1", "coordinate_sources_count": len(coordinates),
         "median_latitude_e6": median_lat, "median_longitude_e6": median_lon,
         "max_l1_median_deviation_e6": max_observed, "out_of_policy_sources": outliers,
         "invalid_records_count": invalid_count},
    )


def run_m1005(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Detect image assets reused across more distinct page contexts than policy allows."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_image_occurrences(images)
    if raw_hash is None:
        return compile_receipt("M1005", "image_asset_page_reuse_monitor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(images, list):
        return compile_receipt("M1005", "image_asset_page_reuse_monitor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_occurrences = normalize_integer(config.get("m1005_min_occurrences", 2), 100_000)
    max_pages = normalize_integer(config.get("m1005_max_distinct_pages_per_image", 5), 100_000)
    cfg_hash = canonical_hash({
        "min_occurrences": min_occurrences if min_occurrences is not None else "INVALID",
        "max_distinct_pages_per_image": max_pages if max_pages is not None else "INVALID",
        "asset_identity": "canonical_image_url",
        "page_identity": "canonical_page_url",
    })
    norm_hash = canonical_hash({"occurrences": dataset, "invalid_records_count": invalid_count,
                                "duplicate_occurrence_conflicts": conflicts})
    if min_occurrences is None or min_occurrences < 1 or max_pages is None or max_pages < 1:
        return compile_receipt("M1005", "image_asset_page_reuse_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M1005", "image_asset_page_reuse_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_IMAGE_OCCURRENCE_CONFLICT",
                               {"duplicate_occurrence_conflicts": conflicts, "invalid_records_count": invalid_count})
    if len(dataset) < min_occurrences:
        return compile_receipt("M1005", "image_asset_page_reuse_monitor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_IMAGE_OCCURRENCES",
                               {"valid_occurrences_count": len(dataset), "invalid_records_count": invalid_count})
    pages_by_image: Dict[str, set[str]] = {}
    for item in dataset:
        pages_by_image.setdefault(item["image_url"], set()).add(item["page_url_context"])
    findings = [
        {"image_url": image_url, "distinct_page_count": len(pages), "page_urls": sorted(pages),
         "review_recommended": True}
        for image_url, pages in pages_by_image.items() if len(pages) > max_pages
    ]
    findings.sort(key=lambda item: (-item["distinct_page_count"], item["image_url"]))
    return compile_receipt(
        "M1005", "image_asset_page_reuse_monitor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "IMAGE_ASSET_PAGE_REUSE_HIGH" if findings else "IMAGE_ASSET_PAGE_REUSE_WITHIN_POLICY",
        {"checked_distinct_images_count": len(pages_by_image), "invalid_records_count": invalid_count,
         "high_reuse_assets": findings},
    )


def run_m1006(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    """Audit token-count bounds for non-empty alt text without claiming accessibility compliance."""
    raw_hash, dataset, invalid_count, conflicts = _prepare_image_occurrences(images)
    if raw_hash is None:
        return compile_receipt("M1006", "image_alt_token_count_bounds_auditor", 1, 1, None, None, None,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if not isinstance(images, list):
        return compile_receipt("M1006", "image_alt_token_count_bounds_auditor", 1, 1, raw_hash, None, None,
                               "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {})
    min_tokens = normalize_integer(config.get("m1006_min_alt_tokens", 2), 1000)
    max_tokens = normalize_integer(config.get("m1006_max_alt_tokens", 30), 1000)
    min_analyzable = normalize_integer(config.get("m1006_min_nonempty_alt_occurrences", 1), 100_000)
    cfg_hash = canonical_hash({
        "min_alt_tokens": min_tokens if min_tokens is not None else "INVALID",
        "max_alt_tokens": max_tokens if max_tokens is not None else "INVALID",
        "min_nonempty_alt_occurrences": min_analyzable if min_analyzable is not None else "INVALID",
        "tokenizer": "unicode_nfc_casefold_word_len_gt_2_v1",
    })
    norm_hash = canonical_hash({"occurrences": dataset, "invalid_records_count": invalid_count,
                                "duplicate_occurrence_conflicts": conflicts})
    if min_tokens is None or min_tokens < 1 or max_tokens is None or max_tokens < min_tokens or min_analyzable is None or min_analyzable < 1:
        return compile_receipt("M1006", "image_alt_token_count_bounds_auditor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "NOT_APPLICABLE",
                               "INVALID_MODULE_CONFIG", {})
    if conflicts:
        return compile_receipt("M1006", "image_alt_token_count_bounds_auditor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "ERROR", "FINDING",
                               "DUPLICATE_IMAGE_OCCURRENCE_CONFLICT",
                               {"duplicate_occurrence_conflicts": conflicts, "invalid_records_count": invalid_count})

    observations: List[Dict[str, Any]] = []
    findings: List[Dict[str, Any]] = []
    for item in dataset:
        alt = item["alt_text_normalized"]
        if not alt:
            continue
        token_count = len(_token_sequence(alt))
        observation = {"image_url": item["image_url"], "page_url_context": item["page_url_context"],
                       "occurrence_id": item["occurrence_id"], "alt_token_count": token_count}
        observations.append(observation)
        if token_count < min_tokens or token_count > max_tokens:
            findings.append({**observation,
                             "bound_violation": "BELOW_MIN" if token_count < min_tokens else "ABOVE_MAX",
                             "review_recommended": True})
    if len(observations) < min_analyzable:
        return compile_receipt("M1006", "image_alt_token_count_bounds_auditor", 1, 1,
                               raw_hash, norm_hash, cfg_hash, "INSUFFICIENT_DATA", "NOT_APPLICABLE",
                               "INSUFFICIENT_NONEMPTY_ALT_SAMPLE",
                               {"nonempty_alt_occurrences_count": len(observations),
                                "invalid_records_count": invalid_count})
    findings.sort(key=lambda item: (item["bound_violation"], item["alt_token_count"],
                                    item["image_url"], item["page_url_context"], item["occurrence_id"] or ""))
    return compile_receipt(
        "M1006", "image_alt_token_count_bounds_auditor", 1, 1,
        raw_hash, norm_hash, cfg_hash, "SUCCESS", "FINDING" if findings else "NO_FINDING",
        "IMAGE_ALT_TOKEN_COUNT_OUT_OF_BOUNDS" if findings else "IMAGE_ALT_TOKEN_COUNT_WITHIN_POLICY",
        {"analyzed_nonempty_alt_occurrences_count": len(observations),
         "invalid_records_count": invalid_count, "out_of_bounds_alt_occurrences": findings},
    )

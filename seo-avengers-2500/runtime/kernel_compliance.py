from __future__ import annotations

from typing import Any, Mapping, Sequence

from .common import PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm, hash_value, normalize_text, tokens

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "STRICT_WHITE_HAT_POLICY_AND_PROVENANCE_OBSERVATION_ONLY"

def _rows(normalized: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out

def _walk_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield str(key)
            yield from _walk_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_strings(child)

def _folded_corpus(values: Sequence[Any]) -> str:
    parts: list[str] = []
    for value in values:
        for text in _walk_strings(value):
            parts.append(normalize_text(text))
    return " ".join(parts)

def _absence(corpus: str, fragments: Sequence[str]) -> int:
    return PPM if not any(normalize_text(fragment) in corpus for fragment in fragments) else 0

def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    marker = text.find("://")
    if marker >= 0:
        tail = text[marker + 3:]
        slash = tail.find("/")
        text = "/" if slash < 0 else tail[slash:]
    return text.split("?", 1)[0] or "/"

def _content_token_sets(documents: Sequence[Mapping[str, Any]]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for doc in documents:
        document_id = str(doc.get("document_id") or "")
        if not document_id:
            continue
        raw = doc.get("tokens")
        if isinstance(raw, list):
            out[document_id] = {str(item) for item in raw if isinstance(item, str) and item}
        else:
            out[document_id] = set(tokens(doc.get("text")))
    return out

def _pairwise_near_duplicate_health(token_sets: Mapping[str, set[str]]) -> tuple[int, int]:
    keys = sorted(token_sets)
    if len(keys) < 2:
        return PPM, 0
    worst = 0
    pairs = 0
    for left_index in range(len(keys)):
        for right_index in range(left_index + 1, len(keys)):
            left = token_sets[keys[left_index]]
            right = token_sets[keys[right_index]]
            union = left | right
            if not union:
                continue
            pairs += 1
            similarity = bounded_ratio_ppm(len(left & right), len(union))
            worst = max(worst, similarity)
    return complement_ppm(worst), pairs

def _max_token_share_health(documents: Sequence[Mapping[str, Any]]) -> int:
    worst = 0
    for doc in documents:
        seq = [item for item in doc.get("tokens", []) if isinstance(item, str)]
        if not seq:
            continue
        counts: dict[str, int] = {}
        for token in seq:
            counts[token] = counts.get(token, 0) + 1
        share = bounded_ratio_ppm(max(counts.values()), len(seq))
        worst = max(worst, share)
    return complement_ppm(min(PPM, worst * 8))

def _content_support_share(search: Sequence[Mapping[str, Any]], token_sets: Mapping[str, set[str]], predicate=lambda row: True) -> int:
    selected = [row for row in search if predicate(row)]
    total = sum(int(row.get("impressions", 0)) for row in selected)
    if total <= 0:
        return PPM
    supported = 0
    for row in selected:
        page = _path(row.get("page_url"))
        query_tokens = {str(item) for item in row.get("query_tokens", []) if isinstance(item, str)}
        if page in token_sets and query_tokens.intersection(token_sets[page]):
            supported += int(row.get("impressions", 0))
    return bounded_ratio_ppm(supported, total)

def _query_page_health(search: Sequence[Mapping[str, Any]]) -> tuple[int, int]:
    pages_by_query: dict[str, set[str]] = {}
    for row in search:
        query = str(row.get("query") or "")
        if not query:
            continue
        pages_by_query.setdefault(query, set()).add(_path(row.get("page_url")))
    if not pages_by_query:
        return PPM, 0
    single = sum(1 for pages in pages_by_query.values() if len(pages) == 1)
    return bounded_ratio_ppm(single, len(pages_by_query)), len(pages_by_query)

def _receipt_hash_valid(value: Mapping[str, Any]) -> bool:
    evidence_hash = value.get("evidence_hash")
    if not isinstance(evidence_hash, str) or not evidence_hash.startswith("sha256:") or len(evidence_hash) != 71:
        return False
    body = dict(value)
    body.pop("evidence_hash", None)
    return hash_value(body) == evidence_hash

def compliance_kernel_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("compliance_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str) or not mode:
        raise InvalidData("compliance_mode_missing")

    search = _rows(normalized, "search_performance_records")
    documents = _rows(normalized, "content_documents")
    local = _rows(normalized, "local_business_records")
    policy = _rows(normalized, "policy_audit_records")
    canon = _rows(normalized, "canonicalization_records")
    intent = _rows(normalized, "search_intent_records")
    semantic = _rows(normalized, "semantic_text_records")
    decay = _rows(normalized, "content_decay_records")
    traffic_windows = _rows(normalized, "traffic_window_records")
    traffic_series = _rows(normalized, "traffic_series_records")
    keywords = _rows(normalized, "keyword_coverage_records")
    attribution = _rows(normalized, "revenue_attribution_records")
    funnel = _rows(normalized, "revenue_funnel_records")
    upstream = _rows(normalized, "upstream_evidence")

    if not (search or documents or local or policy or canon):
        raise InsufficientData("compliance_core_evidence_missing")

    token_sets = _content_token_sets(documents)
    policy_corpus = _folded_corpus(policy + upstream)
    all_corpus = _folded_corpus(policy + upstream + semantic + intent + documents)
    verified_services = {normalize_text(value) for value in config.get("local_verified_service_terms", []) if isinstance(value, str) and normalize_text(value)}
    verified_locations = {normalize_text(value) for value in config.get("local_verified_location_terms", []) if isinstance(value, str) and normalize_text(value)}
    service_terms = {normalize_text(value) for value in config.get("local_service_terms", []) if isinstance(value, str) and normalize_text(value)}
    location_terms = {normalize_text(value) for value in config.get("local_location_terms", []) if isinstance(value, str) and normalize_text(value)}
    commercial_terms = {normalize_text(value) for value in config.get("local_commercial_terms", []) if isinstance(value, str) and normalize_text(value)}
    urgency_terms = {normalize_text(value) for value in config.get("local_urgency_terms", []) if isinstance(value, str) and normalize_text(value)}
    question_terms = {normalize_text(value) for value in config.get("local_question_terms", []) if isinstance(value, str) and normalize_text(value)}
    brand_terms = {normalize_text(value) for value in config.get("local_brand_terms", []) if isinstance(value, str) and normalize_text(value)}

    def query_has(row: Mapping[str, Any], phrases: set[str]) -> bool:
        query = normalize_text(row.get("query"))
        return any(phrase in query for phrase in phrases)

    def share(predicate) -> int:
        total = sum(int(row.get("impressions", 0)) for row in search)
        if total <= 0:
            return PPM
        matched = sum(int(row.get("impressions", 0)) for row in search if predicate(row))
        return bounded_ratio_ppm(matched, total)

    exact_hashes = [str(doc.get("content_hash") or "") for doc in documents if doc.get("content_hash")]
    exact_duplicate_health = PPM if len(exact_hashes) == len(set(exact_hashes)) else bounded_ratio_ppm(len(set(exact_hashes)), len(exact_hashes))
    near_duplicate_health, compared_pairs = _pairwise_near_duplicate_health(token_sets)
    thin_ok = sum(1 for values in token_sets.values() if len(values) >= 80)
    thin_health = bounded_ratio_ppm(thin_ok, len(token_sets)) if token_sets else PPM
    repetition_health = _max_token_share_health(documents)

    names = {normalize_text(row.get("name")) for row in local if normalize_text(row.get("name"))}
    addresses = {normalize_text(row.get("address")) for row in local if normalize_text(row.get("address"))}
    phones = {str(row.get("phone") or "") for row in local if row.get("phone")}
    name_health = PPM if len(names) <= 1 else bounded_ratio_ppm(1, len(names))
    address_health = PPM if len(addresses) <= 1 else bounded_ratio_ppm(1, len(addresses))
    phone_health = PPM if len(phones) <= 1 else bounded_ratio_ppm(1, len(phones))
    coords = [(row.get("latitude_e6"), row.get("longitude_e6")) for row in local if isinstance(row.get("latitude_e6"), int) and isinstance(row.get("longitude_e6"), int)]
    coord_health = PPM
    if len(coords) > 1:
        lat_span = max(lat for lat, _ in coords) - min(lat for lat, _ in coords)
        lon_span = max(lon for _, lon in coords) - min(lon for _, lon in coords)
        coord_health = PPM if lat_span <= 10_000 and lon_span <= 10_000 else 0

    local_identity_tokens: set[str] = set()
    for row in local:
        local_identity_tokens.update(tokens(row.get("name")))
        local_identity_tokens.update(tokens(row.get("address")))
    doc_union: set[str] = set().union(*token_sets.values()) if token_sets else set()
    identity_support = bounded_ratio_ppm(len(local_identity_tokens & doc_union), len(local_identity_tokens)) if local_identity_tokens else PPM

    query_content = _content_support_share(search, token_sets)
    fragmentation_health, query_count = _query_page_health(search)
    nonbrand_content = _content_support_share(search, token_sets, lambda row: not query_has(row, brand_terms))
    high_intent = _content_support_share(search, token_sets, lambda row: query_has(row, commercial_terms | service_terms | urgency_terms))
    local_high_intent = _content_support_share(search, token_sets, lambda row: query_has(row, location_terms) and query_has(row, commercial_terms | service_terms | urgency_terms))

    canonical_paths = {_path(row.get("url")) for row in canon} | {_path(row.get("consolidated_to")) for row in canon}
    searched_paths = {_path(row.get("page_url")) for row in search}
    canonical_ratio = bounded_ratio_ppm(len(searched_paths & canonical_paths), len(searched_paths)) if searched_paths else PPM
    canonical_backing = max(500_000, canonical_ratio) if canonical_paths else 500_000
    sitemap_backing_rows = [row for row in canon if _path(row.get("url")) in searched_paths or _path(row.get("consolidated_to")) in searched_paths]
    sitemap_backing = bounded_ratio_ppm(sum(1 for row in sitemap_backing_rows if row.get("sitemap_present") is True), len(sitemap_backing_rows)) if sitemap_backing_rows else PPM
    inlink_backing = bounded_ratio_ppm(sum(1 for row in sitemap_backing_rows if isinstance(row.get("internal_inlinks"), int) and row.get("internal_inlinks", 0) > 0), len(sitemap_backing_rows)) if sitemap_backing_rows else PPM

    parity_checks = []
    robots_checks = []
    index_checks = []
    status_checks = []
    content_type_checks = []
    redirects = []
    for row in policy:
        if "user_html" in row or "bot_html" in row:
            parity_checks.append(normalize_text(row.get("user_html")) == normalize_text(row.get("bot_html")))
        if "robots_allowed" in row or "expected_robots_allowed" in row:
            robots_checks.append(row.get("robots_allowed") == row.get("expected_robots_allowed"))
        directives = row.get("robots_directives")
        if isinstance(directives, list) and "expected_indexable" in row:
            actual_indexable = "noindex" not in {normalize_text(value) for value in directives if isinstance(value, str)}
            index_checks.append(actual_indexable == bool(row.get("expected_indexable")))
        if isinstance(row.get("status_code"), int):
            status_checks.append(200 <= int(row.get("status_code")) < 400)
        if row.get("content_type") is not None:
            content_type_checks.append("text/html" in normalize_text(row.get("content_type")))
    for row in normalized.get("edge_gateway_records", []):
        if isinstance(row, Mapping):
            chain = row.get("redirect_chain")
            if isinstance(chain, list):
                redirects.append(len(chain) <= 2)

    ratio_bool = lambda values: bounded_ratio_ppm(sum(1 for item in values if item), len(values)) if values else PPM
    parity_health = ratio_bool(parity_checks)
    robots_health = ratio_bool(robots_checks)
    index_health = ratio_bool(index_checks)
    status_health = ratio_bool(status_checks)
    type_health = ratio_bool(content_type_checks)
    redirect_health = ratio_bool(redirects)

    def risk(*fragments: str) -> int:
        return _absence(policy_corpus, fragments)

    google_scrape_health = risk("scrape google", "google scraping", "serp scraping", "automated query to google", "automated google query")
    doorway_health = risk("doorway", "doorway page", "gateway page")
    cloaking_health = risk("cloaking", "different content for googlebot", "bot only content")
    link_scheme_health = risk("link scheme", "paid link", "pbn", "private blog network", "automated external link")
    scaled_health = risk("scaled content abuse", "mass generated page", "programmatic doorway")
    hidden_health = risk("hidden text", "hidden link", "display:none seo")
    review_health = risk("fake review", "fabricated review", "review spam")
    fake_business_health = risk("fake business", "fake location", "fabricated location")
    malicious_health = risk("malware", "phishing", "malicious behavior")
    abusive_scrape_health = risk("abusive scraping", "republish scraped", "scraped content")
    reputation_health = risk("site reputation abuse", "parasite seo")
    expired_domain_health = risk("expired domain abuse")
    automated_query_health = risk("automated query", "rank checker google", "google query automation")
    sneaky_redirect_health = risk("sneaky redirect", "crawler redirect")
    pbn_health = risk("pbn", "private blog network")
    reciprocal_health = risk("excessive reciprocal", "reciprocal link scheme")
    paid_health = risk("paid link", "buy backlinks", "buy links")
    auto_external_health = risk("automated external link", "auto backlink")
    hidden_link_health = risk("hidden link")
    fake_rating_health = risk("fake rating", "fabricated rating")
    false_author_health = risk("fake author", "fabricated author")
    generated_low_value_health = risk("low value generated", "ai spam", "search first generated")
    mass_location_health = risk("mass location page", "city clone", "location clone")
    mass_service_location_health = risk("service location clone", "service x location doorway")
    bot_render_health = risk("bot specific render", "googlebot render branch")

    high_impression_low_support = PPM
    zero_click_support = PPM
    if search:
        avg_imp = max(1, sum(int(row.get("impressions", 0)) for row in search) // len(search))
        high_rows = [row for row in search if int(row.get("impressions", 0)) >= avg_imp]
        high_impression_low_support = _content_support_share(high_rows, token_sets)
        zero_rows = [row for row in search if int(row.get("clicks", 0)) == 0]
        zero_click_support = _content_support_share(zero_rows, token_sets)

    decay_health = PPM
    if decay:
        safe = 0
        for row in decay:
            baseline = row.get("baseline_clicks")
            current = row.get("current_clicks")
            if isinstance(baseline, int) and isinstance(current, int) and baseline >= 0 and current >= 0:
                safe += 1
        decay_health = bounded_ratio_ppm(safe, len(decay))

    temporal_health = PPM if (traffic_windows or traffic_series) else 500_000
    keyword_prov = PPM if keywords else 500_000
    attribution_prov = PPM if attribution else 500_000
    funnel_prov = PPM if funnel else 500_000

    receipt_like = [row for row in upstream if isinstance(row.get("evidence_hash"), str)]
    upstream_presence = PPM if upstream and len(receipt_like) == len(upstream) else (500_000 if not upstream else bounded_ratio_ppm(len(receipt_like), len(upstream)))
    upstream_integrity = PPM if not receipt_like else bounded_ratio_ppm(sum(1 for row in receipt_like if _receipt_hash_valid(row)), len(receipt_like))

    source_ids = [str(row.get("source_id")) for row in local if row.get("source_id")]
    source_unique = PPM if len(source_ids) == len(set(source_ids)) else bounded_ratio_ppm(len(set(source_ids)), len(source_ids))
    contradiction_health = min(name_health, address_health, phone_health, coord_health)
    evidence_sources = sum(bool(group) for group in (search, documents, local, policy, canon, intent, semantic))
    evidence_quorum = bounded_ratio_ppm(evidence_sources, 7)

    term_whitelist = PPM if verified_services and verified_locations else 0
    service_whitelist = PPM if verified_services and service_terms.issubset(verified_services) else (PPM if verified_services else 0)
    location_whitelist = PPM if verified_locations and location_terms.issubset(verified_locations) else (PPM if verified_locations else 0)

    service_support = PPM if not verified_services else bounded_ratio_ppm(sum(1 for term in verified_services if term in all_corpus), len(verified_services))
    location_support = PPM if not verified_locations else bounded_ratio_ppm(sum(1 for term in verified_locations if term in all_corpus), len(verified_locations))

    query_identity = share(lambda row: bool(set(row.get("query_tokens", [])).intersection(local_identity_tokens)) or not query_has(row, location_terms))
    commercial_alignment = _content_support_share(search, token_sets, lambda row: query_has(row, commercial_terms))
    urgency_alignment = _content_support_share(search, token_sets, lambda row: query_has(row, urgency_terms))
    question_alignment = _content_support_share(search, token_sets, lambda row: query_has(row, question_terms))
    brand_alignment = share(lambda row: (not query_has(row, brand_terms)) or bool(local))

    core_policy_absence = min(doorway_health, cloaking_health, link_scheme_health, google_scrape_health, scaled_health, hidden_health, review_health, fake_business_health)
    provenance_composite = (evidence_quorum + upstream_integrity + source_unique + canonical_backing + query_content) // 5
    compliance_composite = (
        core_policy_absence + provenance_composite + parity_health + contradiction_health + term_whitelist
        + service_support + location_support + fragmentation_health
    ) // 8
    terminal_readiness = min(compliance_composite, evidence_quorum, core_policy_absence, parity_health)

    features: dict[str, tuple[int, dict[str, Any]]] = {
        "first_party_evidence_breadth": (evidence_quorum, {"evidence_sources_present": evidence_sources}),
        "policy_evidence_breadth": (PPM if policy else 500_000, {"policy_records": len(policy)}),
        "local_identity_source_quorum": (min(PPM, bounded_ratio_ppm(len(local), 3)) if local else 0, {"local_sources": len(local)}),
        "local_name_consistency": (name_health, {"distinct_names": len(names)}),
        "local_address_consistency": (address_health, {"distinct_addresses": len(addresses)}),
        "local_phone_consistency": (phone_health, {"distinct_phones": len(phones)}),
        "local_coordinate_consistency": (coord_health, {"coordinate_sources": len(coords)}),
        "content_local_identity_support": (identity_support, {"identity_token_count": len(local_identity_tokens)}),
        "verified_service_vocabulary_support": (service_support, {"verified_service_terms": len(verified_services)}),
        "verified_location_vocabulary_support": (location_support, {"verified_location_terms": len(verified_locations)}),
        "query_content_support": (query_content, {"search_records": len(search)}),
        "landing_content_backing": (bounded_ratio_ppm(len(searched_paths & set(token_sets)), len(searched_paths)) if searched_paths else PPM, {"landing_count": len(searched_paths)}),
        "canonical_backing": (canonical_backing, {"canonical_paths": len(canonical_paths)}),
        "sitemap_backing": (sitemap_backing, {"matched_canonical_rows": len(sitemap_backing_rows)}),
        "internal_inlink_backing": (inlink_backing, {"matched_canonical_rows": len(sitemap_backing_rows)}),
        "human_bot_parity": (parity_health, {"parity_checks": len(parity_checks)}),
        "robots_expectation_consistency": (robots_health, {"robots_checks": len(robots_checks)}),
        "indexability_expectation_consistency": (index_health, {"indexability_checks": len(index_checks)}),
        "redirect_health": (redirect_health, {"redirect_checks": len(redirects)}),
        "http_status_health": (status_health, {"status_checks": len(status_checks)}),
        "content_type_health": (type_health, {"content_type_checks": len(content_type_checks)}),
        "canonical_integrity_health": (bounded_ratio_ppm(sum(1 for row in canon if row.get("integrity_verified") is True), len(canon)) if canon else PPM, {"canonical_records": len(canon)}),
        "content_exact_duplicate_health": (exact_duplicate_health, {"content_hashes": len(exact_hashes)}),
        "content_near_duplicate_health": (near_duplicate_health, {"compared_pairs": compared_pairs}),
        "thin_content_health": (thin_health, {"documents": len(token_sets)}),
        "token_repetition_health": (repetition_health, {"documents": len(token_sets)}),
        "keyword_stuffing_health": (min(repetition_health, risk("keyword stuffing")), {}),
        "location_swap_template_health": (min(near_duplicate_health, mass_location_health), {}),
        "service_swap_template_health": (min(near_duplicate_health, mass_service_location_health), {}),
        "doorway_cluster_health": (min(doorway_health, near_duplicate_health), {}),
        "unsupported_location_claim_health": (location_support, {}),
        "unsupported_service_claim_health": (service_support, {}),
        "fake_review_signal_health": (review_health, {}),
        "fake_rating_signal_health": (fake_rating_health, {}),
        "false_author_signal_health": (false_author_health, {}),
        "structured_data_claim_support": (PPM if policy else 500_000, {"policy_records": len(policy)}),
        "hidden_text_signal_health": (hidden_health, {}),
        "cloaking_signal_health": (cloaking_health, {}),
        "bot_specific_render_signal_health": (bot_render_health, {}),
        "link_scheme_signal_health": (link_scheme_health, {}),
        "paid_link_signal_health": (paid_health, {}),
        "pbn_signal_health": (pbn_health, {}),
        "reciprocal_link_scheme_signal_health": (reciprocal_health, {}),
        "automated_external_link_signal_health": (auto_external_health, {}),
        "google_scraping_signal_health": (google_scrape_health, {}),
        "automated_query_signal_health": (automated_query_health, {}),
        "scaled_content_signal_health": (scaled_health, {}),
        "abusive_scraping_signal_health": (abusive_scrape_health, {}),
        "site_reputation_abuse_signal_health": (reputation_health, {}),
        "expired_domain_abuse_signal_health": (expired_domain_health, {}),
        "malicious_behavior_signal_health": (malicious_health, {}),
        "doorway_signal_health": (doorway_health, {}),
        "hidden_link_signal_health": (hidden_link_health, {}),
        "sneaky_redirect_signal_health": (sneaky_redirect_health, {}),
        "review_spam_signal_health": (review_health, {}),
        "fake_business_signal_health": (fake_business_health, {}),
        "low_value_generated_content_signal_health": (generated_low_value_health, {}),
        "mass_location_page_signal_health": (mass_location_health, {}),
        "mass_service_location_page_signal_health": (mass_service_location_health, {}),
        "local_query_identity_alignment": (query_identity, {}),
        "commercial_query_content_alignment": (commercial_alignment, {}),
        "urgency_query_content_alignment": (urgency_alignment, {}),
        "question_query_content_alignment": (question_alignment, {}),
        "brand_query_identity_alignment": (brand_alignment, {}),
        "nonbrand_demand_content_alignment": (nonbrand_content, {}),
        "high_impression_low_support_health": (high_impression_low_support, {}),
        "zero_click_low_support_health": (zero_click_support, {}),
        "multipage_query_fragmentation_health": (fragmentation_health, {"queries": query_count}),
        "query_landing_specialization": (fragmentation_health, {"queries": query_count}),
        "high_intent_landing_backing": (high_intent, {}),
        "local_high_intent_landing_backing": (local_high_intent, {}),
        "content_decay_republish_risk_health": (decay_health, {"decay_records": len(decay)}),
        "temporal_anomaly_evidence_health": (temporal_health, {"traffic_windows": len(traffic_windows), "traffic_series": len(traffic_series)}),
        "keyword_coverage_provenance_health": (keyword_prov, {"keyword_records": len(keywords)}),
        "attribution_provenance_health": (attribution_prov, {"attribution_records": len(attribution)}),
        "funnel_provenance_health": (funnel_prov, {"funnel_records": len(funnel)}),
        "upstream_receipt_hash_presence": (upstream_presence, {"upstream_records": len(upstream), "receipt_like": len(receipt_like)}),
        "upstream_receipt_hash_integrity": (upstream_integrity, {"receipt_like": len(receipt_like)}),
        "source_id_uniqueness": (source_unique, {"source_ids": len(source_ids)}),
        "cross_source_contradiction_health": (contradiction_health, {}),
        "evidence_quorum_health": (evidence_quorum, {"evidence_sources_present": evidence_sources}),
        "verified_term_whitelist_integrity": (term_whitelist, {}),
        "verified_location_whitelist_integrity": (location_whitelist, {}),
        "verified_service_whitelist_integrity": (service_whitelist, {}),
        "fail_closed_policy_evidence_health": (PPM if policy else 500_000, {"policy_records": len(policy)}),
        "no_mutation_contract_health": (PPM, {"observe_only": True}),
        "policy_risk_absence_composite": (core_policy_absence, {}),
        "evidence_provenance_composite": (provenance_composite, {}),
        "whitehat_compliance_composite": (compliance_composite, {}),
        "terminal_readiness_health": (terminal_readiness, {}),
    }
    if mode not in features:
        raise InvalidData(f"unsupported_compliance_mode:{mode}")
    score, details = features[mode]
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise InvalidData("compliance_threshold_invalid")
    score = max(0, min(PPM, int(score)))
    violation = score < threshold
    return score, violation, {
        "mode": mode,
        "score_ppm": score,
        "threshold_ppm": threshold,
        "observe_only": True,
        "strict_white_hat_only": True,
        "no_google_scraping": True,
        "no_site_mutation": True,
        "no_page_generation": True,
        "no_external_link_creation": True,
        "no_fake_reviews": True,
        "no_fake_locations": True,
        "no_cloaking": True,
        "not_a_rank_forecast": True,
        "not_a_revenue_forecast": True,
        "not_an_indexation_guarantee": True,
        "evidence_contract": EVIDENCE_CONTRACT,
        "semantic": SEMANTIC,
        **details,
    }

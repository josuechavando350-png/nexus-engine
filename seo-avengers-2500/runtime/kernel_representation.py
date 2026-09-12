from __future__ import annotations

from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, config_phrases,
    contains_any_phrase, jaccard_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "PROOF_CARRYING_SEARCH_REPRESENTATION_NOT_RICH_RESULT_OR_RANK_GUARANTEE"


def _rows(normalized: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    if not raw and not allow_empty:
        raise InsufficientData(f"{key}_empty")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out


def _list_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [normalize_text(item) for item in value if isinstance(item, str) and normalize_text(item)]


def _text_of(row: Mapping[str, Any], field: str) -> str:
    value = row.get(field)
    if isinstance(value, str):
        return normalize_text(value)
    if isinstance(value, list):
        return " ".join(_list_strings(value))
    return ""


def _safe_overlap(left: Any, right: Any) -> int:
    a = set(tokens(left))
    b = set(tokens(right))
    if not a or not b:
        return 0
    return bounded_ratio_ppm(len(a & b), len(a | b))


def _average(values: Sequence[int]) -> int:
    if not values:
        return 0
    return sum(values) // len(values)


def _record_share(rows: Sequence[Mapping[str, Any]], predicate) -> int:
    if not rows:
        return 0
    return bounded_ratio_ppm(sum(1 for row in rows if predicate(row)), len(rows))


def _weighted_search_share(rows: Sequence[Mapping[str, Any]], predicate, field: str = "impressions") -> int:
    total = sum(int(row.get(field, 0)) for row in rows)
    if total <= 0:
        return 0
    matched = sum(int(row.get(field, 0)) for row in rows if predicate(row))
    return bounded_ratio_ppm(matched, total)


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw = value.split("?", 1)[0]
    if raw.startswith("/"):
        return raw
    marker = raw.find("://")
    if marker >= 0:
        tail = raw[marker + 3:]
        slash = tail.find("/")
        return "/" if slash < 0 else tail[slash:]
    return raw


def _phrase_support(text: str, phrases: Sequence[Sequence[str]]) -> bool:
    return contains_any_phrase(tokens(text), phrases)


def _intent_representation_text(row: Mapping[str, Any], field: str) -> str:
    if field == "headings":
        return _text_of(row, "headings")
    if field == "image_alts":
        return _text_of(row, "image_alts")
    if field == "internal_anchors":
        return _text_of(row, "internal_anchors")
    if field == "navigation_entities":
        return _text_of(row, "navigation_entities")
    return _text_of(row, field)


def _semantic_entities(semantic_rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    out: list[Mapping[str, Any]] = []
    for row in semantic_rows:
        entities = row.get("entities")
        if isinstance(entities, list):
            for entity in entities:
                if isinstance(entity, Mapping) and isinstance(entity.get("id"), str) and isinstance(entity.get("label"), str):
                    out.append(entity)
    return out


def _feature_map(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    intents = _rows(normalized, "search_intent_records")
    policy = _rows(normalized, "policy_audit_records")
    semantic = _rows(normalized, "semantic_text_records")
    search = _rows(normalized, "search_performance_records")
    docs = _rows(normalized, "content_documents", allow_empty=True)
    local = _rows(normalized, "local_business_records", allow_empty=True)
    canon = _rows(normalized, "canonicalization_records", allow_empty=True)
    entities = _semantic_entities(semantic)

    phrase_sets = {
        "service": config_phrases(config, "local_service_terms"),
        "location": config_phrases(config, "local_location_terms"),
        "commercial": config_phrases(config, "local_commercial_terms"),
        "brand": config_phrases(config, "local_brand_terms"),
    }
    project_locale = normalize_text(config.get("project_locale"))
    doc_map = {str(row.get("document_id")): row for row in docs}
    entity_labels = [normalize_text(entity.get("label")) for entity in entities if normalize_text(entity.get("label"))]
    entity_tokens = {token for label in entity_labels for token in tokens(label)}
    local_identity_text = " ".join(
        normalize_text(row.get("name")) + " " + normalize_text(row.get("address"))
        for row in local
    )
    local_identity_tokens = set(tokens(local_identity_text))

    features: dict[str, tuple[int, dict[str, Any]]] = {}
    def put(name: str, score: int, **details: Any) -> None:
        features[name] = (max(0, min(PPM, score)), details)

    # Metadata and visible-representation proof.
    field_alias = {"title": "title", "meta": "meta_description", "heading": "headings"}
    for label, field in field_alias.items():
        overlaps = [_safe_overlap(row.get("query"), _intent_representation_text(row, field)) for row in intents]
        put(f"{label}_query_token_overlap", _average(overlaps), average_overlap_ppm=_average(overlaps))
        for category in ("service", "location", "commercial", "brand"):
            score = _record_share(intents, lambda row, f=field, c=category: _phrase_support(_intent_representation_text(row, f), phrase_sets[c]))
            put(f"{label}_{category}_support", score, supported_record_share_ppm=score)

    for name, field in (("image_alt", "image_alts"), ("internal_anchor", "internal_anchors")):
        qscore = _average([_safe_overlap(row.get("query"), _intent_representation_text(row, field)) for row in intents])
        put(f"{name}_query_support", qscore, average_overlap_ppm=qscore)
        for category in ("service", "location"):
            score = _record_share(intents, lambda row, f=field, c=category: _phrase_support(_intent_representation_text(row, f), phrase_sets[c]))
            put(f"{name}_{category}_support", score, supported_record_share_ppm=score)

    nav_query = _average([_safe_overlap(row.get("query"), _intent_representation_text(row, "navigation_entities")) for row in intents])
    put("navigation_entity_query_support", nav_query, average_overlap_ppm=nav_query)
    nav_brand = _record_share(intents, lambda row: _phrase_support(_intent_representation_text(row, "navigation_entities"), phrase_sets["brand"]))
    put("navigation_entity_brand_support", nav_brand, supported_record_share_ppm=nav_brand)
    put("intent_label_presence", _record_share(intents, lambda row: bool(_list_strings(row.get("intent_labels")))), intent_records=len(intents))
    put("conversion_synonym_presence", _record_share(intents, lambda row: isinstance(row.get("conversion_synonyms"), Mapping) and bool(row.get("conversion_synonyms"))), intent_records=len(intents))

    title_meta = _average([_safe_overlap(row.get("title"), row.get("meta_description")) for row in intents])
    title_heading = _average([_safe_overlap(row.get("title"), _intent_representation_text(row, "headings")) for row in intents])
    meta_heading = _average([_safe_overlap(row.get("meta_description"), _intent_representation_text(row, "headings")) for row in intents])
    triplet = (title_meta + title_heading + meta_heading) // 3
    put("title_meta_semantic_agreement", title_meta, agreement_ppm=title_meta)
    put("title_heading_semantic_agreement", title_heading, agreement_ppm=title_heading)
    put("meta_heading_semantic_agreement", meta_heading, agreement_ppm=meta_heading)
    put("representation_triplet_consistency", triplet, agreement_ppm=triplet)
    content_align = _average([_safe_overlap(row.get("query"), row.get("content_text")) for row in intents])
    put("intent_record_content_alignment", content_align, average_overlap_ppm=content_align)

    # Policy/structured representation proof.
    jsonld_types: list[str] = []
    for row in policy:
        jsonld_types.extend(_list_strings(row.get("jsonld_types")))
    jsonld_folded = {value.casefold() for value in jsonld_types}
    put("jsonld_type_presence", _record_share(policy, lambda row: bool(_list_strings(row.get("jsonld_types")))), distinct_types=len(jsonld_folded))
    put("jsonld_webpage_presence", PPM if "webpage" in jsonld_folded else 0, types=sorted(jsonld_folded))
    local_service_types = {"localbusiness", "legalservice"}
    put("jsonld_localbusiness_or_legalservice_presence", PPM if jsonld_folded.intersection(local_service_types) else 0, types=sorted(jsonld_folded))
    put("jsonld_organization_presence", PPM if "organization" in jsonld_folded else 0, types=sorted(jsonld_folded))
    type_div = min(PPM, len(jsonld_folded) * 200_000)
    put("jsonld_type_diversity", type_div, distinct_types=len(jsonld_folded))
    put("visible_text_presence", _record_share(policy, lambda row: bool(normalize_text(row.get("visible_text")))), policy_records=len(policy))
    put("heading_presence", _record_share(policy, lambda row: bool(_list_strings(row.get("headings")))), policy_records=len(policy))
    put("human_bot_parity", _record_share(policy, lambda row: isinstance(row.get("user_html"), str) and row.get("user_html") == row.get("bot_html")), policy_records=len(policy))
    put("authorized_domain_alignment", _record_share(policy, lambda row: isinstance(row.get("authorized_domains"), list) and row.get("target_domain") in row.get("authorized_domains")), policy_records=len(policy))
    put("site_identity_alignment", _record_share(policy, lambda row: isinstance(row.get("site_id"), str) and row.get("site_id") == row.get("expected_site_id")), policy_records=len(policy))
    put("robots_expectation_alignment", _record_share(policy, lambda row: isinstance(row.get("robots_allowed"), bool) and row.get("robots_allowed") == row.get("expected_robots_allowed")), policy_records=len(policy))
    def index_follow_ok(row: Mapping[str, Any]) -> bool:
        directives = {normalize_text(x) for x in _list_strings(row.get("robots_directives"))}
        index_ok = (row.get("expected_indexable") is True and "index" in directives and "noindex" not in directives) or (row.get("expected_indexable") is False and "noindex" in directives)
        follow_ok = (row.get("expected_followable") is True and "follow" in directives and "nofollow" not in directives) or (row.get("expected_followable") is False and "nofollow" in directives)
        return index_ok and follow_ok
    put("index_follow_directive_alignment", _record_share(policy, index_follow_ok), policy_records=len(policy))
    put("html_content_type_alignment", _record_share(policy, lambda row: "text/html" in normalize_text(row.get("content_type"))), policy_records=len(policy))
    put("stream_delivery_alignment", _record_share(policy, lambda row: row.get("transfer_mode") == "STREAM"), policy_records=len(policy))
    def retry_ok(row: Mapping[str, Any]) -> bool:
        status = row.get("status_code")
        if status != 503:
            return True
        headers = row.get("headers")
        return isinstance(headers, Mapping) and bool(normalize_text(headers.get("retry-after")))
    put("retry_after_contract_health", _record_share(policy, retry_ok), policy_records=len(policy))
    put("closure_integrity_health", _record_share(policy, lambda row: isinstance(row.get("closure_checks"), Mapping) and row.get("closure_checks", {}).get("integrity") is True), policy_records=len(policy))
    put("closure_policy_health", _record_share(policy, lambda row: isinstance(row.get("closure_checks"), Mapping) and row.get("closure_checks", {}).get("policy") is True), policy_records=len(policy))
    put("schema_type_to_local_identity_support", PPM if jsonld_folded and local_identity_tokens else 0, local_identity_token_count=len(local_identity_tokens))
    put("schema_type_to_semantic_entity_support", PPM if jsonld_folded and entity_tokens else 0, semantic_entity_token_count=len(entity_tokens))
    put("schema_type_to_content_support", PPM if jsonld_folded and docs else 0, content_documents=len(docs))

    # Semantic proof layer.
    put("semantic_entity_presence", PPM if entities else 0, entity_count=len(entities))
    content_corpus = " ".join(str(row.get("text") or "") for row in docs)
    label_content = _record_share(entities, lambda entity: bool(set(tokens(entity.get("label"))).intersection(tokens(content_corpus)))) if entities else 0
    put("semantic_entity_label_content_support", label_content, entity_count=len(entities))
    relation_slots = sum(len(row.get("related_ids")) for row in entities if isinstance(row.get("related_ids"), list))
    relation_density = min(PPM, (relation_slots * PPM) // max(1, len(entities) * max(1, len(entities) - 1)))
    put("semantic_entity_relation_density", relation_density, relation_edges=relation_slots)
    related_entities = sum(1 for row in entities if isinstance(row.get("related_ids"), list) and bool(row.get("related_ids")))
    put("semantic_entity_connectedness", bounded_ratio_ppm(related_entities, len(entities)) if entities else 0, related_entities=related_entities)
    salience_present = sum(1 for row in entities if isinstance(row.get("salience_ppm"), int) and not isinstance(row.get("salience_ppm"), bool) and 0 <= row.get("salience_ppm") <= PPM)
    put("semantic_entity_salience_coverage", bounded_ratio_ppm(salience_present, len(entities)) if entities else 0, salience_entities=salience_present)
    entity_types = {normalize_text(row.get("type")) for row in entities if normalize_text(row.get("type"))}
    put("semantic_entity_type_diversity", min(PPM, len(entity_types) * 200_000), distinct_entity_types=len(entity_types))
    project_sources = sum(1 for row in entities if isinstance(row.get("external_context"), Mapping) and normalize_text(row.get("external_context", {}).get("source")) == "project")
    put("semantic_entity_project_source_share", bounded_ratio_ppm(project_sources, len(entities)) if entities else 0, project_sourced_entities=project_sources)
    put("semantic_entity_property_presence", _record_share(entities, lambda row: isinstance(row.get("properties"), Mapping) and bool(row.get("properties"))) if entities else 0, entity_count=len(entities))
    put("semantic_entity_schema_type_presence", _record_share(entities, lambda row: isinstance(row.get("schema_types"), Mapping) and bool(row.get("schema_types"))) if entities else 0, entity_count=len(entities))
    semantic_heading_text = " ".join(_text_of(row, "headings") for row in semantic)
    semantic_link_text = " ".join(_text_of(row, "links") for row in semantic)
    put("semantic_heading_entity_support", bounded_ratio_ppm(len(set(tokens(semantic_heading_text)) & entity_tokens), len(entity_tokens)) if entity_tokens else 0, entity_token_count=len(entity_tokens))
    put("semantic_link_entity_support", bounded_ratio_ppm(len(set(tokens(semantic_link_text)) & entity_tokens), len(entity_tokens)) if entity_tokens else 0, entity_token_count=len(entity_tokens))
    put("semantic_intent_label_presence", _record_share(semantic, lambda row: bool(_list_strings(row.get("intent_labels")))), semantic_records=len(semantic))
    put("semantic_locale_alignment", _record_share(semantic, lambda row: bool(project_locale) and normalize_text(row.get("locale")) == project_locale), project_locale=project_locale)
    put("semantic_entity_cache_presence", _record_share(semantic, lambda row: isinstance(row.get("entity_cache"), Mapping) and bool(row.get("entity_cache"))), semantic_records=len(semantic))
    type_score = lambda names: bounded_ratio_ppm(sum(1 for row in entities if normalize_text(row.get("type")) in names), len(entities)) if entities else 0
    put("semantic_service_entity_presence", type_score({"service"}), entity_count=len(entities))
    put("semantic_location_entity_presence", type_score({"gpe", "location", "place"}), entity_count=len(entities))
    put("semantic_brand_entity_presence", type_score({"org", "organization"}), entity_count=len(entities))
    put("semantic_event_entity_presence", type_score({"event"}), entity_count=len(entities))
    query_entity_align = _weighted_search_share(search, lambda row: bool(set(row.get("query_tokens", [])) & entity_tokens))
    put("semantic_entity_query_alignment", query_entity_align, weighted_share_ppm=query_entity_align)
    doc_entity_align = _record_share(docs, lambda row: bool(set(row.get("tokens", [])) & entity_tokens)) if docs else 0
    put("semantic_entity_content_alignment", doc_entity_align, document_share_ppm=doc_entity_align)

    # Cross-layer evidence mesh.
    intent_query_tokens = [set(tokens(row.get("query"))) for row in intents]
    def search_matches_intent(row: Mapping[str, Any]) -> bool:
        q = set(row.get("query_tokens", []))
        return any(bool(q & other) for other in intent_query_tokens)
    put("search_landing_intent_record_alignment", _weighted_search_share(search, search_matches_intent), search_records=len(search))
    put("search_landing_content_document_alignment", _weighted_search_share(search, lambda row: _path(row.get("page_url")) in doc_map), content_documents=len(docs))
    field_cross = (
        ("search_query_title_alignment", "title"),
        ("search_query_meta_alignment", "meta_description"),
        ("search_query_heading_alignment", "headings"),
        ("search_query_alt_alignment", "image_alts"),
        ("search_query_anchor_alignment", "internal_anchors"),
        ("search_query_navigation_entity_alignment", "navigation_entities"),
    )
    for name, field in field_cross:
        representation_tokens = set(tokens(" ".join(_intent_representation_text(row, field) for row in intents)))
        score = _weighted_search_share(search, lambda row, rep=representation_tokens: bool(set(row.get("query_tokens", [])) & rep))
        put(name, score, representation_token_count=len(representation_tokens))
    put("search_query_semantic_entity_alignment", query_entity_align, semantic_entity_token_count=len(entity_tokens))
    for name, field in (("local_identity_title_alignment", "title"), ("local_identity_meta_alignment", "meta_description"), ("local_identity_heading_alignment", "headings")):
        rep_tokens = set(tokens(" ".join(_intent_representation_text(row, field) for row in intents)))
        score = bounded_ratio_ppm(len(rep_tokens & local_identity_tokens), len(local_identity_tokens)) if local_identity_tokens else 0
        put(name, score, local_identity_token_count=len(local_identity_tokens))
    semantic_all_tokens = set(tokens(" ".join(str(row.get("text") or "") for row in semantic))) | entity_tokens
    local_semantic = bounded_ratio_ppm(len(semantic_all_tokens & local_identity_tokens), len(local_identity_tokens)) if local_identity_tokens else 0
    put("local_identity_semantic_alignment", local_semantic, local_identity_token_count=len(local_identity_tokens))
    canon_paths = {_path(row.get("url")) for row in canon} | {_path(row.get("consolidated_to")) for row in canon}
    canon_paths.discard("")
    put("canonical_landing_alignment", _weighted_search_share(search, lambda row: _path(row.get("page_url")) in canon_paths), canonical_paths=len(canon_paths))
    brand_terms = {token for phrase in phrase_sets["brand"] for token in phrase}
    canon_brand = _record_share(canon, lambda row: bool(set(tokens(row.get("brand_entity"))) & brand_terms)) if canon else 0
    put("canonical_brand_entity_alignment", canon_brand, canonical_records=len(canon))
    canon_cluster = _record_share(canon, lambda row: bool(normalize_text(row.get("query_cluster")))) if canon else 0
    put("canonical_query_cluster_alignment", canon_cluster, canonical_records=len(canon))
    canon_schema = _record_share(canon, lambda row: bool(normalize_text(row.get("schema_signature")))) if canon else 0
    put("canonical_schema_signature_presence", canon_schema, canonical_records=len(canon))

    evidence_flags = [bool(intents), bool(policy), bool(semantic), bool(search), bool(docs), bool(local), bool(canon), bool(entities), bool(jsonld_types)]
    breadth = bounded_ratio_ppm(sum(1 for flag in evidence_flags if flag), len(evidence_flags))
    put("representation_evidence_breadth", breadth, present_evidence_families=sum(1 for flag in evidence_flags if flag), total_evidence_families=len(evidence_flags))
    contradiction_checks = [
        features["human_bot_parity"][0], features["authorized_domain_alignment"][0],
        features["site_identity_alignment"][0], features["robots_expectation_alignment"][0],
        features["index_follow_directive_alignment"][0], features["local_identity_semantic_alignment"][0],
    ]
    conflict_health = _average(contradiction_checks)
    put("representation_conflict_health", conflict_health, component_scores=contradiction_checks)
    mesh_components = [triplet, content_align, breadth, conflict_health, query_entity_align, features["canonical_landing_alignment"][0], features["jsonld_type_presence"][0]]
    mesh = _average(mesh_components)
    put("representation_proof_mesh_health", mesh, component_scores=mesh_components)
    return features


def representation_proof_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("representation_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str):
        raise InvalidData("representation_mode_invalid")
    features = _feature_map(normalized, config)
    if mode not in features:
        raise InvalidData(f"unsupported_representation_mode:{mode}")
    score, details = features[mode]
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= PPM:
        raise InvalidData("representation_threshold_invalid")
    return score, score < threshold, {
        **details,
        "mode": mode,
        "semantic": SEMANTIC,
        "evidence_contract": EVIDENCE_CONTRACT,
        "observe_only": True,
        "proof_carrying": True,
        "no_google_scraping": True,
        "no_schema_fabrication": True,
        "no_rich_result_guarantee": True,
        "no_rank_guarantee": True,
        "no_site_mutation": True,
    }

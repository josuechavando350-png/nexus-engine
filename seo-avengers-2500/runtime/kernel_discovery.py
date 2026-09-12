from __future__ import annotations

from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, canonical_url_or_path,
    normalize_text, tokens,
)

SEMANTIC = "DISCOVERY_READINESS_NOT_GOOGLE_CRAWL_OR_INDEX_TIMING_PREDICTION"
EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"

def _rows(normalized: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    if not raw:
        raise InsufficientData(f"{key}_empty")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out

def _score_rows(rows: Sequence[Mapping[str, Any]], predicate, *, label: str) -> tuple[int, dict[str, Any]]:
    if not rows:
        raise InsufficientData(f"{label}_empty")
    passed = 0
    for row in rows:
        if predicate(row):
            passed += 1
    score = bounded_ratio_ppm(passed, len(rows))
    return score, {"eligible_records": len(rows), "healthy_records": passed}

def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return value

def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())

def _nonempty_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value)

def _url_path(value: Any) -> str:
    normalized = canonical_url_or_path(value)
    if not normalized:
        return ""
    if normalized.startswith("/"):
        return normalized
    try:
        parsed = urlsplit(normalized)
    except ValueError:
        return ""
    return parsed.path or "/"

def _canon_terms(row: Mapping[str, Any]) -> set[str]:
    values = (
        row.get("keyword"), row.get("semantic_key"), row.get("slug"),
        row.get("query_cluster"), row.get("brand_entity"),
    )
    out: set[str] = set()
    for value in values:
        if isinstance(value, str):
            out.update(tokens(value))
    entities = row.get("entities")
    if isinstance(entities, list):
        for entity in entities:
            if isinstance(entity, str):
                out.update(tokens(entity))
    return out

def _canon_matches_query(canon: Mapping[str, Any], query: str) -> bool:
    q = set(tokens(query))
    c = _canon_terms(canon)
    return bool(q and c and q.intersection(c))

def _canon_for_search_row(canon_rows: Sequence[Mapping[str, Any]], row: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    page_path = _url_path(row.get("page_url"))
    query = str(row.get("query") or "")
    matches: list[Mapping[str, Any]] = []
    for canon in canon_rows:
        canon_path = _url_path(canon.get("url"))
        consolidated = _url_path(canon.get("consolidated_to"))
        if page_path and page_path in {canon_path, consolidated}:
            matches.append(canon)
            continue
        if _canon_matches_query(canon, query):
            matches.append(canon)
    return matches

def _document_ids(normalized: Mapping[str, Any]) -> set[str]:
    docs = normalized.get("content_documents", [])
    if not isinstance(docs, list):
        raise InvalidData("content_documents_must_be_list")
    return {str(row.get("document_id")) for row in docs if isinstance(row, Mapping) and row.get("document_id")}

def _healthy_canonical(mode: str, row: Mapping[str, Any]) -> bool:
    archived = row.get("archived") is True
    excluded = row.get("excluded_from_index") is True
    mapping = {
        "canonical_sitemap_presence": lambda: row.get("sitemap_present") is True if not archived and not excluded else True,
        "canonical_sitemap_db_parity": lambda: isinstance(row.get("sitemap_present"), bool) and row.get("sitemap_present") == row.get("db_present"),
        "canonical_index_eligibility": lambda: not archived and not excluded,
        "canonical_archive_exclusion": lambda: (not archived) or excluded,
        "canonical_inlink_presence": lambda: _as_int(row.get("internal_inlinks")) > 0,
        "canonical_inlink_depth": lambda: _as_int(row.get("internal_inlinks")) >= 3,
        "canonical_integrity": lambda: row.get("integrity_verified") is True,
        "canonical_quality_floor": lambda: _as_int(row.get("quality_score_ppm")) >= 500_000,
        "canonical_structural_stability": lambda: 0 <= _as_int(row.get("structural_changes_24h"), -1) <= 5,
        "canonical_activity": lambda: archived or 0 <= _as_int(row.get("inactive_days"), -1) <= 365,
        "canonical_query_cluster": lambda: _nonempty_string(row.get("query_cluster")),
        "canonical_brand_entity": lambda: _nonempty_string(row.get("brand_entity")),
        "canonical_entity_inventory": lambda: _nonempty_list(row.get("entities")),
        "canonical_schema_signature": lambda: _nonempty_string(row.get("schema_signature")),
        "canonical_slug_semantic_consistency": lambda: (
            _nonempty_string(row.get("slug"))
            and _nonempty_string(row.get("semantic_key"))
            and normalize_text(str(row.get("slug"))).replace(" ", "-")
                == normalize_text(str(row.get("semantic_key"))).replace(" ", "-")
        ),
    }
    fn = mapping.get(mode)
    if fn is None:
        raise InvalidData(f"unsupported_canonical_discovery_mode:{mode}")
    return bool(fn())

def _healthy_persistence(mode: str, row: Mapping[str, Any]) -> bool:
    mapping = {
        "persistence_publication_ready": lambda: row.get("publication_state") == "PUBLISHED",
        "persistence_route_query_ready": lambda: row.get("route_query_indexed") is True,
        "persistence_sitemap_hash_parity": lambda: _nonempty_string(row.get("sitemap_hash")) and row.get("sitemap_hash") == row.get("db_sitemap_hash"),
        "persistence_snapshot_hash_parity": lambda: _nonempty_string(row.get("snapshot_hash")) and row.get("snapshot_hash") == row.get("expected_snapshot_hash"),
        "persistence_broken_refs": lambda: isinstance(row.get("broken_refs"), list) and len(row.get("broken_refs")) == 0,
        "persistence_transaction_committed": lambda: row.get("transaction_state") == "COMMITTED",
        "persistence_lock_active": lambda: row.get("lock_active") is True,
        "persistence_grounding_match": lambda: row.get("grounding_match") is True,
        "persistence_grounding_indexed": lambda: row.get("grounding_indexed") is True,
        "persistence_retry_budget": lambda: 0 <= _as_int(row.get("retry_count"), -1) <= 3,
        "persistence_known_route_membership": lambda: (
            _nonempty_string(row.get("route"))
            and isinstance(row.get("known_routes"), list)
            and row.get("route") in row.get("known_routes")
        ),
        "persistence_config_version": lambda: _as_int(row.get("config_version")) > 0,
        "persistence_table_index_health": lambda: isinstance(row.get("table_health"), Mapping) and row.get("table_health", {}).get("index_ok") is True,
        "persistence_update_observation_order": lambda: (
            isinstance(row.get("updated_at_epoch"), int)
            and not isinstance(row.get("updated_at_epoch"), bool)
            and isinstance(row.get("observed_at_epoch"), int)
            and not isinstance(row.get("observed_at_epoch"), bool)
            and row.get("updated_at_epoch") <= row.get("observed_at_epoch")
        ),
    }
    if mode == "persistence_queue_priority_order":
        raise InvalidData("queue_priority_order_requires_collection")
    fn = mapping.get(mode)
    if fn is None:
        raise InvalidData(f"unsupported_persistence_discovery_mode:{mode}")
    return bool(fn())

def _queue_order_health(rows: Sequence[Mapping[str, Any]]) -> tuple[int, dict[str, Any]]:
    usable = []
    for row in rows:
        position = row.get("queue_position")
        priority = row.get("priority")
        if isinstance(position, int) and not isinstance(position, bool) and isinstance(priority, int) and not isinstance(priority, bool):
            usable.append((position, priority))
    if not usable:
        raise InsufficientData("persistence_queue_priority_evidence_empty")
    ordered = sorted(usable)
    comparisons = max(1, len(ordered) - 1)
    healthy = 0
    if len(ordered) == 1:
        healthy = 1
    else:
        for left, right in zip(ordered, ordered[1:]):
            if left[1] <= right[1]:
                healthy += 1
    return bounded_ratio_ppm(healthy, comparisons), {"queue_comparisons": comparisons, "healthy_comparisons": healthy}

def _healthy_gateway(mode: str, row: Mapping[str, Any]) -> bool:
    response_headers = row.get("response_headers")
    if not isinstance(response_headers, Mapping):
        response_headers = {}
    worker_schema = row.get("worker_schema")
    if not isinstance(worker_schema, Mapping):
        worker_schema = {}
    status = _as_int(row.get("status_code"), -1)
    mapping = {
        "gateway_health": lambda: row.get("health_ok") is True,
        "gateway_status_delivery": lambda: 200 <= status < 400,
        "gateway_fallback_free": lambda: row.get("fallback_used") is False,
        "gateway_target_domain": lambda: _nonempty_string(row.get("target_domain")) and row.get("target_domain") == row.get("expected_target_domain"),
        "gateway_policy_version": lambda: _nonempty_string(row.get("policy_version")) and row.get("policy_version") == row.get("expected_policy_version"),
        "gateway_snapshot_version": lambda: isinstance(row.get("snapshot_version"), int) and row.get("snapshot_version") == row.get("expected_snapshot_version"),
        "gateway_nonempty_response": lambda: _as_int(row.get("response_bytes")) > 0,
        "gateway_redirect_budget": lambda: isinstance(row.get("redirect_chain"), list) and len(row.get("redirect_chain")) <= 3,
        "gateway_cache_hit": lambda: row.get("cache_hit") is True,
        "gateway_compression": lambda: _nonempty_string(response_headers.get("content-encoding")),
        "gateway_html_content_type": lambda: "text/html" in str(response_headers.get("content-type") or "").casefold(),
        "gateway_suite_signature": lambda: _nonempty_string(row.get("suite_signature")),
        "gateway_exclusion_reasons": lambda: isinstance(row.get("exclusion_reasons"), list) and len(row.get("exclusion_reasons")) == 0,
        "gateway_worker_site_identity": lambda: _nonempty_string(row.get("site_id")) and worker_schema.get("site_id") == row.get("site_id"),
        "gateway_https_endpoint": lambda: isinstance(row.get("endpoint"), str) and row.get("endpoint", "").casefold().startswith("https://"),
    }
    fn = mapping.get(mode)
    if fn is None:
        raise InvalidData(f"unsupported_gateway_discovery_mode:{mode}")
    return bool(fn())

def _healthy_cwv(mode: str, row: Mapping[str, Any]) -> bool:
    headers = row.get("headers")
    if not isinstance(headers, Mapping):
        headers = {}
    ua = row.get("user_agent_variants")
    if not isinstance(ua, Mapping):
        ua = {}
    assets = row.get("assets")
    if not isinstance(assets, list):
        assets = []
    mapping = {
        "cwv_latency_budget": lambda: 0 <= _as_int(row.get("latency_ms"), -1) <= 1_000,
        "cwv_client_render_budget": lambda: 0 <= _as_int(row.get("client_render_ms"), -1) <= 2_500,
        "cwv_nonempty_response": lambda: _as_int(row.get("response_bytes")) > 0,
        "cwv_redirect_budget": lambda: isinstance(row.get("internal_redirect_chain"), list) and len(row.get("internal_redirect_chain")) <= 3,
        "cwv_critical_assets": lambda: _nonempty_list(row.get("critical_assets")),
        "cwv_compression": lambda: _nonempty_string(headers.get("content-encoding")),
        "cwv_cache_control": lambda: _nonempty_string(headers.get("cache-control")),
        "cwv_csp": lambda: _nonempty_string(headers.get("content-security-policy")),
        "cwv_nosniff": lambda: str(headers.get("x-content-type-options") or "").casefold() == "nosniff",
        "cwv_referrer_policy": lambda: _nonempty_string(headers.get("referrer-policy")),
        "cwv_device_parity": lambda: _nonempty_string(ua.get("desktop")) and ua.get("desktop") == ua.get("mobile"),
        "cwv_geo_authorization": lambda: row.get("geo_headers_authorized") is True,
        "cwv_transform_budget": lambda: 0 <= _as_int(row.get("transform_ms"), -1) <= 100,
        "cwv_asset_budget": lambda: sum(max(0, _as_int(a.get("bytes"))) for a in assets if isinstance(a, Mapping)) <= 500_000,
        "cwv_https_url": lambda: isinstance(row.get("url"), str) and row.get("url", "").casefold().startswith("https://"),
    }
    fn = mapping.get(mode)
    if fn is None:
        raise InvalidData(f"unsupported_cwv_discovery_mode:{mode}")
    return bool(fn())

def _healthy_policy(mode: str, row: Mapping[str, Any]) -> bool:
    directives = row.get("robots_directives")
    if not isinstance(directives, list):
        directives = []
    folded = {str(value).casefold() for value in directives}
    closure = row.get("closure_checks")
    if not isinstance(closure, Mapping):
        closure = {}
    status = _as_int(row.get("status_code"), -1)
    headers = row.get("headers")
    if not isinstance(headers, Mapping):
        headers = {}
    authorized = row.get("authorized_domains")
    if not isinstance(authorized, list):
        authorized = []
    expected_indexable = row.get("expected_indexable")
    expected_followable = row.get("expected_followable")
    mapping = {
        "policy_robots_parity": lambda: isinstance(row.get("robots_allowed"), bool) and row.get("robots_allowed") == row.get("expected_robots_allowed"),
        "policy_indexability_consistency": lambda: (
            (expected_indexable is True and "index" in folded and "noindex" not in folded)
            or (expected_indexable is False and "noindex" in folded)
        ),
        "policy_followability_consistency": lambda: (
            (expected_followable is True and "follow" in folded and "nofollow" not in folded)
            or (expected_followable is False and "nofollow" in folded)
        ),
        "policy_human_bot_parity": lambda: isinstance(row.get("user_html"), str) and row.get("user_html") == row.get("bot_html"),
        "policy_status_contract": lambda: (200 <= status < 400) or (status == 503 and _nonempty_string(headers.get("retry-after"))),
        "policy_authorized_domain": lambda: _nonempty_string(row.get("target_domain")) and row.get("target_domain") in authorized,
        "policy_content_type": lambda: "text/html" in str(row.get("content_type") or "").casefold(),
        "policy_stream_transfer": lambda: row.get("transfer_mode") == "STREAM",
        "policy_site_identity": lambda: _nonempty_string(row.get("site_id")) and row.get("site_id") == row.get("expected_site_id"),
        "policy_jsonld_presence": lambda: _nonempty_list(row.get("jsonld_types")),
        "policy_visible_text": lambda: _nonempty_string(row.get("visible_text")),
        "policy_heading_presence": lambda: _nonempty_list(row.get("headings")),
        "policy_closure_integrity": lambda: closure.get("integrity") is True,
        "policy_closure_policy": lambda: closure.get("policy") is True,
        "policy_retry_after": lambda: status != 503 or _nonempty_string(headers.get("retry-after")),
    }
    fn = mapping.get(mode)
    if fn is None:
        raise InvalidData(f"unsupported_policy_discovery_mode:{mode}")
    return bool(fn())

def _direct_metric(mode: str, normalized: Mapping[str, Any]) -> tuple[int, dict[str, Any]] | None:
    if mode.startswith("canonical_"):
        rows = _rows(normalized, "canonicalization_records")
        return _score_rows(rows, lambda row: _healthy_canonical(mode, row), label=mode)
    if mode.startswith("persistence_"):
        rows = _rows(normalized, "persistence_state_records")
        if mode == "persistence_queue_priority_order":
            return _queue_order_health(rows)
        return _score_rows(rows, lambda row: _healthy_persistence(mode, row), label=mode)
    if mode.startswith("gateway_"):
        rows = _rows(normalized, "edge_gateway_records")
        return _score_rows(rows, lambda row: _healthy_gateway(mode, row), label=mode)
    if mode.startswith("cwv_"):
        rows = _rows(normalized, "cwv_edge_records")
        return _score_rows(rows, lambda row: _healthy_cwv(mode, row), label=mode)
    if mode.startswith("policy_"):
        rows = _rows(normalized, "policy_audit_records")
        return _score_rows(rows, lambda row: _healthy_policy(mode, row), label=mode)
    return None

def _cross_metric(mode: str, normalized: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
    intents = _rows(normalized, "search_intent_records")
    canon = _rows(normalized, "canonicalization_records")
    search = normalized.get("search_performance_records", [])
    if not isinstance(search, list) or not search:
        raise InsufficientData("search_performance_records_empty")
    docs = _document_ids(normalized)
    persistence = _rows(normalized, "persistence_state_records")
    gateways = _rows(normalized, "edge_gateway_records")
    cwv = _rows(normalized, "cwv_edge_records")
    policy = _rows(normalized, "policy_audit_records")

    if mode == "cross_intent_canonical_keyword":
        healthy = 0
        for row in intents:
            query = str(row.get("query") or "")
            if any(_canon_matches_query(c, query) for c in canon):
                healthy += 1
        return bounded_ratio_ppm(healthy, len(intents)), {"eligible_records": len(intents), "healthy_records": healthy}

    if mode == "cross_intent_canonical_cluster":
        healthy = 0
        for row in intents:
            query = str(row.get("query") or "")
            silo = normalize_text(row.get("silo"))
            matches = [c for c in canon if _canon_matches_query(c, query)]
            if any(silo and silo == normalize_text(c.get("query_cluster")) for c in matches):
                healthy += 1
        return bounded_ratio_ppm(healthy, len(intents)), {"eligible_records": len(intents), "healthy_records": healthy}

    if mode == "cross_intent_internal_anchor":
        return _score_rows(intents, lambda row: _nonempty_list(row.get("internal_anchors")), label=mode)

    if mode == "cross_intent_navigation_entity":
        return _score_rows(intents, lambda row: _nonempty_list(row.get("navigation_entities")), label=mode)

    if mode == "cross_intent_same_silo_links":
        def same_silo(row):
            silo = normalize_text(row.get("silo"))
            targets = row.get("internal_link_targets")
            if not silo or not isinstance(targets, list) or not targets:
                return False
            for target in targets:
                if isinstance(target, Mapping) and normalize_text(target.get("silo")) == silo:
                    return True
            return False
        return _score_rows(intents, same_silo, label=mode)

    if mode in {
        "cross_demand_sitemap", "cross_demand_inlinks", "cross_zero_click_readiness",
        "cross_top10_readiness",
    }:
        eligible = []
        for row in search:
            if mode == "cross_zero_click_readiness" and not (row.get("clicks") == 0 and _as_int(row.get("impressions")) > 0):
                continue
            if mode == "cross_top10_readiness" and not (0 < _as_int(row.get("average_position_milli")) <= 10_000):
                continue
            eligible.append(row)
        if not eligible:
            raise InsufficientData(f"{mode}_eligible_search_empty")
        healthy = 0
        for row in eligible:
            matches = _canon_for_search_row(canon, row)
            content_present = str(row.get("page_url")) in docs or _url_path(row.get("page_url")) in docs
            sitemap = any(c.get("sitemap_present") is True and c.get("excluded_from_index") is not True for c in matches)
            inlinks = any(_as_int(c.get("internal_inlinks")) > 0 for c in matches)
            if mode == "cross_demand_sitemap" and sitemap:
                healthy += 1
            elif mode == "cross_demand_inlinks" and inlinks:
                healthy += 1
            elif mode in {"cross_zero_click_readiness", "cross_top10_readiness"} and content_present and sitemap and inlinks:
                healthy += 1
        return bounded_ratio_ppm(healthy, len(eligible)), {"eligible_records": len(eligible), "healthy_records": healthy}

    if mode == "cross_demand_content":
        healthy = 0
        for row in search:
            page = str(row.get("page_url"))
            path = _url_path(row.get("page_url"))
            if page in docs or path in docs:
                healthy += 1
        return bounded_ratio_ppm(healthy, len(search)), {"eligible_records": len(search), "healthy_records": healthy}

    if mode == "cross_canonical_publication":
        routes = {str(row.get("route")) for row in persistence if row.get("publication_state") == "PUBLISHED"}
        eligible = [row for row in canon if row.get("sitemap_present") is True and row.get("excluded_from_index") is not True]
        if not eligible:
            raise InsufficientData("canonical_publication_bridge_empty")
        healthy = 0
        for row in eligible:
            candidates = {_url_path(row.get("url")), _url_path(row.get("consolidated_to"))}
            if any(candidate and candidate in routes for candidate in candidates):
                healthy += 1
        return bounded_ratio_ppm(healthy, len(eligible)), {"eligible_records": len(eligible), "healthy_records": healthy}

    if mode == "cross_sitemap_persistence":
        persisted = [row for row in persistence if _nonempty_string(row.get("sitemap_hash")) and row.get("sitemap_hash") == row.get("db_sitemap_hash")]
        eligible = [row for row in canon if row.get("sitemap_present") is True]
        if not eligible:
            raise InsufficientData("sitemap_persistence_bridge_empty")
        score = PPM if persisted else 0
        return score, {"sitemap_canonical_records": len(eligible), "healthy_persistence_sitemap_records": len(persisted)}

    if mode == "cross_gateway_policy":
        authorized = set()
        for row in policy:
            domains = row.get("authorized_domains")
            if isinstance(domains, list):
                authorized.update(str(value) for value in domains if isinstance(value, str))
        healthy = sum(1 for row in gateways if str(row.get("target_domain") or "") in authorized and row.get("health_ok") is True)
        return bounded_ratio_ppm(healthy, len(gateways)), {"eligible_records": len(gateways), "healthy_records": healthy}

    if mode == "cross_cwv_gateway":
        healthy_domains = {str(row.get("target_domain")) for row in gateways if row.get("health_ok") is True}
        healthy = 0
        for row in cwv:
            url = str(row.get("url") or "")
            host = ""
            try:
                host = urlsplit(url).hostname or ""
            except ValueError:
                host = ""
            if host in healthy_domains and _as_int(row.get("response_bytes")) > 0:
                healthy += 1
        return bounded_ratio_ppm(healthy, len(cwv)), {"eligible_records": len(cwv), "healthy_records": healthy}

    if mode == "cross_full_stack":
        component_modes = (
            "canonical_sitemap_presence", "persistence_publication_ready", "gateway_health",
            "cwv_latency_budget", "policy_robots_parity",
        )
        scores = []
        for component in component_modes:
            direct = _direct_metric(component, normalized)
            if direct is None:
                raise InvalidData(f"full_stack_component_unsupported:{component}")
            scores.append(direct[0])
        score = sum(scores) // len(scores)
        return score, {"component_scores_ppm": dict(zip(component_modes, scores)), "component_count": len(scores)}

    raise InvalidData(f"unsupported_cross_discovery_mode:{mode}")

def discovery_velocity_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    mode = str(spec.get("params", {}).get("mode") or "")
    direct = _direct_metric(mode, normalized)
    if direct is None:
        score, details = _cross_metric(mode, normalized)
    else:
        score, details = direct
    threshold = int(spec.get("threshold_ppm", 500_000))
    violation = score < threshold
    return score, violation, {
        **details,
        "metric_mode": mode,
        "policy_threshold_ppm": threshold,
        "semantic": SEMANTIC,
        "evidence_contract": EVIDENCE_CONTRACT,
        "not_a_google_crawl_speed_prediction": True,
        "not_a_google_index_state_claim": True,
    }

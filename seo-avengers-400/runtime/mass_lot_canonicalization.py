from __future__ import annotations

from .mass_lot_common import *


def _canonicalization(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                      config: Mapping[str, Any]) -> EvalResult:
    if index == 1:
        targets: Dict[str, set[str]] = {}
        for row in rows:
            keyword = _req_str(row, "keyword").casefold()
            url = _req_str(row, "url")
            targets.setdefault(keyword, set()).add(url)
        conflicts = sum(1 for urls in targets.values() if len(urls) > 1)
        return _gt_result(module_id, "keyword_url_matrix_conflicts", conflicts, config, 0,
                          {"keywords": len(targets)}, "KEYWORD_URL_MATRIX")
    if index == 2:
        vectors: Dict[str, set[str]] = {}
        for row in rows:
            key = _req_str(row, "semantic_key")
            vectors.setdefault(key, set()).add(_req_str(row, "url"))
        conflicts = sum(1 for urls in vectors.values() if len(urls) > 1)
        return _gt_result(module_id, "semantic_vector_conflicts", conflicts, config, 0,
                          {"semantic_keys": len(vectors)}, "SEMANTIC_VECTOR_CONFLICT")
    if index == 3:
        invalid = 0
        eligible = 0
        for row in rows:
            target = _opt_str(row, "consolidated_to")
            if not target:
                continue
            eligible += 1
            source = _req_str(row, "url")
            if target == source or not target.startswith(("/", "http://", "https://")):
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("consolidated_to")
        return _gt_result(module_id, "invalid_consolidation_links", invalid, config, 0,
                          {"eligible_links": eligible}, "ATOMIC_CONSOLIDATION_LINKS")
    if index == 4:
        collisions = 0
        owners: Dict[str, set[str]] = {}
        eligible = 0
        for row in rows:
            history = _list_str(row, "slug_history")
            if not history:
                continue
            eligible += 1
            url = _req_str(row, "url")
            for slug in history:
                owners.setdefault(slug.casefold(), set()).add(url)
        if eligible == 0:
            raise _InsufficientData("slug_history")
        collisions = sum(1 for urls in owners.values() if len(urls) > 1)
        return _gt_result(module_id, "slug_history_collisions", collisions, config, 0,
                          {"historical_slugs": len(owners)}, "SLUG_HISTORY_CONSOLIDATION")
    if index == 5:
        weights = [_opt_int(row, "internal_inlinks", 0, 1_000_000) for row in rows]
        if not weights:
            raise _InsufficientData("internal_inlinks")
        value = min(weights)
        return _lt_result(module_id, "minimum_internal_page_weight", value, config, 1,
                          {"weights": weights}, "PAGE_LINK_WEIGHT", 1_000_000)
    if index == 6:
        excluded = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 200_000, PPM)
        for row in rows:
            if "quality_score_ppm" not in row:
                continue
            score = _req_int(row, "quality_score_ppm", PPM)
            eligible += 1
            if score < threshold and not _opt_bool(row, "excluded_from_index"):
                excluded += 1
        if eligible == 0:
            raise _InsufficientData("quality_score_ppm")
        return EvalResult("low_value_pages_not_excluded", excluded, excluded > 0,
                          {"comparison": "QUALITY_LT", "threshold": threshold},
                          {"eligible_pages": eligible}, "LOW_VALUE_PAGE_EXCLUSION_REQUIRED",
                          "LOW_VALUE_PAGE_EXCLUSION_WITHIN_POLICY")
    if index == 7:
        mismatches = 0
        eligible = 0
        for row in rows:
            locale = _opt_str(row, "locale")
            hreflang = _opt_str(row, "hreflang")
            if not locale or not hreflang:
                continue
            eligible += 1
            if locale.casefold().replace("_", "-") != hreflang.casefold().replace("_", "-"):
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("locale_hreflang")
        return _gt_result(module_id, "regional_language_mismatches", mismatches, config, 0,
                          {"eligible_pages": eligible}, "REGIONAL_LANGUAGE_VARIANTS")
    if index == 8:
        hot = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 5, 1_000_000)
        for row in rows:
            if "structural_changes_24h" not in row:
                continue
            eligible += 1
            if _req_int(row, "structural_changes_24h", 1_000_000) > threshold:
                hot += 1
        if eligible == 0:
            raise _InsufficientData("structural_changes_24h")
        return EvalResult("hot_structural_pages", hot, hot > 0,
                          {"comparison": "CHANGES_GT", "threshold": threshold},
                          {"eligible_pages": eligible}, "HOT_STRUCTURAL_CHANGES_DETECTED",
                          "STRUCTURAL_CHANGE_RATE_WITHIN_POLICY")
    if index == 9:
        duplicate = 0
        seen: Dict[str, str] = {}
        eligible = 0
        for row in rows:
            h1 = _opt_str(row, "h1")
            if not h1:
                continue
            eligible += 1
            normalized = " ".join(_tokens(h1))
            url = _req_str(row, "url")
            if normalized in seen and seen[normalized] != url:
                duplicate += 1
            seen.setdefault(normalized, url)
        if eligible == 0:
            raise _InsufficientData("h1")
        return _gt_result(module_id, "duplicate_h1_titles", duplicate, config, 0,
                          {"eligible_pages": eligible}, "H1_UNIQUENESS")
    if index == 10:
        missing = 0
        eligible = 0
        for row in rows:
            if "author_id" not in row:
                continue
            eligible += 1
            if not _opt_str(row, "author_id"):
                missing += 1
        if eligible == 0:
            raise _InsufficientData("author_id")
        return _gt_result(module_id, "missing_connected_authorship", missing, config, 0,
                          {"eligible_pages": eligible}, "CONNECTED_AUTHORSHIP")
    if index == 11:
        locks: Dict[str, set[str]] = {}
        for row in rows:
            key = _opt_str(row, "write_lock_key")
            owner = _opt_str(row, "write_lock_owner")
            if key and owner and _opt_bool(row, "write_lock_active"):
                locks.setdefault(key, set()).add(owner)
        if not locks:
            raise _InsufficientData("write_lock_key")
        collisions = sum(1 for owners in locks.values() if len(owners) > 1)
        return _gt_result(module_id, "concurrent_write_lock_collisions", collisions, config, 0,
                          {"active_lock_keys": len(locks)}, "CONCURRENT_WRITE_LOCKS")
    if index == 12:
        stale = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 90, 100_000)
        for row in rows:
            if "inactive_days" not in row:
                continue
            eligible += 1
            if _req_int(row, "inactive_days", 100_000) > threshold and not _opt_bool(row, "archived"):
                stale += 1
        if eligible == 0:
            raise _InsufficientData("inactive_days")
        return EvalResult("stale_inactive_records", stale, stale > 0,
                          {"comparison": "DAYS_GT", "threshold": threshold},
                          {"eligible_records": eligible}, "INACTIVE_RECORD_CLEANUP_REQUIRED",
                          "INACTIVE_RECORDS_WITHIN_POLICY")
    if index == 13:
        mismatch = 0
        eligible = 0
        for row in rows:
            if "sitemap_present" not in row or "db_present" not in row:
                continue
            sitemap = _opt_bool(row, "sitemap_present")
            db_present = _opt_bool(row, "db_present")
            eligible += 1
            if sitemap != db_present:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("sitemap_present")
        return _gt_result(module_id, "sitemap_database_mismatches", mismatch, config, 0,
                          {"eligible_pages": eligible}, "SITEMAP_DB_CONSISTENCY")
    if index == 14:
        clusters = set()
        for row in rows:
            cluster = _opt_str(row, "query_cluster")
            if cluster:
                clusters.add(cluster.casefold())
        if not clusters:
            raise _InsufficientData("query_cluster")
        return _lt_result(module_id, "semantic_query_clusters", len(clusters), config, 1,
                          {"clusters": sorted(clusters)}, "SEMANTIC_QUERY_GROUPING")
    if index == 15:
        unstable = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 0, 1_000_000)
        for row in rows:
            if "transaction_errors" not in row:
                continue
            eligible += 1
            if _req_int(row, "transaction_errors", 1_000_000) > threshold:
                unstable += 1
        if eligible == 0:
            raise _InsufficientData("transaction_errors")
        return EvalResult("unstable_database_records", unstable, unstable > 0,
                          {"comparison": "ERRORS_GT", "threshold": threshold},
                          {"eligible_records": eligible}, "DATABASE_STABILITY_ISSUES",
                          "DATABASE_STABILITY_WITHIN_POLICY")
    if index == 16:
        missing = 0
        eligible = 0
        for row in rows:
            brand = _opt_str(row, "brand_entity")
            entities = [value.casefold() for value in _list_str(row, "entities")]
            if not brand:
                continue
            eligible += 1
            if brand.casefold() not in entities:
                missing += 1
        if eligible == 0:
            raise _InsufficientData("brand_entity")
        return _gt_result(module_id, "brand_entity_misses", missing, config, 0,
                          {"eligible_pages": eligible}, "BRAND_ENTITY_MATCH")
    if index == 17:
        lengths = [len(_req_str(row, "url")) for row in rows]
        value = max(lengths) if lengths else 0
        return _gt_result(module_id, "max_url_length", value, config, 120,
                          {"lengths": lengths}, "URL_LENGTH", 10_000)
    if index == 18:
        mismatches = 0
        eligible = 0
        for row in rows:
            expected = _opt_str(row, "expected_season")
            actual = _opt_str(row, "content_season")
            if not expected or not actual:
                continue
            eligible += 1
            if expected.casefold() != actual.casefold():
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("expected_season")
        return _gt_result(module_id, "seasonal_content_mismatches", mismatches, config, 0,
                          {"eligible_pages": eligible}, "SEASONAL_CONTENT_VARIANTS")
    if index == 19:
        unsafe = 0
        eligible = 0
        for row in rows:
            slug = _opt_str(row, "slug")
            if not slug:
                continue
            eligible += 1
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
                unsafe += 1
        if eligible == 0:
            raise _InsufficientData("slug")
        return _gt_result(module_id, "unsafe_slug_encodings", unsafe, config, 0,
                          {"eligible_slugs": eligible}, "SAFE_SLUG_ENCODING")
    if index == 20:
        failed = 0
        eligible = 0
        for row in rows:
            if "integrity_verified" not in row:
                continue
            eligible += 1
            if not _opt_bool(row, "integrity_verified"):
                failed += 1
        if eligible == 0:
            raise _InsufficientData("integrity_verified")
        return _gt_result(module_id, "integrity_verification_failures", failed, config, 0,
                          {"eligible_records": eligible}, "INTEGRITY_VERIFICATION_STATE")
    if index == 21:
        scores = []
        for row in rows:
            if "graph_growth_ppm" in row:
                scores.append(_req_int(row, "graph_growth_ppm", PPM))
        if not scores:
            raise _InsufficientData("graph_growth_ppm")
        value = sum(scores) // len(scores)
        return _lt_result(module_id, "average_graph_growth_ppm", value, config, 1,
                          {"scores_ppm": scores}, "INTERNAL_GRAPH_GROWTH", PPM)
    if index == 22:
        categories = set()
        for row in rows:
            if _opt_bool(row, "purchase_intent"):
                category = _opt_str(row, "category")
                if category:
                    categories.add(category.casefold())
        if not categories:
            raise _InsufficientData("purchase_intent_categories")
        return _lt_result(module_id, "purchase_intent_categories", len(categories), config, 1,
                          {"categories": sorted(categories)}, "PURCHASE_INTENT_CATEGORY_GROUPING")
    if index == 23:
        waits = []
        for row in rows:
            if "lock_wait_ms" in row:
                waits.append(_req_int(row, "lock_wait_ms", 86_400_000))
        if not waits:
            raise _InsufficientData("lock_wait_ms")
        value = max(waits)
        return _gt_result(module_id, "max_transaction_lock_wait_ms", value, config, 500,
                          {"waits_ms": waits}, "TRANSACTION_QUEUE_LOCK", 86_400_000)
    if index == 24:
        value = 0
        for row in rows:
            value += len([entity for entity in _list_str(row, "commerce_entities") if entity.strip()])
        return _lt_result(module_id, "ecommerce_entities", value, config, 1, {},
                          "ECOMMERCE_ENTITY_EXTRACTION")
    if index == 25:
        signatures = []
        for row in rows:
            signature = _opt_str(row, "schema_signature")
            if signature:
                signatures.append(signature)
        if not signatures:
            raise _InsufficientData("schema_signature")
        duplicates = len(signatures) - len(set(signatures))
        return _gt_result(module_id, "duplicate_schema_signatures", duplicates, config, 0,
                          {"signatures": len(signatures)}, "UNIQUE_SCHEMA_SIGNATURES")
    raise _InvalidData("UNKNOWN_CANONICALIZATION_OPERATION")

from __future__ import annotations

from .mass_lot_common import *

def _persistence_state(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                       config: Mapping[str, Any]) -> EvalResult:
    if index == 1:
        orphan = 0
        eligible = 0
        for row in rows:
            if "route" not in row:
                continue
            route = _req_str(row, "route")
            known = set(_list_str(row, "known_routes"))
            if not known:
                continue
            eligible += 1
            if route not in known:
                orphan += 1
        if eligible == 0:
            raise _InsufficientData("known_routes")
        return _gt_result(module_id, "orphan_routes", orphan, config, 0, {"eligible_records": eligible}, "ORPHAN_ROUTE_GC")
    if index == 2:
        locks: Dict[str, set[str]] = {}
        for row in rows:
            key = _opt_str(row, "lock_key")
            owner = _opt_str(row, "lock_owner")
            active = _opt_bool(row, "lock_active")
            if key and owner and active:
                locks.setdefault(key, set()).add(owner)
        collisions = sum(1 for owners in locks.values() if len(owners) > 1)
        if not locks:
            raise _InsufficientData("locks")
        return _gt_result(module_id, "concurrent_lock_collisions", collisions, config, 0, {"active_lock_keys": len(locks)}, "JOB_CONCURRENCY")
    if index == 3:
        groups: Dict[str, set[str]] = {}
        for row in rows:
            group = _opt_str(row, "transaction_group")
            state = _opt_str(row, "transaction_state").upper()
            if group and state:
                if state not in {"PENDING", "COMMITTED", "ROLLED_BACK"}:
                    raise _InvalidData("transaction_state")
                groups.setdefault(group, set()).add(state)
        if not groups:
            raise _InsufficientData("transaction_group")
        mixed = sum(1 for states in groups.values() if "COMMITTED" in states and "ROLLED_BACK" in states)
        return _gt_result(module_id, "mixed_transaction_outcomes", mixed, config, 0, {"transaction_groups": len(groups)}, "ATOMIC_TRANSACTION_GROUPING")
    if index == 4:
        hashes: List[str] = []
        missing = 0
        for row in rows:
            value = row.get("content_hash")
            if value is None:
                missing += 1
                continue
            if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
                raise _InvalidData("content_hash")
            hashes.append(value)
        if not hashes:
            raise _InsufficientData("content_hash")
        site_hash = canonical_hash({"content_hashes": sorted(hashes)})
        return _gt_result(module_id, "missing_content_hashes", missing, config, 0, {"site_hash": site_hash, "hashed_records": len(hashes)}, "SITE_HASH_COMPLETENESS")
    if index == 5:
        volatile = 0
        eligible = 0
        for row in rows:
            versions = _opt_list(row, "vector_versions")
            if not versions:
                continue
            if any(not isinstance(item, str) for item in versions):
                raise _InvalidData("vector_versions")
            eligible += 1
            changes = sum(1 for a, b in zip(versions, versions[1:]) if a != b)
            if changes > 2:
                volatile += 1
        if eligible == 0:
            raise _InsufficientData("vector_versions")
        return _gt_result(module_id, "high_volatility_vectors", volatile, config, 0, {"eligible_records": eligible}, "VECTOR_VOLATILITY")
    if index == 6:
        expired = 0
        eligible = 0
        for row in rows:
            if "expires_at_epoch" not in row or "observed_at_epoch" not in row:
                continue
            expires = _req_int(row, "expires_at_epoch")
            observed = _req_int(row, "observed_at_epoch")
            status = _opt_str(row, "job_status", "PENDING").upper()
            eligible += 1
            if status in {"PENDING", "RUNNING", "RETRY"} and expires <= observed:
                expired += 1
        if eligible == 0:
            raise _InsufficientData("expires_at_epoch")
        return _gt_result(module_id, "expired_active_jobs", expired, config, 0, {"eligible_jobs": eligible}, "JOB_EXPIRATION")
    if index == 7:
        savings = 0
        eligible = 0
        for row in rows:
            payload = row.get("json_payload")
            if payload is None:
                continue
            if not isinstance(payload, (dict, list)):
                raise _InvalidData("json_payload")
            raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            compressed = zlib.compress(raw, level=9)
            eligible += 1
            savings += max(0, len(raw) - len(compressed))
        if eligible == 0:
            raise _InsufficientData("json_payload")
        return _gt_result(module_id, "json_compression_savings_bytes", savings, config, 128, {"eligible_payloads": eligible}, "JSON_VECTOR_COMPRESSION")
    if index == 8:
        counts: Dict[str, int] = {}
        for row in rows:
            partition = _opt_str(row, "history_partition")
            if partition:
                counts[partition] = counts.get(partition, 0) + 1
        if len(counts) < 2:
            raise _InsufficientData("history_partition")
        skew = max(counts.values()) - min(counts.values())
        return _gt_result(module_id, "history_partition_skew", skew, config, 10, {"partition_counts": dict(sorted(counts.items()))}, "HISTORICAL_PARTITION_BALANCE")
    if index == 9:
        keys: List[str] = []
        for row in rows:
            key = _opt_str(row, "primary_key")
            if key:
                keys.append(key)
        if not keys:
            raise _InsufficientData("primary_key")
        duplicates = len(keys) - len(set(keys))
        return _gt_result(module_id, "duplicate_primary_keys", duplicates, config, 0, {"keys": len(keys)}, "PRIMARY_KEY_INTEGRITY")
    if index == 10:
        sections: Dict[str, str] = {}
        parent_refs: List[str] = []
        for row in rows:
            section = _opt_str(row, "section_id")
            parent = _opt_str(row, "parent_section_id")
            if section:
                sections[section] = parent
                if parent:
                    parent_refs.append(parent)
        if not sections:
            raise _InsufficientData("section_id")
        orphan = sum(1 for parent in parent_refs if parent not in sections)
        return _gt_result(module_id, "orphan_section_relations", orphan, config, 0, {"sections": len(sections)}, "SECTION_RELATION_MAPPING")
    if index == 11:
        expected = _config_threshold(config, module_id, 1, 10_000)
        mismatch = 0
        eligible = 0
        for row in rows:
            if "schema_version" not in row:
                continue
            value = _req_int(row, "schema_version", 10_000)
            eligible += 1
            if value != expected:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("schema_version")
        return EvalResult("schema_version_mismatches", mismatch, mismatch > 0,
                          {"comparison": "EQ", "expected_schema_version": expected},
                          {"eligible_records": eligible}, "TABLE_SCHEMA_MISMATCH", "TABLE_SCHEMA_MATCH")
    if index == 12:
        hashes: List[str] = []
        for row in rows:
            value = _opt_str(row, "queue_payload_hash")
            if value:
                hashes.append(value)
        if not hashes:
            raise _InsufficientData("queue_payload_hash")
        duplicates = len(hashes) - len(set(hashes))
        return _gt_result(module_id, "duplicate_queue_payloads", duplicates, config, 0, {"payloads": len(hashes)}, "QUEUE_DEDUPLICATION")
    if index == 13:
        missing = 0
        eligible = 0
        for row in rows:
            if "grounding_match" not in row:
                continue
            match = _opt_bool(row, "grounding_match")
            indexed = _opt_bool(row, "grounding_indexed")
            eligible += 1
            if match and not indexed:
                missing += 1
        if eligible == 0:
            raise _InsufficientData("grounding_match")
        return _gt_result(module_id, "unindexed_grounding_matches", missing, config, 0, {"eligible_records": eligible}, "GROUNDING_INDEX")
    if index == 14:
        allowed = {"DRAFT", "PUBLISHED", "ARCHIVED", "FAILED", "PENDING"}
        invalid = 0
        counts: Dict[str, int] = {}
        eligible = 0
        for row in rows:
            state = _opt_str(row, "publication_state")
            if not state:
                continue
            eligible += 1
            upper = state.upper()
            counts[upper] = counts.get(upper, 0) + 1
            if upper not in allowed:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("publication_state")
        return _gt_result(module_id, "unknown_publication_states", invalid, config, 0, {"state_counts": dict(sorted(counts.items()))}, "PUBLICATION_STATE_COUNT")
    if index == 15:
        violations = 0
        eligible = 0
        for row in rows:
            if "retry_count" not in row:
                continue
            retry_count = _req_int(row, "retry_count", 1000)
            next_retry = _opt_int(row, "next_retry_epoch")
            observed = _opt_int(row, "observed_at_epoch")
            eligible += 1
            if retry_count > 0 and (next_retry == 0 or (observed and next_retry <= observed)):
                violations += 1
        if eligible == 0:
            raise _InsufficientData("retry_count")
        return _gt_result(module_id, "retry_backoff_violations", violations, config, 0, {"eligible_records": eligible}, "EXPONENTIAL_RETRY_POLICY")
    if index == 16:
        non_normal = 0
        eligible = 0
        for row in rows:
            if "text_value" not in row:
                continue
            value = row["text_value"]
            if not isinstance(value, str):
                raise _InvalidData("text_value")
            eligible += 1
            if value != unicodedata.normalize("NFC", value):
                non_normal += 1
        if eligible == 0:
            raise _InsufficientData("text_value")
        return _gt_result(module_id, "non_nfc_database_strings", non_normal, config, 0, {"eligible_records": eligible}, "UTF8_NORMALIZATION")
    if index == 17:
        jobs: List[Tuple[int, int]] = []
        for row in rows:
            if "queue_position" in row and "priority" in row:
                jobs.append((_req_int(row, "queue_position", 1_000_000), _req_int(row, "priority", 1_000_000)))
        if len(jobs) < 2:
            raise _InsufficientData("queue_priority")
        jobs.sort()
        inversions = 0
        max_priority = -1
        for _, priority in jobs:
            if max_priority > priority:
                inversions += 1
            max_priority = max(max_priority, priority)
        return _gt_result(module_id, "queue_priority_inversions", inversions, config, 0, {"jobs": len(jobs)}, "JOB_PRIORITY_GROUPING")
    if index == 18:
        mismatch = 0
        eligible = 0
        for row in rows:
            sitemap = _opt_str(row, "sitemap_hash")
            db_hash = _opt_str(row, "db_sitemap_hash")
            if not sitemap or not db_hash:
                continue
            eligible += 1
            if sitemap != db_hash:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("sitemap_hash")
        return _gt_result(module_id, "unsynced_sitemap_hashes", mismatch, config, 0, {"eligible_records": eligible}, "SITEMAP_CHANGE_TRACKING")
    if index == 19:
        mismatch = 0
        eligible = 0
        for row in rows:
            snapshot = _opt_str(row, "snapshot_hash")
            expected = _opt_str(row, "expected_snapshot_hash")
            if not snapshot or not expected:
                continue
            eligible += 1
            if snapshot != expected:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("snapshot_hash")
        return _gt_result(module_id, "snapshot_consistency_failures", mismatch, config, 0, {"eligible_records": eligible}, "SNAPSHOT_CONSISTENCY")
    if index == 20:
        stale = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 86_400, 31_536_000)
        for row in rows:
            if not _opt_bool(row, "is_temp"):
                continue
            observed = _opt_int(row, "observed_at_epoch")
            updated = _opt_int(row, "updated_at_epoch")
            if not observed or not updated:
                continue
            eligible += 1
            if observed >= updated and observed - updated > threshold:
                stale += 1
        if eligible == 0:
            raise _InsufficientData("temporary_table_age")
        return EvalResult("stale_temporary_records", stale, stale > 0,
                          {"comparison": "AGE_GT", "max_age_seconds": threshold},
                          {"eligible_records": eligible}, "TEMP_TABLE_STALE_RECORDS", "TEMP_TABLE_CLEAN")
    if index == 21:
        over = 0
        eligible = 0
        threshold = _config_threshold(config, module_id, 64_000_000, INT64_MAX)
        for row in rows:
            if "grounding_cache_bytes" not in row:
                continue
            size = _req_int(row, "grounding_cache_bytes")
            eligible += 1
            if size > threshold:
                over += 1
        if eligible == 0:
            raise _InsufficientData("grounding_cache_bytes")
        return EvalResult("grounding_cache_over_budget", over, over > 0,
                          {"comparison": "BYTES_GT", "max_cache_bytes": threshold},
                          {"eligible_records": eligible}, "GROUNDING_CACHE_OVERSIZE", "GROUNDING_CACHE_WITHIN_BUDGET")
    if index == 22:
        versions: List[Tuple[int, int]] = []
        for row in rows:
            if "observed_at_epoch" in row and "config_version" in row:
                versions.append((_req_int(row, "observed_at_epoch"), _req_int(row, "config_version", 1_000_000)))
        if len(versions) < 2:
            raise _InsufficientData("config_version_history")
        versions.sort()
        regressions = sum(1 for (_, a), (_, b) in zip(versions, versions[1:]) if b < a)
        return _gt_result(module_id, "config_version_regressions", regressions, config, 0, {"observations": len(versions)}, "CONFIG_VERSION_HISTORY")
    if index == 23:
        missing = 0
        eligible = 0
        for row in rows:
            if "route_query_indexed" not in row:
                continue
            eligible += 1
            if not _opt_bool(row, "route_query_indexed"):
                missing += 1
        if eligible == 0:
            raise _InsufficientData("route_query_indexed")
        return _gt_result(module_id, "unindexed_route_queries", missing, config, 0, {"eligible_records": eligible}, "ROUTE_QUERY_INDEX")
    if index == 24:
        broken = 0
        eligible = 0
        for row in rows:
            if "broken_refs" not in row:
                continue
            refs = _list_str(row, "broken_refs")
            eligible += 1
            broken += len(refs)
        if eligible == 0:
            raise _InsufficientData("broken_refs")
        return _gt_result(module_id, "broken_internal_references", broken, config, 0, {"eligible_records": eligible}, "BROKEN_REFERENCE_RELINK")
    if index == 25:
        anomalies = 0
        eligible = 0
        for row in rows:
            if "table_health" not in row:
                continue
            health = _opt_dict(row, "table_health")
            index_ok = health.get("index_ok")
            vacuum_age = health.get("vacuum_age_seconds")
            if type(index_ok) is not bool or type(vacuum_age) is not int or vacuum_age < 0:
                raise _InvalidData("table_health")
            eligible += 1
            if not index_ok or vacuum_age > 604_800:
                anomalies += 1
        if eligible == 0:
            raise _InsufficientData("table_health")
        return _gt_result(module_id, "table_health_anomalies", anomalies, config, 0, {"eligible_records": eligible}, "TABLE_HEALTH")
    raise _InvalidData("UNKNOWN_PERSISTENCE_OPERATION")

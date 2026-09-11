from __future__ import annotations

from .mass_lot_common import *

def _edge_gateway(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                  config: Mapping[str, Any]) -> EvalResult:
    if index == 1:
        invalid = 0
        eligible = 0
        for row in rows:
            payload = row.get("payload")
            if payload is None:
                continue
            eligible += 1
            if not isinstance(payload, dict) or "site_id" not in payload or "source_revision" not in payload:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("payload")
        return _gt_result(module_id, "invalid_edge_payloads", invalid, config, 0, {"eligible_requests": eligible}, "EDGE_PAYLOAD_FORMAT")
    if index == 2:
        missing = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            token = headers.get("x-nexus-seo-token") or headers.get("authorization")
            if not token:
                missing += 1
        return _gt_result(module_id, "requests_missing_secure_token", missing, config, 0, {}, "SECURE_HEADER_TOKEN")
    if index == 3:
        errors = 0
        for row in rows:
            status = _req_int(row, "status_code", 599)
            if status >= 500:
                errors += 1
        return _gt_result(module_id, "cloudflare_api_5xx_responses", errors, config, 0, {}, "CLOUDFLARE_API_ERRORS")
    if index == 4:
        mismatch = 0
        eligible = 0
        for row in rows:
            actual = _opt_str(row, "signature")
            expected = _opt_str(row, "expected_signature")
            if not actual or not expected:
                continue
            eligible += 1
            if actual != expected:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("signature")
        return _gt_result(module_id, "edge_signature_mismatches", mismatch, config, 0, {"eligible_requests": eligible}, "EDGE_DIGITAL_SIGNATURE")
    if index == 5:
        required = {"content-type", "cache-control"}
        missing = 0
        for row in rows:
            headers = _headers_lower(row, "response_headers")
            missing += len(required - set(headers))
        return _gt_result(module_id, "missing_success_response_headers", missing, config, 0, {"required_headers": sorted(required)}, "SUCCESS_HEADERS")
    if index == 6:
        fallback = 0
        eligible = 0
        for row in rows:
            if "fallback_used" not in row:
                continue
            eligible += 1
            if _opt_bool(row, "fallback_used"):
                fallback += 1
        if eligible == 0:
            raise _InsufficientData("fallback_used")
        return _gt_result(module_id, "dynamic_fallback_activations", fallback, config, 0, {"eligible_requests": eligible}, "DYNAMIC_FALLBACK")
    if index == 7:
        values = [_req_int(row, "latency_ms", 86_400_000) for row in rows]
        value = max(values) if values else 0
        return _gt_result(module_id, "max_publish_latency_ms", value, config, 250, {"latencies_ms": values}, "EDGE_PUBLISH_LATENCY", 86_400_000)
    if index == 8:
        invalid = 0
        eligible = 0
        for row in rows:
            key = _opt_str(row, "kv_key")
            if not key:
                continue
            eligible += 1
            site_id = _opt_str(row, "site_id")
            expected_prefix = f"seo:{site_id}:" if site_id else "seo:"
            if not key.startswith(expected_prefix):
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("kv_key")
        return _gt_result(module_id, "invalid_kv_key_prefixes", invalid, config, 0, {"eligible_keys": eligible}, "DYNAMIC_KV_PREFIX")
    if index == 9:
        invalid = 0
        eligible = 0
        for row in rows:
            schema = row.get("worker_schema")
            if schema is None:
                continue
            eligible += 1
            if not isinstance(schema, dict) or not {"schema_version", "site_id"}.issubset(schema):
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("worker_schema")
        return _gt_result(module_id, "invalid_worker_json_schemas", invalid, config, 0, {"eligible_schemas": eligible}, "WORKER_JSON_SCHEMA")
    if index == 10:
        values = [_opt_int(row, "kv_writes") for row in rows if "kv_writes" in row]
        if not values:
            raise _InsufficientData("kv_writes")
        value = max(values)
        return _gt_result(module_id, "max_kv_writes_per_window", value, config, 900, {"writes": values}, "KV_WRITE_QUOTA", 10_000_000)
    if index == 11:
        invalid = 0
        for row in rows:
            endpoint = _req_str(row, "endpoint")
            parsed = urlparse(endpoint)
            if parsed.scheme != "https" or not parsed.hostname:
                invalid += 1
        return _gt_result(module_id, "insecure_publisher_endpoints", invalid, config, 0, {}, "PUBLISHER_ENDPOINT_SECURITY")
    if index == 12:
        lagging = 0
        eligible = 0
        for row in rows:
            if "snapshot_version" not in row or "expected_snapshot_version" not in row:
                continue
            current = _req_int(row, "snapshot_version", 1_000_000_000)
            expected = _req_int(row, "expected_snapshot_version", 1_000_000_000)
            eligible += 1
            if expected - current > 1:
                lagging += 1
        if eligible == 0:
            raise _InsufficientData("snapshot_version")
        return _gt_result(module_id, "bulk_resync_candidates", lagging, config, 0, {"eligible_requests": eligible}, "EMERGENCY_BULK_RESYNC")
    if index == 13:
        unsafe = 0
        eligible = 0
        for row in rows:
            if "fail_open_state" not in row:
                continue
            state = _req_str(row, "fail_open_state").upper()
            eligible += 1
            if state not in {"BASE_RESPONSE", "BYPASS_SUITE", "NATIVE_ORIGIN"}:
                unsafe += 1
        if eligible == 0:
            raise _InsufficientData("fail_open_state")
        return _gt_result(module_id, "unsafe_fail_open_states", unsafe, config, 0, {"eligible_requests": eligible}, "FAIL_OPEN_STATE")
    if index == 14:
        non_200 = 0
        for row in rows:
            status = _req_int(row, "base_status_code", 599)
            if status != 200:
                non_200 += 1
        return _gt_result(module_id, "base_non_200_responses", non_200, config, 0, {}, "BASE_HTTP_STATUS")
    if index == 15:
        missing = 0
        for row in rows:
            headers = _headers_lower(row, "response_headers")
            encoding = headers.get("content-encoding", "").casefold()
            if encoding not in {"br", "gzip", "zstd"}:
                missing += 1
        return _gt_result(module_id, "responses_without_compression_tag", missing, config, 0, {}, "COMPRESSION_CONTROL")
    if index == 16:
        loops = 0
        eligible = 0
        for row in rows:
            chain = _list_str(row, "redirect_chain")
            if not chain:
                continue
            eligible += 1
            if len(chain) != len(set(chain)):
                loops += 1
        if eligible == 0:
            raise _InsufficientData("redirect_chain")
        return _gt_result(module_id, "redirect_loops", loops, config, 0, {"eligible_requests": eligible}, "REDIRECT_LOOP")
    if index == 17:
        value = 0
        eligible = 0
        for row in rows:
            if "exclusion_reasons" not in row:
                continue
            reasons = _list_str(row, "exclusion_reasons")
            eligible += 1
            value += len(set(reason for reason in reasons if reason.strip()))
        if eligible == 0:
            raise _InsufficientData("exclusion_reasons")
        return _gt_result(module_id, "unique_exclusion_reasons", value, config, 10, {"eligible_requests": eligible}, "EXCLUSION_METRICS")
    if index == 18:
        mismatches = 0
        eligible = 0
        for row in rows:
            target = _req_str(row, "target_domain").casefold()
            expected = _opt_str(row, "expected_target_domain").casefold()
            if not expected:
                continue
            eligible += 1
            if target != expected:
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("expected_target_domain")
        return _gt_result(module_id, "target_domain_mismatches", mismatches, config, 0, {"eligible_requests": eligible}, "TARGET_DOMAIN_MATCH")
    if index == 19:
        misses = 0
        eligible = 0
        for row in rows:
            if "cache_hit" not in row:
                continue
            eligible += 1
            if not _opt_bool(row, "cache_hit"):
                misses += 1
        if eligible == 0:
            raise _InsufficientData("cache_hit")
        rate = _ppm(misses, eligible)
        return _gt_result(module_id, "cache_miss_rate_ppm", rate, config, 500_000, {"misses": misses, "eligible": eligible}, "CACHE_RESPONSE_MAPPING", PPM)
    if index == 20:
        forbidden = {"server", "x-powered-by", "x-debug-token", "x-internal-route"}
        exposed = 0
        for row in rows:
            headers = _headers_lower(row, "response_headers")
            exposed += len(forbidden.intersection(headers))
        return _gt_result(module_id, "unsafe_custom_headers", exposed, config, 0, {"forbidden": sorted(forbidden)}, "CUSTOM_HEADER_SANITIZATION")
    if index == 21:
        gaps = 0
        eligible = 0
        for row in rows:
            if "snapshot_version" not in row or "previous_snapshot_version" not in row:
                continue
            current = _req_int(row, "snapshot_version", 1_000_000_000)
            previous = _req_int(row, "previous_snapshot_version", 1_000_000_000)
            eligible += 1
            if current != previous + 1:
                gaps += 1
        if eligible == 0:
            raise _InsufficientData("previous_snapshot_version")
        return _gt_result(module_id, "incremental_snapshot_sequence_gaps", gaps, config, 0, {"eligible_requests": eligible}, "INCREMENTAL_SNAPSHOT_DEPLOY")
    if index == 22:
        mismatches = 0
        eligible = 0
        for row in rows:
            policy = _opt_str(row, "policy_version")
            expected = _opt_str(row, "expected_policy_version")
            if not policy or not expected:
                continue
            eligible += 1
            if policy != expected:
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("policy_version")
        return _gt_result(module_id, "policy_version_mismatches", mismatches, config, 0, {"eligible_requests": eligible}, "POLICY_COMPLIANCE")
    if index == 23:
        sizes = [_req_int(row, "response_bytes", 1_000_000_000) for row in rows]
        value = max(sizes) if sizes else 0
        return _gt_result(module_id, "max_response_bytes", value, config, 1_500_000, {"response_bytes": sizes}, "RESPONSE_WEIGHT", 1_000_000_000)
    if index == 24:
        missing = 0
        eligible = 0
        for row in rows:
            signature = _opt_str(row, "suite_signature")
            if "suite_signature" in row:
                eligible += 1
                if not signature:
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("suite_signature")
        return _gt_result(module_id, "missing_suite_signatures", missing, config, 0, {"eligible_requests": eligible}, "SUITE_SIGNATURE_DISTRIBUTION")
    if index == 25:
        failures = 0
        eligible = 0
        for row in rows:
            if "health_ok" not in row:
                continue
            eligible += 1
            if not _opt_bool(row, "health_ok"):
                failures += 1
        if eligible == 0:
            raise _InsufficientData("health_ok")
        return _gt_result(module_id, "health_check_failures", failures, config, 0, {"eligible_requests": eligible}, "UNIFIED_HEALTH_CHECK")
    raise _InvalidData("UNKNOWN_EDGE_GATEWAY_OPERATION")

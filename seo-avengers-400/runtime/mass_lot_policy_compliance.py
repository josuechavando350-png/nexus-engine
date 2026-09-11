from __future__ import annotations

from .mass_lot_common import *


def _policy_compliance(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                       config: Mapping[str, Any]) -> EvalResult:
    if index == 1:
        violations = 0
        for row in rows:
            directives = {item.casefold() for item in _list_str(row, "robots_directives")}
            if "noindex" in directives and _opt_bool(row, "expected_indexable", True):
                violations += 1
            if "nofollow" in directives and _opt_bool(row, "expected_followable", True):
                violations += 1
        return _gt_result(module_id, "googlebot_directive_violations", violations, config, 0, {}, "GOOGLEBOT_DIRECTIVES")
    if index == 2:
        mismatches = 0
        eligible = 0
        for row in rows:
            user_html = _opt_str(row, "user_html")
            bot_html = _opt_str(row, "bot_html")
            if not user_html or not bot_html:
                continue
            eligible += 1
            if _normalized_html_text(user_html) != _normalized_html_text(bot_html):
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("user_html_bot_html")
        return _gt_result(module_id, "render_cloaking_mismatches", mismatches, config, 0,
                          {"eligible_pages": eligible}, "CLOAKING_PATTERN")
    if index == 3:
        unsafe = 0
        for row in rows:
            status = _req_int(row, "status_code", 599)
            body = _opt_str(row, "response_body")
            if status >= 500 and (not body or len(body.encode("utf-8")) > 256_000):
                unsafe += 1
        return _gt_result(module_id, "unsafe_error_responses", unsafe, config, 0, {}, "SAFE_ERROR_RESPONSE")
    if index == 4:
        mismatch = 0
        eligible = 0
        for row in rows:
            actual = _opt_str(row, "token_hash")
            expected = _opt_str(row, "expected_token_hash")
            if not actual or not expected:
                continue
            eligible += 1
            if actual != expected:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("token_hash")
        return _gt_result(module_id, "edge_token_hash_mismatches", mismatch, config, 0,
                          {"eligible_requests": eligible}, "EDGE_TOKEN_MATCH")
    if index == 5:
        invalid = 0
        eligible = 0
        for row in rows:
            if _req_int(row, "status_code", 599) != 503:
                continue
            eligible += 1
            headers = _headers_lower(row, "headers")
            if "retry-after" not in headers:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("http_503")
        return _gt_result(module_id, "unclean_503_responses", invalid, config, 0,
                          {"eligible_503": eligible}, "CLEAN_503_RESPONSE")
    if index == 6:
        forbidden = {"server", "x-powered-by", "x-debug-token", "x-origin-host", "x-internal-route"}
        exposed = 0
        for row in rows:
            exposed += len(forbidden.intersection(_headers_lower(row, "headers")))
        return _gt_result(module_id, "exposed_sensitive_headers", exposed, config, 0,
                          {"forbidden_headers": sorted(forbidden)}, "EXPOSED_HEADER_SANITIZATION")
    if index == 7:
        values = [_req_int(row, "transform_ms", 86_400_000) for row in rows if "transform_ms" in row]
        if not values:
            raise _InsufficientData("transform_ms")
        return _gt_result(module_id, "max_transform_time_ms", max(values), config, 10,
                          {"transform_ms": values}, "TRANSFORM_RESPONSE_TIME", 86_400_000)
    if index == 8:
        errors = 0
        eligible = 0
        for row in rows:
            if "origin_status_code" not in row:
                continue
            eligible += 1
            if _req_int(row, "origin_status_code", 599) >= 500:
                errors += 1
        if eligible == 0:
            raise _InsufficientData("origin_status_code")
        return _gt_result(module_id, "origin_server_errors", errors, config, 0,
                          {"eligible_requests": eligible}, "ORIGIN_SERVER_RESPONSE")
    if index == 9:
        invalid = 0
        eligible = 0
        for row in rows:
            target = _opt_str(row, "target_domain").casefold()
            allowed = [item.casefold() for item in _list_str(row, "authorized_domains")]
            if not target or not allowed:
                continue
            eligible += 1
            if target not in allowed:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("authorized_domains")
        return _gt_result(module_id, "unauthorized_target_domains", invalid, config, 0,
                          {"eligible_requests": eligible}, "AUTHORIZED_TARGET_DOMAIN")
    if index == 10:
        missing = 0
        eligible = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            if headers:
                eligible += 1
                if not headers.get("x-nexus-seo-suite"):
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("headers")
        return _gt_result(module_id, "missing_suite_certification_headers", missing, config, 0,
                          {"eligible_responses": eligible}, "SUITE_CERTIFICATION_HEADER")
    if index == 11:
        duplicates = 0
        for row in rows:
            url = _req_str(row, "url")
            keys = [key.casefold() for key, _ in parse_qsl(urlparse(url).query, keep_blank_values=True)]
            duplicates += len(keys) - len(set(keys))
        return _gt_result(module_id, "duplicate_request_parameters", duplicates, config, 0, {}, "DUPLICATE_REQUEST_PARAMETERS")
    if index == 12:
        invalid = 0
        eligible = 0
        for row in rows:
            status = _req_int(row, "status_code", 599)
            if not 300 <= status < 400:
                continue
            eligible += 1
            location = _headers_lower(row, "headers").get("location", "")
            if not location or "\n" in location or "\r" in location:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("redirect_response")
        return _gt_result(module_id, "unclean_redirect_responses", invalid, config, 0,
                          {"eligible_redirects": eligible}, "CLEAN_REDIRECT_RESPONSE")
    if index == 13:
        allowed = {"Article", "BreadcrumbList", "FAQPage", "LocalBusiness", "Organization", "Person", "Product", "Service", "WebPage", "WebSite"}
        invalid = 0
        eligible = 0
        for row in rows:
            types = _list_str(row, "jsonld_types")
            if not types:
                continue
            eligible += 1
            invalid += sum(1 for value in types if value not in allowed)
        if eligible == 0:
            raise _InsufficientData("jsonld_types")
        return _gt_result(module_id, "unapproved_jsonld_types", invalid, config, 0,
                          {"eligible_documents": eligible, "allowed_types": sorted(allowed)}, "JSONLD_SCHEMA_POLICY")
    if index == 14:
        conflicts = 0
        eligible = 0
        for row in rows:
            robots_allowed = row.get("robots_allowed")
            expected = row.get("expected_robots_allowed")
            if robots_allowed is None or expected is None:
                continue
            if type(robots_allowed) is not bool or type(expected) is not bool:
                raise _InvalidData("robots_allowed")
            eligible += 1
            if robots_allowed != expected:
                conflicts += 1
        if eligible == 0:
            raise _InsufficientData("robots_allowed")
        return _gt_result(module_id, "robots_directive_conflicts", conflicts, config, 0,
                          {"eligible_paths": eligible}, "ROBOTS_EXCLUSION_POLICY")
    if index == 15:
        filler_patterns = [r"\blorem\s+ipsum\b", r"\bplaceholder\b", r"\b(?:TODO|FIXME|TBD|XXXX)\b", r"\bkeyword\s+keyword\s+keyword\b"]
        count = 0
        for row in rows:
            text = _req_str(row, "visible_text")
            count += sum(len(re.findall(pattern, text, flags=re.I)) for pattern in filler_patterns)
        return _gt_result(module_id, "artificial_filler_markers", count, config, 0, {}, "ARTIFICIAL_FILLER_CONTENT")
    if index == 16:
        invalid = 0
        eligible = 0
        for row in rows:
            content_type = _opt_str(row, "content_type")
            transfer = _opt_str(row, "transfer_mode")
            if not content_type and not transfer:
                continue
            eligible += 1
            if not content_type.casefold().startswith("text/html") or transfer.upper() not in {"STREAM", "CHUNKED", "BUFFERED"}:
                invalid += 1
        if eligible == 0:
            raise _InsufficientData("stream_format")
        return _gt_result(module_id, "invalid_stream_responses", invalid, config, 0,
                          {"eligible_responses": eligible}, "STREAM_RESPONSE_FORMAT")
    if index == 17:
        mismatch = 0
        eligible = 0
        for row in rows:
            site_id = _opt_str(row, "site_id")
            expected = _opt_str(row, "expected_site_id")
            if not site_id or not expected:
                continue
            eligible += 1
            if site_id != expected:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("site_id")
        return _gt_result(module_id, "site_id_consistency_failures", mismatch, config, 0,
                          {"eligible_records": eligible}, "SITE_ID_CONSISTENCY")
    if index == 18:
        invalid = 0
        eligible = 0
        for row in rows:
            text = _opt_str(row, "visible_text")
            if not text:
                continue
            eligible += 1
            invalid += sum(1 for char in text if ord(char) < 32 and char not in "\n\r\t")
        if eligible == 0:
            raise _InsufficientData("visible_text")
        return _gt_result(module_id, "invalid_control_characters", invalid, config, 0,
                          {"eligible_documents": eligible}, "INVALID_MARKED_CHARACTERS")
    if index == 19:
        duplicate = 0
        eligible = 0
        for row in rows:
            headings = [" ".join(_tokens(item)) for item in _list_str(row, "headings") if item.strip()]
            if not headings:
                continue
            eligible += 1
            duplicate += len(headings) - len(set(headings))
        if eligible == 0:
            raise _InsufficientData("headings")
        return _gt_result(module_id, "duplicate_content_headings", duplicate, config, 0,
                          {"eligible_documents": eligible}, "HEADING_DUPLICITY")
    if index == 20:
        values = [_req_int(row, "kv_storage_bytes", 9_000_000_000_000_000) for row in rows if "kv_storage_bytes" in row]
        if not values:
            raise _InsufficientData("kv_storage_bytes")
        return _gt_result(module_id, "max_kv_storage_bytes", max(values), config, 1_000_000_000,
                          {"storage_bytes": values}, "KV_STORAGE_QUOTA", 9_000_000_000_000_000)
    if index == 21:
        exposed = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            if "x-debug" in headers or "x-debug-id" in headers or "x-debug-token" in headers:
                exposed += 1
        return _gt_result(module_id, "debug_header_exposures", exposed, config, 0, {}, "DEBUG_HEADER_CONTROL")
    if index == 22:
        noncanonical = 0
        for row in rows:
            url = _req_str(row, "url")
            path = urlparse(url).path
            if path != "/" and path.endswith("/"):
                noncanonical += 1
            if "//" in path:
                noncanonical += 1
        return _gt_result(module_id, "noncanonical_path_slashes", noncanonical, config, 0, {}, "PATH_SLASH_NORMALIZATION")
    if index == 23:
        mismatch = 0
        eligible = 0
        for row in rows:
            renders = _opt_dict(row, "device_renders")
            if not renders:
                continue
            eligible += 1
            normalized = []
            for device, html in renders.items():
                if not isinstance(device, str) or not isinstance(html, str):
                    raise _InvalidData("device_renders")
                normalized.append(_normalized_html_text(html))
            if len(set(normalized)) > 1:
                mismatch += 1
        if eligible == 0:
            raise _InsufficientData("device_renders")
        return _gt_result(module_id, "device_render_parity_failures", mismatch, config, 0,
                          {"eligible_pages": eligible}, "DEVICE_RENDER_PARITY")
    if index == 24:
        suspicious_patterns = [r"<script\b[^>]*>.*?document\.write", r"javascript\s*:", r"onerror\s*=", r"<iframe\b[^>]*srcdoc="]
        count = 0
        for row in rows:
            html = _req_str(row, "html")
            count += sum(len(re.findall(pattern, html, flags=re.I | re.S)) for pattern in suspicious_patterns)
        return _gt_result(module_id, "malicious_semantic_injection_markers", count, config, 0, {}, "SEMANTIC_INJECTION_FILTER")
    if index == 25:
        failures = 0
        eligible = 0
        for row in rows:
            checks = _opt_dict(row, "closure_checks")
            if not checks:
                continue
            eligible += 1
            for name, value in checks.items():
                if not isinstance(name, str) or type(value) is not bool:
                    raise _InvalidData("closure_checks")
                if not value:
                    failures += 1
        if eligible == 0:
            raise _InsufficientData("closure_checks")
        return _gt_result(module_id, "closure_cycle_failures", failures, config, 0,
                          {"eligible_cycles": eligible}, "CLOSURE_CYCLE_CERTIFICATION")
    raise _InvalidData("UNKNOWN_POLICY_COMPLIANCE_OPERATION")

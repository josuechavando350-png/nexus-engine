from __future__ import annotations

from .mass_lot_common import *

def _cwv_edge(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
              config: Mapping[str, Any]) -> EvalResult:
    htmls = [_req_str(row, "html") for row in rows]
    if index == 1:
        missing = 0
        for html in htmls:
            origins = set(re.findall(r"https?://[^/\"'\s>]+", html, flags=re.I))
            preconnects = set(re.findall(r"<link\b[^>]*rel=[\"']preconnect[\"'][^>]*href=[\"'](https?://[^/\"']+)", html, flags=re.I))
            missing += len(origins - preconnects)
        return _gt_result(module_id, "origins_missing_preconnect", missing, config, 0, {}, "PRECONNECT_COVERAGE")
    if index == 2:
        unnecessary = 0
        for html in htmls:
            unnecessary += len(re.findall(r"\s(?:border|align|bgcolor|cellpadding|cellspacing)=[\"'][^\"']*[\"']", html, flags=re.I))
        return _gt_result(module_id, "obsolete_html_attributes", unnecessary, config, 0, {}, "HTML_ATTRIBUTE_MINIFICATION")
    if index == 3:
        savings = 0
        eligible = 0
        for html in htmls:
            for svg in re.findall(r"<svg\b.*?</svg\s*>", html, flags=re.I | re.S):
                eligible += 1
                compact = re.sub(r">\s+<", "><", re.sub(r"\s{2,}", " ", svg)).strip()
                savings += max(0, len(svg.encode("utf-8")) - len(compact.encode("utf-8")))
        if eligible == 0:
            raise _InsufficientData("inline_svg")
        return _gt_result(module_id, "svg_compression_savings_bytes", savings, config, 64, {"svg_count": eligible}, "SVG_COMPRESSION")
    if index == 4:
        missing = 0
        eligible = 0
        for html in htmls:
            images = re.findall(r"<img\b[^>]*>", html, flags=re.I)
            if not images:
                continue
            eligible += 1
            first = images[0]
            if not re.search(r"\bfetchpriority=[\"']high[\"']", first, flags=re.I):
                missing += 1
        if eligible == 0:
            raise _InsufficientData("images")
        return _gt_result(module_id, "hero_images_missing_fetchpriority", missing, config, 0, {"eligible_documents": eligible}, "FETCHPRIORITY")
    if index == 5:
        missing = 0
        eligible = 0
        for html in htmls:
            images = re.findall(r"<img\b[^>]*>", html, flags=re.I)
            for image in images[1:]:
                eligible += 1
                if not re.search(r"\bloading=[\"']lazy[\"']", image, flags=re.I):
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("below_fold_images")
        return _gt_result(module_id, "below_fold_images_missing_lazy", missing, config, 0, {"eligible_images": eligible}, "LAZY_LOADING")
    if index == 6:
        missing = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            if headers.get("content-encoding", "").casefold() not in {"br", "gzip", "zstd"}:
                missing += 1
        return _gt_result(module_id, "responses_without_advanced_compression", missing, config, 0, {}, "ADVANCED_COMPRESSION")
    if index == 7:
        blocking = 0
        for html in htmls:
            for script in re.findall(r"<script\b[^>]*src=[\"'][^\"']+[\"'][^>]*>", html, flags=re.I):
                if not re.search(r"\b(?:defer|async)\b", script, flags=re.I):
                    blocking += 1
        return _gt_result(module_id, "render_blocking_scripts", blocking, config, 0, {}, "RENDER_BLOCKING_JS")
    if index == 8:
        candidates = 0
        for row in rows:
            assets = _opt_list(row, "assets")
            for asset in assets:
                if not isinstance(asset, dict):
                    raise _InvalidData("assets")
                kind = asset.get("kind")
                size = asset.get("bytes")
                critical = asset.get("critical")
                if kind == "script" and type(size) is int and 0 <= size <= 2048 and critical is True:
                    candidates += 1
                elif kind is not None and not isinstance(kind, str):
                    raise _InvalidData("asset.kind")
        return _gt_result(module_id, "critical_micro_scripts_external", candidates, config, 0, {}, "CRITICAL_SCRIPT_INLINE")
    if index == 9:
        weak = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            cache = headers.get("cache-control", "")
            match = re.search(r"max-age=(\d+)", cache, flags=re.I)
            if not match or int(match.group(1)) < 300:
                weak += 1
        return _gt_result(module_id, "weak_cache_responses", weak, config, 0, {}, "CACHE_STATE")
    if index == 10:
        junk = {"utm_source", "utm_medium", "utm_campaign", "gclid", "fbclid", "mc_cid", "mc_eid"}
        count = 0
        for row in rows:
            url = _req_str(row, "url")
            params = [key.casefold() for key, _ in parse_qsl(urlparse(url).query, keep_blank_values=True)]
            count += sum(1 for key in params if key in junk)
        return _gt_result(module_id, "junk_query_parameters", count, config, 0, {"junk_parameters": sorted(junk)}, "JUNK_URL_PARAMETERS")
    if index == 11:
        missing = 0
        eligible = 0
        for html in htmls:
            for image in re.findall(r"<img\b[^>]*>", html, flags=re.I):
                eligible += 1
                if not re.search(r"\bwidth=[\"']\d+[\"']", image, flags=re.I) or not re.search(r"\bheight=[\"']\d+[\"']", image, flags=re.I):
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("images")
        return _gt_result(module_id, "images_missing_dimensions", missing, config, 0, {"eligible_images": eligible}, "IMAGE_ASPECT_RATIO")
    if index == 12:
        required = {"content-security-policy", "x-content-type-options", "referrer-policy"}
        missing = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            missing += len(required - set(headers))
        return _gt_result(module_id, "missing_security_headers", missing, config, 0, {"required_headers": sorted(required)}, "SECURITY_HEADERS")
    if index == 13:
        legacy = 0
        for html in htmls:
            fonts = re.findall(r"(?:src|href)=[\"']([^\"']+\.(?:ttf|otf|woff))(?:\?[^\"']*)?[\"']", html, flags=re.I)
            legacy += len(fonts)
        return _gt_result(module_id, "legacy_font_assets", legacy, config, 0, {}, "MODERN_FONT_FORMAT")
    if index == 14:
        dead = 0
        patterns = [r"if\s*\(\s*false\s*\)", r"if\s*\(\s*0\s*\)", r"/\*\s*dead\s*code\s*\*/"]
        for html in htmls:
            for script in re.findall(r"<script\b[^>]*>(.*?)</script\s*>", html, flags=re.I | re.S):
                dead += sum(len(re.findall(pattern, script, flags=re.I)) for pattern in patterns)
        return _gt_result(module_id, "dead_code_markers", dead, config, 0, {}, "DEAD_CODE_PURGE")
    if index == 15:
        mismatches = 0
        eligible = 0
        for row in rows:
            variants = _opt_dict(row, "user_agent_variants")
            if not variants:
                continue
            hashes = []
            for key, value in variants.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    raise _InvalidData("user_agent_variants")
                hashes.append(canonical_hash({"html": value}))
            eligible += 1
            if len(set(hashes)) > 1:
                mismatches += 1
        if eligible == 0:
            raise _InsufficientData("user_agent_variants")
        return _gt_result(module_id, "user_agent_render_variations", mismatches, config, 0, {"eligible_records": eligible}, "USER_AGENT_VARIATION")
    if index == 16:
        missing = 0
        eligible = 0
        for html in htmls:
            code_blocks = re.findall(r"<(?:code|pre)\b([^>]*)>", html, flags=re.I)
            for attrs in code_blocks:
                eligible += 1
                if not re.search(r"\btranslate=[\"']no[\"']", attrs, flags=re.I):
                    missing += 1
        if eligible == 0:
            raise _InsufficientData("code_blocks")
        return _gt_result(module_id, "code_blocks_missing_no_translate", missing, config, 0, {"eligible_blocks": eligible}, "NO_TRANSLATE_TAGS")
    if index == 17:
        chains = 0
        eligible = 0
        for row in rows:
            redirects = _list_str(row, "internal_redirect_chain")
            if not redirects:
                continue
            eligible += 1
            if len(redirects) > 1:
                chains += len(redirects) - 1
        if eligible == 0:
            raise _InsufficientData("internal_redirect_chain")
        return _gt_result(module_id, "extra_internal_redirect_hops", chains, config, 0, {"eligible_records": eligible}, "INTERNAL_REDIRECT_NORMALIZATION")
    if index == 18:
        sizes: List[int] = []
        for row, html in zip(rows, htmls):
            if "response_bytes" in row:
                sizes.append(_req_int(row, "response_bytes", 1_000_000_000))
            else:
                sizes.append(len(html.encode("utf-8")))
        value = max(sizes) if sizes else 0
        return _gt_result(module_id, "max_html_payload_bytes", value, config, 1_500_000, {"payload_bytes": sizes}, "HTML_PAYLOAD_SIZE", 1_000_000_000)
    if index == 19:
        exposed = 0
        eligible = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            if "x-geo-country" in headers or "x-geo-region" in headers:
                eligible += 1
                if not _opt_bool(row, "geo_headers_authorized"):
                    exposed += 1
        if eligible == 0:
            raise _InsufficientData("geo_headers")
        return _gt_result(module_id, "unauthorized_geolocation_headers", exposed, config, 0, {"eligible_records": eligible}, "GEOLOCATION_HEADER_POLICY")
    if index == 20:
        values = [_req_int(row, "latency_ms", 86_400_000) for row in rows]
        value = max(values) if values else 0
        return _gt_result(module_id, "max_server_response_latency_ms", value, config, 800, {"latencies_ms": values}, "SERVER_RESPONSE_TIME", 86_400_000)
    if index == 21:
        hidden = 0
        for html in htmls:
            hidden += len(re.findall(r"style=[\"'][^\"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^\"']*[\"']", html, flags=re.I))
        return _gt_result(module_id, "css_hidden_elements", hidden, config, 0, {}, "CSS_HIDDEN_ELEMENTS")
    if index == 22:
        missing = 0
        eligible = 0
        for row in rows:
            headers = _headers_lower(row, "headers")
            if "device" not in row:
                continue
            device = _req_str(row, "device").casefold()
            eligible += 1
            vary = headers.get("vary", "").casefold()
            if device in {"mobile", "desktop"} and "user-agent" not in vary:
                missing += 1
        if eligible == 0:
            raise _InsufficientData("device")
        return _gt_result(module_id, "device_responses_missing_vary", missing, config, 0, {"eligible_records": eligible}, "VARY_MOBILE")
    if index == 23:
        max_depth = 0
        for html in htmls:
            depth = 0
            local_max = 0
            for token in re.finditer(r"</?div\b[^>]*>", html, flags=re.I):
                tag = token.group(0)
                if tag.startswith("</"):
                    depth = max(0, depth - 1)
                else:
                    depth += 1
                    local_max = max(local_max, depth)
            max_depth = max(max_depth, local_max)
        return _gt_result(module_id, "max_nested_div_depth", max_depth, config, 12, {}, "DIV_NESTING")
    if index == 24:
        missing = 0
        eligible = 0
        for row in rows:
            critical = _list_str(row, "critical_assets")
            if not critical:
                continue
            eligible += 1
            html = _req_str(row, "html")
            preloads = set(re.findall(r"<link\b[^>]*rel=[\"']preload[\"'][^>]*href=[\"']([^\"']+)", html, flags=re.I))
            missing += sum(1 for asset in critical if asset not in preloads)
        if eligible == 0:
            raise _InsufficientData("critical_assets")
        return _gt_result(module_id, "critical_assets_without_preload", missing, config, 0, {"eligible_records": eligible}, "CRITICAL_SECTION_PRELOAD")
    if index == 25:
        values = []
        for row in rows:
            server = _req_int(row, "latency_ms", 86_400_000)
            transform = _opt_int(row, "transform_ms", 0, 86_400_000)
            client = _opt_int(row, "client_render_ms", 0, 86_400_000)
            values.append(server + transform + client)
        value = max(values) if values else 0
        return _gt_result(module_id, "max_end_to_end_output_ms", value, config, 2500, {"total_ms": values}, "END_TO_END_SPEED", 86_400_000)
    raise _InvalidData("UNKNOWN_CWV_OPERATION")

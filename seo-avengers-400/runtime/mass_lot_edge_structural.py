from __future__ import annotations

from .mass_lot_common import *

def _edge_structural(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                     config: Mapping[str, Any]) -> EvalResult:
    htmls = [_req_str(row, "html") for row in rows]
    uris = [_req_str(row, "uri") for row in rows]
    if index == 1:
        value = sum(len(re.findall(r"<!--\s*route\s*:", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "conditional_fragment_markers", value, config, 0, {}, "CONDITIONAL_FRAGMENT_ROUTING")
    if index == 2:
        missing = 0
        for html in htmls:
            for match in re.finditer(r"<(nav|main|header|footer|aside)\b([^>]*)>", html, flags=re.I):
                attrs = match.group(2)
                if not re.search(r"\b(aria-label|aria-labelledby|role)\s*=", attrs, flags=re.I):
                    missing += 1
        return _gt_result(module_id, "landmarks_missing_aria", missing, config, 0, {}, "ARIA_SEMANTIC_COVERAGE")
    if index == 3:
        value = sum(len(re.findall(r"href=[\"'][^\"'#?]+/(?=[\"'#?])", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "trailing_slash_internal_paths", value, config, 0, {}, "PATH_NORMALIZATION")
    if index == 4:
        value = 0
        for html in htmls:
            critical = re.search(r"<style\b[^>]*data-critical[^>]*>", html, flags=re.I)
            stylesheet = re.search(r"<link\b[^>]*rel=[\"']stylesheet[\"'][^>]*>", html, flags=re.I)
            if critical and stylesheet and critical.start() > stylesheet.start():
                value += 1
        return _gt_result(module_id, "critical_css_order_violations", value, config, 0, {}, "CRITICAL_CSS_BALANCE")
    if index == 5:
        value = 0
        for html in htmls:
            for tag in re.findall(r"<img\b[^>]*>", html, flags=re.I):
                if not re.search(r"\bdecoding=[\"'](?:async|sync|auto)[\"']", tag, flags=re.I):
                    value += 1
                if not re.search(r"\bloading=[\"'](?:lazy|eager)[\"']", tag, flags=re.I):
                    value += 1
        return _gt_result(module_id, "image_loading_attribute_gaps", value, config, 0, {}, "IMAGE_LOADING_ATTRIBUTES")
    if index == 6:
        value = sum(len(re.findall(r"href=[\"']\.\.?/", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "relative_internal_links", value, config, 0, {}, "RELATIVE_LINK_REWRITE")
    if index == 7:
        value = sum(len(re.findall(r"&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]+;)", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "invalid_entity_encodings", value, config, 0, {}, "HTML_ENTITY_ENCODING")
    if index == 8:
        value = 0
        for html in htmls:
            for table in re.findall(r"<table\b.*?</table\s*>", html, flags=re.I | re.S):
                if "<thead" not in table.lower() or not re.search(r"<th\b[^>]*\bscope=", table, flags=re.I):
                    value += 1
        return _gt_result(module_id, "tables_missing_semantic_structure", value, config, 0, {}, "TABLE_SEMANTIC_STRUCTURE")
    if index == 9:
        value = 0
        for html in htmls:
            origins = set(re.findall(r"https?://[^/\"'\s>]+", html, flags=re.I))
            preconnects = set(re.findall(r"<link\b[^>]*rel=[\"']preconnect[\"'][^>]*href=[\"'](https?://[^/\"']+)", html, flags=re.I))
            value += len(origins - preconnects)
        return _gt_result(module_id, "external_origins_without_preconnect", value, config, 0, {}, "RESOURCE_HINT_COVERAGE")
    if index == 10:
        counts = [len(_tags(html)) for html in htmls]
        value = max(counts) if counts else 0
        return _gt_result(module_id, "max_dom_node_count", value, config, 1500, {"node_counts": counts}, "DOM_SIZE")
    if index == 11:
        value = 0
        for html in htmls:
            for classes in re.findall(r"\bclass=[\"']([^\"']+)", html, flags=re.I):
                value += sum(1 for cls in classes.split() if re.fullmatch(r"[a-f0-9]{8,}", cls, flags=re.I))
        return _gt_result(module_id, "opaque_css_class_tokens", value, config, 0, {}, "CSS_CLASS_READABILITY")
    if index == 12:
        savings = 0
        for html in htmls:
            for script in re.findall(r"<script\b[^>]*>(.*?)</script\s*>", html, flags=re.I | re.S):
                compact = re.sub(r"\s+", " ", script).strip()
                savings += max(0, len(script.encode("utf-8")) - len(compact.encode("utf-8")))
        return _gt_result(module_id, "inline_js_minification_savings_bytes", savings, config, 256, {}, "INLINE_JS_MINIFICATION")
    if index == 13:
        value = 0
        for html in htmls:
            head_match = re.search(r"<head\b[^>]*>(.*?)</head\s*>", html, flags=re.I | re.S)
            if not head_match:
                value += 1
                continue
            head = head_match.group(1)
            charset = re.search(r"<meta\b[^>]*charset=", head, flags=re.I)
            title = re.search(r"<title\b", head, flags=re.I)
            if charset is None or title is None or charset.start() > title.start():
                value += 1
        return _gt_result(module_id, "head_tag_order_violations", value, config, 0, {}, "HEAD_TAG_ORDER")
    if index == 14:
        value = 0
        for html in htmls:
            used = set()
            for classes in re.findall(r"\bclass=[\"']([^\"']+)", html, flags=re.I):
                used.update(classes.split())
            for style in re.findall(r"<style\b[^>]*>(.*?)</style\s*>", html, flags=re.I | re.S):
                value += len([cls for cls in re.findall(r"\.([A-Za-z_][\w-]*)\s*[,{]", style) if cls not in used])
        return _gt_result(module_id, "unused_inline_css_selectors", value, config, 0, {}, "UNUSED_CSS")
    if index == 15:
        value = 0
        for uri, html in zip(uris, htmls):
            depth = len([part for part in urlparse(uri).path.split("/") if part])
            if depth >= 2 and "BreadcrumbList" not in html:
                value += 1
        return _gt_result(module_id, "nested_routes_missing_breadcrumbs", value, config, 0, {}, "BREADCRUMB_STRUCTURED_DATA")
    if index == 16:
        value = 0
        eligible = 0
        for row, html in zip(rows, htmls):
            author = _opt_str(row, "author")
            if author:
                eligible += 1
                if not re.search(r"<meta\b[^>]*name=[\"']author[\"']", html, flags=re.I):
                    value += 1
        if eligible == 0:
            raise _InsufficientData("author")
        return _gt_result(module_id, "documents_missing_author_metadata", value, config, 0, {"eligible_documents": eligible}, "AUTHOR_METADATA")
    if index == 17:
        value = sum(len(re.findall(r"href=[\"'](?:#|[^\"']*\s+[^\"']*|[^\"']*##[^\"']*)[\"']", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "malformed_anchor_links", value, config, 0, {}, "ANCHOR_NORMALIZATION")
    if index == 18:
        value = 0
        for html in htmls:
            fonts = set(re.findall(r"(?:src|href)=[\"']([^\"']+\.(?:woff2?|ttf|otf))(?:\?[^\"']*)?[\"']", html, flags=re.I))
            preloads = set(re.findall(r"<link\b[^>]*rel=[\"']preload[\"'][^>]*href=[\"']([^\"']+)[\"'][^>]*as=[\"']font[\"']", html, flags=re.I))
            value += sum(1 for font in fonts if font not in preloads)
        return _gt_result(module_id, "local_fonts_without_preload", value, config, 0, {}, "FONT_PRELOAD")
    if index == 19:
        ratios = [_ppm(len(_text_from_html(html).encode("utf-8")), max(1, len(html.encode("utf-8")))) for html in htmls]
        value = min(ratios) if ratios else 0
        return _lt_result(module_id, "minimum_text_to_html_ratio_ppm", value, config, 100_000, {"ratios_ppm": ratios}, "TEXT_HTML_RATIO", PPM)
    if index == 20:
        value = 0
        for html in htmls:
            for src in re.findall(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", html, flags=re.I):
                parsed = urlparse(src)
                path = parsed.path
                if " " in src or "//" in path or path.endswith("/./") or "/../" in path:
                    value += 1
        return _gt_result(module_id, "noncanonical_image_urls", value, config, 0, {}, "IMAGE_URL_CANONICALIZATION")
    if index == 21:
        value = 0
        for row in rows:
            headers = {str(k).casefold(): v for k, v in _opt_dict(row, "headers").items()}
            cache = headers.get("cache-control")
            if cache is None or not isinstance(cache, str) or "no-store" in cache.casefold():
                value += 1
        return _gt_result(module_id, "cache_control_policy_gaps", value, config, 0, {}, "CACHE_CONTROL")
    if index == 22:
        duplicates = 0
        for html in htmls:
            assets = re.findall(r"(?:src|href)=[\"']([^\"']+\.(?:css|js|png|jpg|jpeg|webp|svg|woff2?))(?:\?[^\"']*)?[\"']", html, flags=re.I)
            duplicates += len(assets) - len(set(assets))
        return _gt_result(module_id, "duplicate_static_asset_requests", duplicates, config, 0, {}, "STATIC_REQUEST_DEDUPLICATION")
    if index == 23:
        value = 0
        for html in htmls:
            for tag in re.findall(r"<a\b[^>]*target=[\"']_blank[\"'][^>]*>", html, flags=re.I):
                rel = re.search(r"\brel=[\"']([^\"']+)", tag, flags=re.I)
                tokens = set(rel.group(1).casefold().split()) if rel else set()
                if "noopener" not in tokens:
                    value += 1
        return _gt_result(module_id, "unsafe_blank_targets", value, config, 0, {}, "TARGET_ATTRIBUTE_SAFETY")
    if index == 24:
        value = sum(len(re.findall(r"<!--[^>]*(?:TODO|FIXME|DEBUG|HACK|XXX)[^>]*-->", html, flags=re.I)) for html in htmls)
        return _gt_result(module_id, "development_comments", value, config, 0, {}, "DEVELOPMENT_COMMENT_FILTER")
    if index == 25:
        value = 0
        eligible = 0
        for row, html in zip(rows, htmls):
            locale = _opt_str(row, "locale")
            if not locale:
                continue
            eligible += 1
            match = re.search(r"<html\b[^>]*\blang=[\"']([^\"']+)", html, flags=re.I)
            if match is None or match.group(1).casefold() != locale.casefold():
                value += 1
        if eligible == 0:
            raise _InsufficientData("locale")
        return _gt_result(module_id, "html_language_mismatches", value, config, 0, {"eligible_documents": eligible}, "HTML_LANGUAGE_DISTRIBUTION")
    raise _InvalidData("UNKNOWN_EDGE_STRUCTURAL_OPERATION")

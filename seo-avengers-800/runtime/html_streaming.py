from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, complement_ppm, need_int, need_str, need_str_list, ratio_ppm, subset_coverage_ppm


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool, *, direction: str = "higher_is_healthier") -> Dict[str, Any]:
    return {"metric_name": metric_name, "metric_ppm": metric_ppm, "threshold_ppm": threshold_ppm, "policy_direction": direction, "violation": bool(violation)}


def _coverage(row: Mapping[str, Any], total_key: str, good_key: str, metric_name: str, threshold_ppm: int) -> Dict[str, Any]:
    total = need_int(row, total_key, minimum=0)
    good = need_int(row, good_key, minimum=0)
    if total == 0:
        raise InsufficientData(f"{total_key}_zero")
    if good > total:
        raise InvalidData(f"{good_key}_exceeds_{total_key}")
    score = ratio_ppm(good, total)
    return _score(metric_name, score, threshold_ppm, score < threshold_ppm)


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    if operation == "http3_quic_stream_aligner":
        return _coverage(row, "quic_stream_chunks", "aligned_quic_chunks", "quic_alignment_ppm", threshold_ppm)
    if operation == "path_traversal_double_slash_purger":
        return _coverage(row, "href_buffers", "sanitized_href_buffers", "sanitized_href_ppm", threshold_ppm)
    if operation == "aria_interactive_element_guard":
        return _coverage(row, "interactive_elements", "aria_guarded_elements", "aria_guard_coverage_ppm", threshold_ppm)
    if operation == "critical_css_viewport_splitter":
        return _coverage(row, "viewport_css_rules", "correctly_scoped_rules", "viewport_css_scope_ppm", threshold_ppm)
    if operation == "lazy_load_noscript_fallback_agent":
        return _coverage(row, "lazy_images_nodes", "noscript_fallbacks", "noscript_fallback_coverage_ppm", threshold_ppm)
    if operation == "stream_chunk_boundary_validator":
        return _coverage(row, "chunk_boundaries", "valid_chunk_boundaries", "chunk_boundary_integrity_ppm", threshold_ppm)
    if operation == "partial_head_state_guard":
        return _coverage(row, "head_fragments", "ordered_head_fragments", "head_state_order_ppm", threshold_ppm)
    if operation == "utf8_boundary_integrity":
        return _coverage(row, "utf8_boundaries", "valid_utf8_boundaries", "utf8_boundary_integrity_ppm", threshold_ppm)
    if operation == "html_token_resume_guard":
        return _coverage(row, "resume_points", "valid_resume_points", "token_resume_integrity_ppm", threshold_ppm)
    if operation == "streaming_attribute_quote_guard":
        return _coverage(row, "streamed_attributes", "valid_quoted_attributes", "attribute_quote_integrity_ppm", threshold_ppm)
    if operation == "incremental_dom_depth_guard":
        depth = need_int(row, "max_observed_depth", minimum=0)
        allowed = need_int(row, "allowed_dom_depth", minimum=1)
        score = PPM if depth <= allowed else ratio_ppm(allowed, depth)
        return _score("dom_depth_health_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "orphan_closing_tag_detector":
        total = need_int(row, "closing_tags", minimum=0)
        orphan = need_int(row, "orphan_closing_tags", minimum=0)
        if total == 0:
            raise InsufficientData("closing_tags_zero")
        if orphan > total:
            raise InvalidData("orphan_closing_tags_exceed_closing_tags")
        score = complement_ppm(ratio_ppm(orphan, total))
        return _score("closing_tag_integrity_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "unclosed_element_recovery_audit":
        return _coverage(row, "opened_elements", "closed_elements", "element_closure_coverage_ppm", threshold_ppm)
    if operation == "progressive_script_order_guard":
        return _coverage(row, "dependency_edges", "respected_dependency_edges", "script_dependency_order_ppm", threshold_ppm)
    if operation == "stylesheet_blocking_budget":
        total = need_int(row, "stylesheets", minimum=0)
        blocking = need_int(row, "blocking_stylesheets", minimum=0)
        if total == 0:
            raise InsufficientData("stylesheets_zero")
        if blocking > total:
            raise InvalidData("blocking_stylesheets_exceed_stylesheets")
        score = complement_ppm(ratio_ppm(blocking, total))
        return _score("nonblocking_stylesheet_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "preload_consumption_match":
        return _coverage(row, "preload_assets", "consumed_preloads", "preload_consumption_ppm", threshold_ppm)
    if operation == "responsive_srcset_coverage":
        return _coverage(row, "responsive_images", "srcset_images", "srcset_coverage_ppm", threshold_ppm)
    if operation == "picture_source_media_guard":
        return _coverage(row, "picture_sources", "media_scoped_sources", "picture_media_scope_ppm", threshold_ppm)
    if operation == "html_entity_escape_integrity":
        return _coverage(row, "escapable_tokens", "escaped_tokens", "html_escape_integrity_ppm", threshold_ppm)
    if operation == "streaming_jsonld_integrity":
        return _coverage(row, "jsonld_blocks", "valid_jsonld_blocks", "jsonld_stream_integrity_ppm", threshold_ppm)
    if operation == "canonical_head_singleton_guard":
        count = need_int(row, "canonical_tag_count", minimum=0)
        if count == 1:
            score = PPM
        elif count == 0:
            score = 0
        else:
            excess = min(count - 1, 2)
            score = max(0, PPM - excess * 500_000)
        return _score("canonical_singleton_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "meta_charset_placement_guard":
        offset = need_int(row, "charset_offset_bytes", minimum=0)
        allowed = need_int(row, "max_charset_offset_bytes", minimum=1)
        score = PPM if offset <= allowed else ratio_ppm(allowed, offset)
        return _score("charset_placement_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "viewport_meta_singleton_guard":
        count = need_int(row, "viewport_tag_count", minimum=0)
        score = PPM if count == 1 else 0
        return _score("viewport_singleton_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "lang_dir_consistency_guard":
        expected = need_str(row, "expected_dir")
        actual = need_str(row, "actual_dir")
        if expected.casefold() not in {"ltr", "rtl"}:
            raise InvalidData("expected_dir_invalid")
        if actual.casefold() not in {"ltr", "rtl"}:
            raise InvalidData("actual_dir_invalid")
        score = PPM if expected.casefold() == actual.casefold() else 0
        return _score("lang_dir_consistency_ppm", score, threshold_ppm, score < threshold_ppm)
    if operation == "stream_completion_integrity":
        expected = need_str_list(row, "expected_terminal_tokens")
        observed = need_str_list(row, "observed_terminal_tokens")
        if not expected:
            raise InsufficientData("expected_terminal_tokens_empty")
        score = subset_coverage_ppm(expected, observed)
        return _score("stream_completion_ppm", score, threshold_ppm, score < threshold_ppm)
    raise InvalidData(f"unsupported_html_stream_operation:{operation}")

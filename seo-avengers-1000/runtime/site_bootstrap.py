from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, bounded_ratio_ppm, capped_ratio_ppm, complement_ppm, coverage_ppm, exact_text_match_ppm, need_int, need_sha256, need_str, need_str_list, positional_match_ppm, validate_required_fields
from .html_specs import HTML_SPECS

REQUIRED_FIELDS = {str(spec["operation"]): tuple(spec["input_fields"]) for spec in HTML_SPECS.values()}


def _result(score: int, threshold_ppm: int) -> Dict[str, Any]:
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= PPM:
        raise InvalidData("html_score_out_of_range")
    if isinstance(threshold_ppm, bool) or not isinstance(threshold_ppm, int) or not 0 <= threshold_ppm <= PPM:
        raise InvalidData("threshold_ppm_out_of_range")
    return {"score_ppm": score, "threshold_ppm": threshold_ppm, "violation": score < threshold_ppm}


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    fields = REQUIRED_FIELDS.get(operation)
    if fields is None:
        raise InvalidData(f"unsupported_html_operation:{operation}")
    validate_required_fields(row, fields)

    if operation == "stream_chunk_boundary_integrity":
        score = bounded_ratio_ppm(need_int(row, "valid_chunk_boundary_count", minimum=0), need_int(row, "chunk_boundary_count", minimum=1))
    elif operation == "utf8_boundary_integrity":
        score = bounded_ratio_ppm(need_int(row, "valid_utf8_boundary_count", minimum=0), need_int(row, "utf8_boundary_count", minimum=1))
    elif operation == "head_fragment_order_integrity":
        score = bounded_ratio_ppm(need_int(row, "respected_head_order_edge_count", minimum=0), need_int(row, "head_order_edge_count", minimum=1))
    elif operation == "canonical_singleton_integrity":
        score = PPM if need_int(row, "canonical_tag_count", minimum=0) == 1 else 0
    elif operation == "viewport_singleton_integrity":
        score = PPM if need_int(row, "viewport_tag_count", minimum=0) == 1 else 0
    elif operation == "charset_placement_integrity":
        offset = need_int(row, "charset_offset_bytes", minimum=0)
        limit = need_int(row, "max_charset_offset_bytes", minimum=1)
        score = PPM if offset <= limit else capped_ratio_ppm(limit, offset)
    elif operation == "tag_balance_integrity":
        opened = need_int(row, "opened_tag_count", minimum=0)
        closed = need_int(row, "closed_tag_count", minimum=0)
        if opened == 0 and closed == 0:
            raise InsufficientData("tag_balance_empty")
        score = capped_ratio_ppm(min(opened, closed), max(opened, closed))
    elif operation == "orphan_closing_tag_resistance":
        total = need_int(row, "closing_tag_count", minimum=1)
        orphan = need_int(row, "orphan_closing_tag_count", minimum=0)
        score = complement_ppm(bounded_ratio_ppm(orphan, total))
    elif operation == "attribute_quote_integrity":
        score = bounded_ratio_ppm(need_int(row, "quoted_attribute_count", minimum=0), need_int(row, "attribute_count", minimum=1))
    elif operation == "html_entity_escape_integrity":
        score = bounded_ratio_ppm(need_int(row, "escaped_token_count", minimum=0), need_int(row, "escapable_token_count", minimum=1))
    elif operation == "jsonld_parse_integrity":
        score = bounded_ratio_ppm(need_int(row, "valid_jsonld_block_count", minimum=0), need_int(row, "jsonld_block_count", minimum=1))
    elif operation == "jsonld_context_coverage":
        score = coverage_ppm(need_str_list(row, "required_jsonld_contexts"), need_str_list(row, "observed_jsonld_contexts"))
    elif operation == "preload_consumption_coverage":
        score = bounded_ratio_ppm(need_int(row, "consumed_preload_count", minimum=0), need_int(row, "preload_count", minimum=1))
    elif operation == "stylesheet_nonblocking_coverage":
        score = bounded_ratio_ppm(need_int(row, "nonblocking_stylesheet_count", minimum=0), need_int(row, "stylesheet_count", minimum=1))
    elif operation == "script_dependency_order_coverage":
        score = bounded_ratio_ppm(need_int(row, "respected_script_dependency_edge_count", minimum=0), need_int(row, "script_dependency_edge_count", minimum=1))
    elif operation == "responsive_srcset_coverage":
        score = bounded_ratio_ppm(need_int(row, "srcset_image_count", minimum=0), need_int(row, "responsive_image_count", minimum=1))
    elif operation == "picture_media_scope_coverage":
        score = bounded_ratio_ppm(need_int(row, "media_scoped_source_count", minimum=0), need_int(row, "picture_source_count", minimum=1))
    elif operation == "lazy_noscript_fallback_coverage":
        score = bounded_ratio_ppm(need_int(row, "noscript_fallback_count", minimum=0), need_int(row, "lazy_image_count", minimum=1))
    elif operation == "aria_name_coverage":
        score = bounded_ratio_ppm(need_int(row, "aria_named_element_count", minimum=0), need_int(row, "interactive_element_count", minimum=1))
    elif operation == "label_control_binding_coverage":
        score = bounded_ratio_ppm(need_int(row, "bound_label_count", minimum=0), need_int(row, "form_control_count", minimum=1))
    elif operation == "heading_outline_order_score":
        score = bounded_ratio_ppm(need_int(row, "valid_heading_transition_count", minimum=0), need_int(row, "heading_transition_count", minimum=1))
    elif operation == "landmark_main_singleton":
        score = PPM if need_int(row, "main_landmark_count", minimum=0) == 1 else 0
    elif operation == "duplicate_id_resistance":
        total = need_int(row, "id_attribute_count", minimum=1)
        duplicate = need_int(row, "duplicate_id_count", minimum=0)
        score = complement_ppm(bounded_ratio_ppm(duplicate, total))
    elif operation == "dom_depth_budget_score":
        observed = need_int(row, "observed_dom_depth", minimum=0)
        allowed = need_int(row, "allowed_dom_depth", minimum=1)
        score = PPM if observed <= allowed else capped_ratio_ppm(allowed, observed)
    elif operation == "visible_text_retention":
        score = bounded_ratio_ppm(need_int(row, "visible_text_bytes", minimum=0), need_int(row, "source_text_bytes", minimum=1))
    elif operation == "stream_completion_integrity":
        score = positional_match_ppm(need_str_list(row, "expected_terminal_tokens"), need_str_list(row, "observed_terminal_tokens"))
    elif operation == "content_length_match":
        expected = need_int(row, "expected_content_bytes", minimum=1)
        observed = need_int(row, "observed_content_bytes", minimum=0)
        score = 0 if observed == 0 else capped_ratio_ppm(min(expected, observed), max(expected, observed))
    elif operation == "checksum_integrity":
        score = PPM if need_sha256(row, "expected_document_digest") == need_sha256(row, "observed_document_digest") else 0
    elif operation == "canonical_href_consistency":
        score = exact_text_match_ppm(need_str(row, "declared_canonical_href"), need_str(row, "resolved_canonical_href"))
    elif operation == "hreflang_reciprocity":
        score = bounded_ratio_ppm(need_int(row, "reciprocal_hreflang_link_count", minimum=0), need_int(row, "hreflang_link_count", minimum=1))
    elif operation == "title_singleton_integrity":
        score = PPM if need_int(row, "title_tag_count", minimum=0) == 1 else 0
    elif operation == "description_singleton_integrity":
        score = PPM if need_int(row, "description_meta_count", minimum=0) == 1 else 0
    elif operation == "robots_meta_cardinality":
        score = PPM if need_int(row, "robots_meta_count", minimum=0) <= 1 else 0
    elif operation == "base_href_cardinality":
        score = PPM if need_int(row, "base_href_count", minimum=0) <= 1 else 0
    elif operation == "form_action_resolution_coverage":
        score = bounded_ratio_ppm(need_int(row, "resolved_form_action_count", minimum=0), need_int(row, "form_count", minimum=1))
    elif operation == "image_alt_coverage":
        score = bounded_ratio_ppm(need_int(row, "descriptive_alt_count", minimum=0), need_int(row, "informative_image_count", minimum=1))
    elif operation == "table_header_coverage":
        score = bounded_ratio_ppm(need_int(row, "headered_table_count", minimum=0), need_int(row, "data_table_count", minimum=1))
    elif operation == "list_structure_integrity":
        score = bounded_ratio_ppm(need_int(row, "contained_list_item_count", minimum=0), need_int(row, "list_item_count", minimum=1))
    elif operation == "details_summary_integrity":
        score = bounded_ratio_ppm(need_int(row, "summary_element_count", minimum=0), need_int(row, "details_element_count", minimum=1))
    elif operation == "template_fragment_balance":
        score = bounded_ratio_ppm(need_int(row, "closed_template_fragment_count", minimum=0), need_int(row, "template_fragment_count", minimum=1))
    elif operation == "svg_title_coverage":
        score = bounded_ratio_ppm(need_int(row, "titled_svg_count", minimum=0), need_int(row, "informative_svg_count", minimum=1))
    elif operation == "iframe_title_coverage":
        score = bounded_ratio_ppm(need_int(row, "titled_iframe_count", minimum=0), need_int(row, "iframe_count", minimum=1))
    elif operation == "lang_attribute_consistency":
        score = exact_text_match_ppm(need_str(row, "expected_lang"), need_str(row, "actual_lang"), casefold=True)
    elif operation == "dir_attribute_consistency":
        score = exact_text_match_ppm(need_str(row, "expected_dir"), need_str(row, "actual_dir"), casefold=True)
    elif operation == "resource_hint_origin_consistency":
        score = bounded_ratio_ppm(need_int(row, "valid_origin_hint_count", minimum=0), need_int(row, "resource_hint_count", minimum=1))
    elif operation == "modulepreload_consumption_coverage":
        score = bounded_ratio_ppm(need_int(row, "consumed_modulepreload_count", minimum=0), need_int(row, "modulepreload_count", minimum=1))
    elif operation == "noscript_content_parity":
        score = positional_match_ppm(need_str_list(row, "scripted_content_tokens"), need_str_list(row, "noscript_content_tokens"))
    elif operation == "streamed_comment_integrity":
        score = bounded_ratio_ppm(need_int(row, "closed_comment_count", minimum=0), need_int(row, "comment_count", minimum=1))
    elif operation == "custom_element_name_validity":
        score = bounded_ratio_ppm(need_int(row, "valid_custom_element_name_count", minimum=0), need_int(row, "custom_element_count", minimum=1))
    elif operation == "document_terminal_token_integrity":
        score = exact_text_match_ppm(need_str(row, "expected_terminal_token"), need_str(row, "observed_terminal_token"))
    else:
        raise InvalidData(f"unsupported_html_operation:{operation}")
    return _result(score, threshold_ppm)

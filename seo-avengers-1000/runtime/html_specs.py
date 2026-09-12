from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

HTML_ROWS: Sequence[Tuple[str, Sequence[str], int]] = (
    ('stream_chunk_boundary_integrity', ('chunk_boundary_count', 'valid_chunk_boundary_count'), 950000),
    ('utf8_boundary_integrity', ('utf8_boundary_count', 'valid_utf8_boundary_count'), 1000000),
    ('head_fragment_order_integrity', ('head_order_edge_count', 'respected_head_order_edge_count'), 980000),
    ('canonical_singleton_integrity', ('canonical_tag_count',), 1000000),
    ('viewport_singleton_integrity', ('viewport_tag_count',), 1000000),
    ('charset_placement_integrity', ('charset_offset_bytes', 'max_charset_offset_bytes'), 900000),
    ('tag_balance_integrity', ('opened_tag_count', 'closed_tag_count'), 1000000),
    ('orphan_closing_tag_resistance', ('closing_tag_count', 'orphan_closing_tag_count'), 990000),
    ('attribute_quote_integrity', ('attribute_count', 'quoted_attribute_count'), 990000),
    ('html_entity_escape_integrity', ('escapable_token_count', 'escaped_token_count'), 990000),
    ('jsonld_parse_integrity', ('jsonld_block_count', 'valid_jsonld_block_count'), 1000000),
    ('jsonld_context_coverage', ('required_jsonld_contexts', 'observed_jsonld_contexts'), 950000),
    ('preload_consumption_coverage', ('preload_count', 'consumed_preload_count'), 900000),
    ('stylesheet_nonblocking_coverage', ('stylesheet_count', 'nonblocking_stylesheet_count'), 850000),
    ('script_dependency_order_coverage', ('script_dependency_edge_count', 'respected_script_dependency_edge_count'), 950000),
    ('responsive_srcset_coverage', ('responsive_image_count', 'srcset_image_count'), 900000),
    ('picture_media_scope_coverage', ('picture_source_count', 'media_scoped_source_count'), 900000),
    ('lazy_noscript_fallback_coverage', ('lazy_image_count', 'noscript_fallback_count'), 850000),
    ('aria_name_coverage', ('interactive_element_count', 'aria_named_element_count'), 950000),
    ('label_control_binding_coverage', ('form_control_count', 'bound_label_count'), 950000),
    ('heading_outline_order_score', ('heading_transition_count', 'valid_heading_transition_count'), 900000),
    ('landmark_main_singleton', ('main_landmark_count',), 1000000),
    ('duplicate_id_resistance', ('id_attribute_count', 'duplicate_id_count'), 1000000),
    ('dom_depth_budget_score', ('observed_dom_depth', 'allowed_dom_depth'), 900000),
    ('visible_text_retention', ('source_text_bytes', 'visible_text_bytes'), 950000),
    ('stream_completion_integrity', ('expected_terminal_tokens', 'observed_terminal_tokens'), 1000000),
    ('content_length_match', ('expected_content_bytes', 'observed_content_bytes'), 990000),
    ('checksum_integrity', ('expected_document_digest', 'observed_document_digest'), 1000000),
    ('canonical_href_consistency', ('declared_canonical_href', 'resolved_canonical_href'), 1000000),
    ('hreflang_reciprocity', ('hreflang_link_count', 'reciprocal_hreflang_link_count'), 950000),
    ('title_singleton_integrity', ('title_tag_count',), 1000000),
    ('description_singleton_integrity', ('description_meta_count',), 1000000),
    ('robots_meta_cardinality', ('robots_meta_count',), 1000000),
    ('base_href_cardinality', ('base_href_count',), 1000000),
    ('form_action_resolution_coverage', ('form_count', 'resolved_form_action_count'), 950000),
    ('image_alt_coverage', ('informative_image_count', 'descriptive_alt_count'), 950000),
    ('table_header_coverage', ('data_table_count', 'headered_table_count'), 900000),
    ('list_structure_integrity', ('list_item_count', 'contained_list_item_count'), 990000),
    ('details_summary_integrity', ('details_element_count', 'summary_element_count'), 950000),
    ('template_fragment_balance', ('template_fragment_count', 'closed_template_fragment_count'), 1000000),
    ('svg_title_coverage', ('informative_svg_count', 'titled_svg_count'), 900000),
    ('iframe_title_coverage', ('iframe_count', 'titled_iframe_count'), 950000),
    ('lang_attribute_consistency', ('expected_lang', 'actual_lang'), 1000000),
    ('dir_attribute_consistency', ('expected_dir', 'actual_dir'), 1000000),
    ('resource_hint_origin_consistency', ('resource_hint_count', 'valid_origin_hint_count'), 950000),
    ('modulepreload_consumption_coverage', ('modulepreload_count', 'consumed_modulepreload_count'), 900000),
    ('noscript_content_parity', ('scripted_content_tokens', 'noscript_content_tokens'), 900000),
    ('streamed_comment_integrity', ('comment_count', 'closed_comment_count'), 1000000),
    ('custom_element_name_validity', ('custom_element_count', 'valid_custom_element_name_count'), 1000000),
    ('document_terminal_token_integrity', ('expected_terminal_token', 'observed_terminal_token'), 1000000),
)

HTML_SPECS: Dict[str, Dict[str, Any]] = {}
for offset, (operation, fields, threshold_ppm) in enumerate(HTML_ROWS):
    target_number = 851 + offset
    source_number = target_number + 1000
    module_id = f"M{target_number}"
    HTML_SPECS[module_id] = {
        "module_id": module_id,
        "source_module": f"M{source_number}",
        "family": "HTML_STREAM",
        "operation": operation,
        "dataset_key": "html_stream_records",
        "input_fields": tuple(fields),
        "threshold_ppm": threshold_ppm,
    }

TARGET_MODULES = tuple(f"M{i}" for i in range(851, 901))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1851, 1901))

if tuple(HTML_SPECS) != TARGET_MODULES:
    raise RuntimeError("html target range drift")
if {spec["source_module"] for spec in HTML_SPECS.values()} != set(SOURCE_MODULES):
    raise RuntimeError("html source range drift")
if len({spec["operation"] for spec in HTML_SPECS.values()}) != 50:
    raise RuntimeError("html operation collision")
for target, spec in HTML_SPECS.items():
    if target != spec["module_id"]:
        raise RuntimeError("html key/spec mismatch")
    if int(spec["source_module"][1:]) != int(target[1:]) + 1000:
        raise RuntimeError("html source mapping drift")
    threshold = spec["threshold_ppm"]
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("html threshold range")
    fields = spec["input_fields"]
    if not fields or len(fields) != len(set(fields)) or any(not isinstance(field, str) or not field for field in fields):
        raise RuntimeError("html input field contract invalid")

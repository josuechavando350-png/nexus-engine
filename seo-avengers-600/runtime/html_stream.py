from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, clamp_ppm, complement_ppm, need_int, need_str, need_str_list, ratio_ppm, subset_coverage_ppm


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool, *, direction: str = "higher_is_healthier") -> Dict[str, Any]:
    return {"metric_name": metric_name, "metric_ppm": clamp_ppm(metric_ppm), "threshold_ppm": threshold_ppm,
            "policy_direction": direction, "violation": bool(violation)}


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    if operation == "fetchpriority_above_fold":
        total=need_int(row,"above_fold_images",minimum=0); high=need_int(row,"high_priority_images",minimum=0)
        if total==0: raise InsufficientData("above_fold_images_zero")
        if high>total: raise InvalidData("high_priority_images_exceed_total")
        score=ratio_ppm(high,total); return _score("fetchpriority_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "trailing_slash_normalizer":
        hrefs=need_int(row,"href_attributes",minimum=0); bad=need_int(row,"double_slash_count",minimum=0)
        if hrefs==0: raise InsufficientData("href_attributes_zero")
        if bad>hrefs: raise InvalidData("double_slash_count_exceed_hrefs")
        score=complement_ppm(ratio_ppm(bad,hrefs)); return _score("normalized_href_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "aria_role_injector":
        total=need_int(row,"nav_count",minimum=0); good=need_int(row,"nav_with_role_count",minimum=0)
        if total==0: raise InsufficientData("nav_count_zero")
        if good>total: raise InvalidData("nav_with_role_count_exceed_total")
        score=ratio_ppm(good,total); return _score("aria_role_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "css_inline_critical_balancer":
        critical=need_int(row,"critical_css_bytes",minimum=0); total=need_int(row,"total_css_bytes",minimum=0)
        if total==0: raise InsufficientData("total_css_bytes_zero")
        if critical>total: raise InvalidData("critical_css_bytes_exceed_total")
        score=ratio_ppm(critical,total); return _score("critical_css_ratio_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "lazy_loading_viewport_defer":
        total=need_int(row,"below_fold_images",minimum=0); lazy=need_int(row,"lazy_images",minimum=0)
        if total==0: raise InsufficientData("below_fold_images_zero")
        if lazy>total: raise InvalidData("lazy_images_exceed_total")
        score=ratio_ppm(lazy,total); return _score("lazy_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "script_async_defer_rewriter":
        total=need_int(row,"script_count",minimum=0); deferred=need_int(row,"deferred_script_count",minimum=0)
        if total==0: raise InsufficientData("script_count_zero")
        if deferred>total: raise InvalidData("deferred_script_count_exceed_total")
        score=ratio_ppm(deferred,total); return _score("deferred_script_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "html_comment_stripper":
        comments=need_int(row,"dev_comment_count",minimum=0); size=need_int(row,"html_bytes",minimum=0)
        if size==0: raise InsufficientData("html_bytes_zero")
        score=PPM if comments==0 else complement_ppm(min(PPM,comments*100_000)); return _score("comment_hygiene_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "svg_inline_compressor":
        before=need_int(row,"svg_bytes_before",minimum=0); after=need_int(row,"svg_bytes_after",minimum=0)
        if before==0: raise InsufficientData("svg_bytes_before_zero")
        if after>before: raise InvalidData("svg_bytes_after_exceed_before")
        score=ratio_ppm(before-after,before); return _score("svg_savings_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "dns_prefetch_injector":
        required=need_str_list(row,"third_party_domains"); observed=need_str_list(row,"prefetched_domains")
        if not required: raise InsufficientData("third_party_domains_empty")
        score=subset_coverage_ppm(required,observed); return _score("dns_prefetch_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "dom_nesting_flatten_agent":
        depth=need_int(row,"max_dom_depth",minimum=0); allowed=need_int(row,"allowed_dom_depth",minimum=1)
        score=PPM if depth<=allowed else ratio_ppm(allowed,depth); return _score("dom_depth_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "css_utility_class_compactor":
        before=need_int(row,"class_bytes_before",minimum=0); after=need_int(row,"class_bytes_after",minimum=0)
        if before==0: raise InsufficientData("class_bytes_before_zero")
        if after>before: raise InvalidData("class_bytes_after_exceed_before")
        score=ratio_ppm(before-after,before); return _score("class_compaction_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "head_tag_reordering_validator":
        total=need_int(row,"head_priority_items",minimum=0); correct=need_int(row,"head_priority_correct",minimum=0)
        if total==0: raise InsufficientData("head_priority_items_zero")
        if correct>total: raise InvalidData("head_priority_correct_exceed_total")
        score=ratio_ppm(correct,total); return _score("head_order_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "w3c_duplicate_id_cleaner":
        total=need_int(row,"dom_id_count",minimum=0); unique=need_int(row,"unique_dom_id_count",minimum=0)
        if total==0: raise InsufficientData("dom_id_count_zero")
        if unique>total: raise InvalidData("unique_dom_id_count_exceed_total")
        score=ratio_ppm(unique,total); return _score("unique_dom_id_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "schema_microdata_to_jsonld":
        source=need_int(row,"microdata_items",minimum=0); converted=need_int(row,"jsonld_items",minimum=0)
        if source==0: raise InsufficientData("microdata_items_zero")
        score=ratio_ppm(min(converted,source),source); return _score("jsonld_conversion_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "html_lang_attribute_guard":
        expected=need_str(row,"expected_locale"); actual=need_str(row,"actual_locale"); score=PPM if expected.casefold()==actual.casefold() else 0
        return _score("locale_match_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "font_preload_subset_injector":
        required=need_str_list(row,"critical_fonts"); observed=need_str_list(row,"preloaded_fonts")
        if not required: raise InsufficientData("critical_fonts_empty")
        score=subset_coverage_ppm(required,observed); return _score("font_preload_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "image_semantic_alt_generator":
        required=need_int(row,"images_requiring_alt",minimum=0); verified=need_int(row,"images_with_verified_alt",minimum=0)
        if required==0: raise InsufficientData("images_requiring_alt_zero")
        if verified>required: raise InvalidData("images_with_verified_alt_exceed_total")
        score=ratio_ppm(verified,required); return _score("verified_alt_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "link_farming_menu_limiter":
        actual=need_int(row,"menu_link_count",minimum=0); allowed=need_int(row,"allowed_menu_links",minimum=1)
        score=PPM if actual<=allowed else ratio_ppm(allowed,actual); return _score("menu_link_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "cache_control_header_matching":
        expected=need_str_list(row,"expected_cache_directives"); actual=need_str_list(row,"actual_cache_directives")
        if not expected: raise InsufficientData("expected_cache_directives_empty")
        score=subset_coverage_ppm(expected,actual); return _score("cache_directive_match_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "noopener_target_blank_forcer":
        total=need_int(row,"target_blank_links",minimum=0); safe=need_int(row,"safe_rel_links",minimum=0)
        if total==0: raise InsufficientData("target_blank_links_zero")
        if safe>total: raise InvalidData("safe_rel_links_exceed_total")
        score=ratio_ppm(safe,total); return _score("noopener_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "server_signature_remover":
        total=need_int(row,"server_signature_count",minimum=0); exposed=need_int(row,"exposed_signature_count",minimum=0)
        if total==0 and exposed==0: return _score("signature_hygiene_ppm",PPM,threshold_ppm,False)
        if exposed>total: raise InvalidData("exposed_signature_count_exceed_total")
        score=complement_ppm(ratio_ppm(exposed,max(1,total))); return _score("signature_hygiene_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "rtl_direction_bidi_handler":
        total=need_int(row,"rtl_blocks",minimum=0); fixed=need_int(row,"rtl_blocks_with_dir",minimum=0)
        if total==0: raise InsufficientData("rtl_blocks_zero")
        if fixed>total: raise InvalidData("rtl_blocks_with_dir_exceed_total")
        score=ratio_ppm(fixed,total); return _score("rtl_direction_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "code_block_semantic_wrapper":
        total=need_int(row,"code_blocks",minimum=0); typed=need_int(row,"typed_code_blocks",minimum=0)
        if total==0: raise InsufficientData("code_blocks_zero")
        if typed>total: raise InvalidData("typed_code_blocks_exceed_total")
        score=ratio_ppm(typed,total); return _score("typed_code_block_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "inline_js_minifier_on_fly":
        before=need_int(row,"inline_js_bytes_before",minimum=0); after=need_int(row,"inline_js_bytes_after",minimum=0)
        if before==0: raise InsufficientData("inline_js_bytes_before_zero")
        if after>before: raise InvalidData("inline_js_bytes_after_exceed_before")
        score=ratio_ppm(before-after,before); return _score("inline_js_savings_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "responsive_picture_elementizer":
        total=need_int(row,"legacy_images",minimum=0); converted=need_int(row,"picture_images",minimum=0)
        if total==0: raise InsufficientData("legacy_images_zero")
        score=ratio_ppm(min(converted,total),total); return _score("picture_conversion_ppm",score,threshold_ppm,score<threshold_ppm)
    raise InvalidData(f"unsupported_html_operation:{operation}")

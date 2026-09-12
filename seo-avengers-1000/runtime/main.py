from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, bounded_ratio_ppm, capped_ratio_ppm, coverage_ppm, exact_text_match_ppm, jaccard_ppm, need_bool, need_int, need_sha256, need_str, need_str_list, positional_match_ppm, validate_required_fields
from .edge_specs import EDGE_SPECS

REQUIRED_FIELDS = {str(spec["operation"]): tuple(spec["input_fields"]) for spec in EDGE_SPECS.values()}


def _result(score: int, threshold_ppm: int) -> Dict[str, Any]:
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= PPM:
        raise InvalidData("edge_score_out_of_range")
    if isinstance(threshold_ppm, bool) or not isinstance(threshold_ppm, int) or not 0 <= threshold_ppm <= PPM:
        raise InvalidData("threshold_ppm_out_of_range")
    return {"score_ppm": score, "threshold_ppm": threshold_ppm, "violation": score < threshold_ppm}


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    fields = REQUIRED_FIELDS.get(operation)
    if fields is None:
        raise InvalidData(f"unsupported_edge_operation:{operation}")
    validate_required_fields(row, fields)
    if operation == "status_code_parity":
        score = PPM if need_int(row, "primary_status", minimum=100, maximum=599) == need_int(row, "secondary_status", minimum=100, maximum=599) else 0
    elif operation == "redirect_chain_parity":
        score = positional_match_ppm(need_str_list(row, "primary_redirect_chain"), need_str_list(row, "secondary_redirect_chain"))
    elif operation == "content_digest_parity":
        score = PPM if need_sha256(row, "primary_content_digest") == need_sha256(row, "secondary_content_digest") else 0
    elif operation == "header_set_parity":
        score = jaccard_ppm(need_str_list(row, "primary_header_names"), need_str_list(row, "secondary_header_names"))
    elif operation == "cache_control_parity":
        score = exact_text_match_ppm(need_str(row, "primary_cache_control"), need_str(row, "secondary_cache_control"), casefold=True)
    elif operation == "content_type_parity":
        score = exact_text_match_ppm(need_str(row, "primary_content_type"), need_str(row, "secondary_content_type"), casefold=True)
    elif operation == "content_encoding_parity":
        score = exact_text_match_ppm(need_str(row, "primary_content_encoding"), need_str(row, "secondary_content_encoding"), casefold=True)
    elif operation == "tls_version_parity":
        score = exact_text_match_ppm(need_str(row, "primary_tls_version"), need_str(row, "secondary_tls_version"), casefold=True)
    elif operation == "protocol_negotiation_parity":
        score = exact_text_match_ppm(need_str(row, "primary_protocol"), need_str(row, "secondary_protocol"), casefold=True)
    elif operation == "body_length_similarity":
        left = need_int(row, "primary_body_bytes", minimum=0)
        right = need_int(row, "secondary_body_bytes", minimum=0)
        score = PPM if left == right == 0 else (0 if max(left, right) == 0 else capped_ratio_ppm(min(left, right), max(left, right)))
    elif operation == "latency_budget_compliance":
        observed = need_int(row, "observed_latency_ms", minimum=0)
        budget = need_int(row, "latency_budget_ms", minimum=1)
        score = PPM if observed <= budget else capped_ratio_ppm(budget, observed)
    elif operation == "ttfb_similarity":
        left = need_int(row, "primary_ttfb_ms", minimum=0)
        right = need_int(row, "secondary_ttfb_ms", minimum=0)
        score = PPM if left == right == 0 else capped_ratio_ppm(min(left, right), max(left, right))
    elif operation == "edge_cache_hit_parity":
        score = PPM if need_bool(row, "primary_cache_hit") == need_bool(row, "secondary_cache_hit") else 0
    elif operation == "vary_header_parity":
        score = exact_text_match_ppm(need_str(row, "primary_vary", allow_empty=True), need_str(row, "secondary_vary", allow_empty=True), casefold=True)
    elif operation == "etag_parity":
        score = exact_text_match_ppm(need_str(row, "primary_etag"), need_str(row, "secondary_etag"))
    elif operation == "last_modified_parity":
        score = exact_text_match_ppm(need_str(row, "primary_last_modified"), need_str(row, "secondary_last_modified"))
    elif operation == "canonical_header_parity":
        score = exact_text_match_ppm(need_str(row, "primary_canonical_header"), need_str(row, "secondary_canonical_header"))
    elif operation == "robots_header_parity":
        score = exact_text_match_ppm(need_str(row, "primary_robots_header", allow_empty=True), need_str(row, "secondary_robots_header", allow_empty=True), casefold=True)
    elif operation == "csp_header_parity":
        score = exact_text_match_ppm(need_str(row, "primary_csp"), need_str(row, "secondary_csp"))
    elif operation == "hsts_header_parity":
        score = exact_text_match_ppm(need_str(row, "primary_hsts"), need_str(row, "secondary_hsts"), casefold=True)
    elif operation == "x_content_type_options_parity":
        score = exact_text_match_ppm(need_str(row, "primary_xcto"), need_str(row, "secondary_xcto"), casefold=True)
    elif operation == "referrer_policy_parity":
        score = exact_text_match_ppm(need_str(row, "primary_referrer_policy"), need_str(row, "secondary_referrer_policy"), casefold=True)
    elif operation == "permissions_policy_parity":
        score = exact_text_match_ppm(need_str(row, "primary_permissions_policy", allow_empty=True), need_str(row, "secondary_permissions_policy", allow_empty=True))
    elif operation == "cross_origin_opener_policy_parity":
        score = exact_text_match_ppm(need_str(row, "primary_coop", allow_empty=True), need_str(row, "secondary_coop", allow_empty=True), casefold=True)
    elif operation == "cross_origin_resource_policy_parity":
        score = exact_text_match_ppm(need_str(row, "primary_corp", allow_empty=True), need_str(row, "secondary_corp", allow_empty=True), casefold=True)
    elif operation == "redirect_location_parity":
        score = exact_text_match_ppm(need_str(row, "primary_location", allow_empty=True), need_str(row, "secondary_location", allow_empty=True))
    elif operation == "cookie_name_set_parity":
        score = jaccard_ppm(need_str_list(row, "primary_cookie_names"), need_str_list(row, "secondary_cookie_names"))
    elif operation == "cookie_secure_coverage":
        score = bounded_ratio_ppm(need_int(row, "secure_cookie_count", minimum=0), need_int(row, "cookie_count", minimum=1))
    elif operation == "cookie_samesite_coverage":
        score = bounded_ratio_ppm(need_int(row, "samesite_cookie_count", minimum=0), need_int(row, "cookie_count", minimum=1))
    elif operation == "response_trailer_parity":
        score = jaccard_ppm(need_str_list(row, "primary_trailer_names"), need_str_list(row, "secondary_trailer_names"))
    elif operation == "compression_ratio_similarity":
        left = need_int(row, "primary_compressed_bytes", minimum=0)
        right = need_int(row, "secondary_compressed_bytes", minimum=0)
        score = PPM if left == right == 0 else capped_ratio_ppm(min(left, right), max(left, right))
    elif operation == "transfer_chunk_count_similarity":
        left = need_int(row, "primary_chunk_count", minimum=0)
        right = need_int(row, "secondary_chunk_count", minimum=0)
        score = PPM if left == right == 0 else capped_ratio_ppm(min(left, right), max(left, right))
    elif operation == "origin_status_parity":
        score = PPM if need_int(row, "origin_primary_status", minimum=100, maximum=599) == need_int(row, "origin_secondary_status", minimum=100, maximum=599) else 0
    elif operation == "edge_status_parity":
        score = PPM if need_int(row, "edge_primary_status", minimum=100, maximum=599) == need_int(row, "edge_secondary_status", minimum=100, maximum=599) else 0
    elif operation == "backend_route_parity":
        score = exact_text_match_ppm(need_str(row, "primary_backend_route"), need_str(row, "secondary_backend_route"))
    elif operation == "geographic_replica_digest_parity":
        score = PPM if need_sha256(row, "region_a_digest") == need_sha256(row, "region_b_digest") else 0
    elif operation == "ipv4_ipv6_digest_parity":
        score = PPM if need_sha256(row, "ipv4_digest") == need_sha256(row, "ipv6_digest") else 0
    elif operation == "http2_http3_digest_parity":
        score = PPM if need_sha256(row, "http2_digest") == need_sha256(row, "http3_digest") else 0
    elif operation == "warm_cold_digest_parity":
        score = PPM if need_sha256(row, "warm_digest") == need_sha256(row, "cold_digest") else 0
    elif operation == "crawler_identity_evidence_coincidence":
        score = bounded_ratio_ppm(need_int(row, "coincident_signal_count", minimum=0), need_int(row, "identity_signal_count", minimum=1))
    elif operation == "crawler_header_set_parity":
        score = jaccard_ppm(need_str_list(row, "human_header_names"), need_str_list(row, "crawler_header_names"))
    elif operation == "crawler_status_parity":
        score = PPM if need_int(row, "human_status", minimum=100, maximum=599) == need_int(row, "crawler_status", minimum=100, maximum=599) else 0
    elif operation == "crawler_redirect_parity":
        score = positional_match_ppm(need_str_list(row, "human_redirect_chain"), need_str_list(row, "crawler_redirect_chain"))
    elif operation == "crawler_encoding_parity":
        score = exact_text_match_ppm(need_str(row, "human_encoding"), need_str(row, "crawler_encoding"), casefold=True)
    elif operation == "crawler_content_type_parity":
        score = exact_text_match_ppm(need_str(row, "human_content_type"), need_str(row, "crawler_content_type"), casefold=True)
    elif operation == "crawler_cache_control_parity":
        score = exact_text_match_ppm(need_str(row, "human_cache_control"), need_str(row, "crawler_cache_control"), casefold=True)
    elif operation == "crawler_csp_parity":
        score = exact_text_match_ppm(need_str(row, "human_csp"), need_str(row, "crawler_csp"))
    elif operation == "crawler_body_length_similarity":
        left = need_int(row, "human_body_bytes", minimum=0)
        right = need_int(row, "crawler_body_bytes", minimum=0)
        score = PPM if left == right == 0 else capped_ratio_ppm(min(left, right), max(left, right))
    elif operation == "crawler_latency_budget_parity":
        left = need_int(row, "human_latency_ms", minimum=0)
        right = need_int(row, "crawler_latency_ms", minimum=0)
        score = PPM if left == right == 0 else capped_ratio_ppm(min(left, right), max(left, right))
    elif operation == "perimeter_evidence_completeness":
        score = coverage_ppm(need_str_list(row, "required_evidence_keys"), need_str_list(row, "observed_evidence_keys"))
    else:
        raise InvalidData(f"unsupported_edge_operation:{operation}")
    return _result(score, threshold_ppm)

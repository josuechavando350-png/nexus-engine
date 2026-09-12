from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

EDGE_ROWS: Sequence[Tuple[str, Sequence[str], int]] = (
    ('status_code_parity', ('primary_status', 'secondary_status'), 1000000),
    ('redirect_chain_parity', ('primary_redirect_chain', 'secondary_redirect_chain'), 1000000),
    ('content_digest_parity', ('primary_content_digest', 'secondary_content_digest'), 1000000),
    ('header_set_parity', ('primary_header_names', 'secondary_header_names'), 950000),
    ('cache_control_parity', ('primary_cache_control', 'secondary_cache_control'), 1000000),
    ('content_type_parity', ('primary_content_type', 'secondary_content_type'), 1000000),
    ('content_encoding_parity', ('primary_content_encoding', 'secondary_content_encoding'), 1000000),
    ('tls_version_parity', ('primary_tls_version', 'secondary_tls_version'), 1000000),
    ('protocol_negotiation_parity', ('primary_protocol', 'secondary_protocol'), 1000000),
    ('body_length_similarity', ('primary_body_bytes', 'secondary_body_bytes'), 990000),
    ('latency_budget_compliance', ('observed_latency_ms', 'latency_budget_ms'), 900000),
    ('ttfb_similarity', ('primary_ttfb_ms', 'secondary_ttfb_ms'), 900000),
    ('edge_cache_hit_parity', ('primary_cache_hit', 'secondary_cache_hit'), 1000000),
    ('vary_header_parity', ('primary_vary', 'secondary_vary'), 1000000),
    ('etag_parity', ('primary_etag', 'secondary_etag'), 1000000),
    ('last_modified_parity', ('primary_last_modified', 'secondary_last_modified'), 1000000),
    ('canonical_header_parity', ('primary_canonical_header', 'secondary_canonical_header'), 1000000),
    ('robots_header_parity', ('primary_robots_header', 'secondary_robots_header'), 1000000),
    ('csp_header_parity', ('primary_csp', 'secondary_csp'), 1000000),
    ('hsts_header_parity', ('primary_hsts', 'secondary_hsts'), 1000000),
    ('x_content_type_options_parity', ('primary_xcto', 'secondary_xcto'), 1000000),
    ('referrer_policy_parity', ('primary_referrer_policy', 'secondary_referrer_policy'), 1000000),
    ('permissions_policy_parity', ('primary_permissions_policy', 'secondary_permissions_policy'), 1000000),
    ('cross_origin_opener_policy_parity', ('primary_coop', 'secondary_coop'), 1000000),
    ('cross_origin_resource_policy_parity', ('primary_corp', 'secondary_corp'), 1000000),
    ('redirect_location_parity', ('primary_location', 'secondary_location'), 1000000),
    ('cookie_name_set_parity', ('primary_cookie_names', 'secondary_cookie_names'), 950000),
    ('cookie_secure_coverage', ('cookie_count', 'secure_cookie_count'), 1000000),
    ('cookie_samesite_coverage', ('cookie_count', 'samesite_cookie_count'), 950000),
    ('response_trailer_parity', ('primary_trailer_names', 'secondary_trailer_names'), 950000),
    ('compression_ratio_similarity', ('primary_compressed_bytes', 'secondary_compressed_bytes'), 950000),
    ('transfer_chunk_count_similarity', ('primary_chunk_count', 'secondary_chunk_count'), 900000),
    ('origin_status_parity', ('origin_primary_status', 'origin_secondary_status'), 1000000),
    ('edge_status_parity', ('edge_primary_status', 'edge_secondary_status'), 1000000),
    ('backend_route_parity', ('primary_backend_route', 'secondary_backend_route'), 1000000),
    ('geographic_replica_digest_parity', ('region_a_digest', 'region_b_digest'), 1000000),
    ('ipv4_ipv6_digest_parity', ('ipv4_digest', 'ipv6_digest'), 1000000),
    ('http2_http3_digest_parity', ('http2_digest', 'http3_digest'), 1000000),
    ('warm_cold_digest_parity', ('warm_digest', 'cold_digest'), 1000000),
    ('crawler_identity_evidence_coincidence', ('identity_signal_count', 'coincident_signal_count'), 800000),
    ('crawler_header_set_parity', ('human_header_names', 'crawler_header_names'), 950000),
    ('crawler_status_parity', ('human_status', 'crawler_status'), 1000000),
    ('crawler_redirect_parity', ('human_redirect_chain', 'crawler_redirect_chain'), 1000000),
    ('crawler_encoding_parity', ('human_encoding', 'crawler_encoding'), 1000000),
    ('crawler_content_type_parity', ('human_content_type', 'crawler_content_type'), 1000000),
    ('crawler_cache_control_parity', ('human_cache_control', 'crawler_cache_control'), 1000000),
    ('crawler_csp_parity', ('human_csp', 'crawler_csp'), 1000000),
    ('crawler_body_length_similarity', ('human_body_bytes', 'crawler_body_bytes'), 990000),
    ('crawler_latency_budget_parity', ('human_latency_ms', 'crawler_latency_ms'), 900000),
    ('perimeter_evidence_completeness', ('required_evidence_keys', 'observed_evidence_keys'), 950000),
)

EDGE_SPECS: Dict[str, Dict[str, Any]] = {}
for offset, (operation, fields, threshold_ppm) in enumerate(EDGE_ROWS):
    target_number = 901 + offset
    source_number = target_number + 1000
    module_id = f"M{target_number}"
    EDGE_SPECS[module_id] = {
        "module_id": module_id,
        "source_module": f"M{source_number}",
        "family": "EDGE_PERIMETER",
        "operation": operation,
        "dataset_key": "edge_perimeter_records",
        "input_fields": tuple(fields),
        "threshold_ppm": threshold_ppm,
    }

TARGET_MODULES = tuple(f"M{i}" for i in range(901, 951))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1901, 1951))

if tuple(EDGE_SPECS) != TARGET_MODULES:
    raise RuntimeError("edge target range drift")
if {spec["source_module"] for spec in EDGE_SPECS.values()} != set(SOURCE_MODULES):
    raise RuntimeError("edge source range drift")
if len({spec["operation"] for spec in EDGE_SPECS.values()}) != 50:
    raise RuntimeError("edge operation collision")
for target, spec in EDGE_SPECS.items():
    if target != spec["module_id"]:
        raise RuntimeError("edge key/spec mismatch")
    if int(spec["source_module"][1:]) != int(target[1:]) + 1000:
        raise RuntimeError("edge source mapping drift")
    threshold = spec["threshold_ppm"]
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("edge threshold range")
    fields = spec["input_fields"]
    if not fields or len(fields) != len(set(fields)) or any(not isinstance(field, str) or not field for field in fields):
        raise RuntimeError("edge input field contract invalid")

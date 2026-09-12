from __future__ import annotations

from typing import Any, Dict

DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

EDGE_ROWS: Dict[str, Dict[str, Any]] = {
    "M901": {"module_id": "M901", "primary_status": 200, "secondary_status": 200},
    "M902": {"module_id": "M902", "primary_redirect_chain": ["/a", "/b"], "secondary_redirect_chain": ["/a", "/b"]},
    "M903": {"module_id": "M903", "primary_content_digest": DIGEST, "secondary_content_digest": DIGEST},
    "M904": {"module_id": "M904", "primary_header_names": ["content-type", "cache-control"], "secondary_header_names": ["content-type", "cache-control"]},
    "M905": {"module_id": "M905", "primary_cache_control": "max-age=60", "secondary_cache_control": "max-age=60"},
    "M906": {"module_id": "M906", "primary_content_type": "text/html", "secondary_content_type": "text/html"},
    "M907": {"module_id": "M907", "primary_content_encoding": "gzip", "secondary_content_encoding": "gzip"},
    "M908": {"module_id": "M908", "primary_tls_version": "TLS1.3", "secondary_tls_version": "TLS1.3"},
    "M909": {"module_id": "M909", "primary_protocol": "h2", "secondary_protocol": "h2"},
    "M910": {"module_id": "M910", "primary_body_bytes": 1000, "secondary_body_bytes": 1000},
    "M911": {"module_id": "M911", "observed_latency_ms": 100, "latency_budget_ms": 200},
    "M912": {"module_id": "M912", "primary_ttfb_ms": 100, "secondary_ttfb_ms": 100},
    "M913": {"module_id": "M913", "primary_cache_hit": True, "secondary_cache_hit": True},
    "M914": {"module_id": "M914", "primary_vary": "Accept-Encoding", "secondary_vary": "Accept-Encoding"},
    "M915": {"module_id": "M915", "primary_etag": "etag-a", "secondary_etag": "etag-a"},
    "M916": {"module_id": "M916", "primary_last_modified": "1700000000", "secondary_last_modified": "1700000000"},
    "M917": {"module_id": "M917", "primary_canonical_header": "/canonical", "secondary_canonical_header": "/canonical"},
    "M918": {"module_id": "M918", "primary_robots_header": "index,follow", "secondary_robots_header": "index,follow"},
    "M919": {"module_id": "M919", "primary_csp": "default-src 'self'", "secondary_csp": "default-src 'self'"},
    "M920": {"module_id": "M920", "primary_hsts": "max-age=31536000", "secondary_hsts": "max-age=31536000"},
    "M921": {"module_id": "M921", "primary_xcto": "nosniff", "secondary_xcto": "nosniff"},
    "M922": {"module_id": "M922", "primary_referrer_policy": "strict-origin", "secondary_referrer_policy": "strict-origin"},
    "M923": {"module_id": "M923", "primary_permissions_policy": "geolocation=()", "secondary_permissions_policy": "geolocation=()"},
    "M924": {"module_id": "M924", "primary_coop": "same-origin", "secondary_coop": "same-origin"},
    "M925": {"module_id": "M925", "primary_corp": "same-site", "secondary_corp": "same-site"},
    "M926": {"module_id": "M926", "primary_location": "/next", "secondary_location": "/next"},
    "M927": {"module_id": "M927", "primary_cookie_names": ["session", "prefs"], "secondary_cookie_names": ["session", "prefs"]},
    "M928": {"module_id": "M928", "cookie_count": 2, "secure_cookie_count": 2},
    "M929": {"module_id": "M929", "cookie_count": 2, "samesite_cookie_count": 2},
    "M930": {"module_id": "M930", "primary_trailer_names": ["digest"], "secondary_trailer_names": ["digest"]},
    "M931": {"module_id": "M931", "primary_compressed_bytes": 500, "secondary_compressed_bytes": 500},
    "M932": {"module_id": "M932", "primary_chunk_count": 10, "secondary_chunk_count": 10},
    "M933": {"module_id": "M933", "origin_primary_status": 200, "origin_secondary_status": 200},
    "M934": {"module_id": "M934", "edge_primary_status": 200, "edge_secondary_status": 200},
    "M935": {"module_id": "M935", "primary_backend_route": "origin-a", "secondary_backend_route": "origin-a"},
    "M936": {"module_id": "M936", "region_a_digest": DIGEST, "region_b_digest": DIGEST},
    "M937": {"module_id": "M937", "ipv4_digest": DIGEST, "ipv6_digest": DIGEST},
    "M938": {"module_id": "M938", "http2_digest": DIGEST, "http3_digest": DIGEST},
    "M939": {"module_id": "M939", "warm_digest": DIGEST, "cold_digest": DIGEST},
    "M940": {"module_id": "M940", "identity_signal_count": 3, "coincident_signal_count": 3},
    "M941": {"module_id": "M941", "human_header_names": ["content-type"], "crawler_header_names": ["content-type"]},
    "M942": {"module_id": "M942", "human_status": 200, "crawler_status": 200},
    "M943": {"module_id": "M943", "human_redirect_chain": ["/a"], "crawler_redirect_chain": ["/a"]},
    "M944": {"module_id": "M944", "human_encoding": "gzip", "crawler_encoding": "gzip"},
    "M945": {"module_id": "M945", "human_content_type": "text/html", "crawler_content_type": "text/html"},
    "M946": {"module_id": "M946", "human_cache_control": "max-age=60", "crawler_cache_control": "max-age=60"},
    "M947": {"module_id": "M947", "human_csp": "default-src 'self'", "crawler_csp": "default-src 'self'"},
    "M948": {"module_id": "M948", "human_body_bytes": 1000, "crawler_body_bytes": 1000},
    "M949": {"module_id": "M949", "human_latency_ms": 100, "crawler_latency_ms": 100},
    "M950": {"module_id": "M950", "required_evidence_keys": ["status", "headers"], "observed_evidence_keys": ["status", "headers"]},
}


def edge_payload() -> Dict[str, Any]:
    return {"edge_perimeter_records": [dict(EDGE_ROWS[module_id]) for module_id in EDGE_ROWS]}

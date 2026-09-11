from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, clamp_ppm, complement_ppm, need_bool, need_int, need_str, ratio_ppm


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool) -> Dict[str, Any]:
    return {"metric_name": metric_name, "metric_ppm": clamp_ppm(metric_ppm), "threshold_ppm": threshold_ppm,
            "policy_direction": "higher_is_healthier", "violation": bool(violation)}


def evaluate(operation: str, row: Mapping[str, Any], threshold_ppm: int) -> Dict[str, Any]:
    if operation == "asn_googlebot_validator":
        claimed=need_bool(row,"claimed_googlebot"); asn=need_int(row,"request_asn",minimum=0); dns=need_bool(row,"dns_verified")
        if asn==0: raise InsufficientData("request_asn_zero")
        score=PPM if (not claimed or (asn==15169 and dns)) else 0; return _score("googlebot_identity_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "user_agent_spoof_detector":
        present=need_bool(row,"user_agent_present"); reputation=need_int(row,"ip_reputation_ppm",minimum=0); signatures=need_int(row,"spoof_signature_count",minimum=0)
        if not present: raise InsufficientData("user_agent_missing")
        if reputation>PPM: raise InvalidData("ip_reputation_ppm_above_one_million")
        score=max(0,reputation-min(PPM,signatures*250_000)); return _score("spoof_safety_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "loop_redirect_breaker":
        chain=need_int(row,"redirect_chain_count",minimum=0); repeats=need_int(row,"repeated_target_count",minimum=0)
        if chain<2: raise InsufficientData("redirect_chain_too_short_to_evaluate")
        score=complement_ppm(min(PPM,repeats*250_000+max(0,chain-5)*100_000)); return _score("redirect_loop_safety_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "cloudflare_kv_session_verifier":
        token=need_bool(row,"session_token_present"); match=need_bool(row,"kv_session_match")
        if not token: raise InsufficientData("session_token_missing")
        score=PPM if match else 0; return _score("kv_session_integrity_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "retry_after_header_generator":
        load=need_int(row,"server_load_ppm",minimum=0); status=need_int(row,"http_status",minimum=100); retry=need_bool(row,"retry_after_present")
        if load>PPM: raise InvalidData("server_load_ppm_above_one_million")
        if load<800_000: raise InsufficientData("server_not_under_pressure")
        score=PPM if status==503 and retry else 0; return _score("retry_after_compliance_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "xss_injection_perimeter_filter":
        q=need_int(row,"query_signal_count",minimum=0); b=need_int(row,"body_signal_count",minimum=0); blocked=need_int(row,"blocked_signal_count",minimum=0); total=q+b
        if total==0: raise InsufficientData("no_security_signals")
        if blocked>total: raise InvalidData("blocked_signal_count_exceed_total")
        score=ratio_ppm(blocked,total); return _score("xss_block_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "edge_latency_fail_open_timer":
        elapsed=need_int(row,"execution_time_micros",minimum=0); budget=need_int(row,"budget_micros",minimum=1)
        score=PPM if elapsed<=budget else ratio_ppm(budget,elapsed); return _score("latency_budget_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "http_malformed_status_corrector":
        origin=need_int(row,"origin_status_code",minimum=100); expected=need_int(row,"expected_status_code",minimum=100); score=PPM if origin==expected else 0
        return _score("status_semantics_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "tls_version_security_enforcer":
        actual=need_int(row,"tls_version_code",minimum=0); minimum=need_int(row,"minimum_tls_version_code",minimum=0)
        if actual==0: raise InsufficientData("tls_version_unknown")
        score=PPM if actual>=minimum else ratio_ppm(actual,max(1,minimum)); return _score("tls_security_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "suite_cryptographic_signer":
        payload_hash=need_bool(row,"payload_hash_present"); valid=need_bool(row,"signature_valid")
        if not payload_hash: raise InsufficientData("payload_hash_missing")
        score=PPM if valid else 0; return _score("signature_integrity_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "search_results_noindex_applier":
        internal=need_bool(row,"is_internal_search"); noindex=need_bool(row,"noindex_present")
        if not internal: raise InsufficientData("not_internal_search")
        score=PPM if noindex else 0; return _score("search_noindex_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "gzip_brotli_parity_aligner":
        need_str(row,"identity_hash"); matched=need_bool(row,"compressed_roundtrip_hash_match"); score=PPM if matched else 0
        return _score("compression_parity_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "microdata_syntax_preflight":
        errors=need_int(row,"microdata_error_count",minimum=0); items=need_int(row,"microdata_item_count",minimum=0)
        if items==0: raise InsufficientData("microdata_item_count_zero")
        if errors>items: raise InvalidData("microdata_error_count_exceed_items")
        score=complement_ppm(ratio_ppm(errors,items)); return _score("microdata_syntax_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "dynamic_robots_txt_override":
        emergency=need_bool(row,"emergency_mode"); restrictive=need_bool(row,"robots_restrictive")
        if not emergency: raise InsufficientData("emergency_mode_inactive")
        score=PPM if restrictive else 0; return _score("emergency_robots_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "high_velocity_scraper_limiter":
        count=need_int(row,"request_count",minimum=0); window=need_int(row,"window_seconds",minimum=1); limit=need_int(row,"limit_count",minimum=1)
        if count<limit: raise InsufficientData("request_rate_below_limit")
        score=complement_ppm(min(PPM,ratio_ppm(count-limit,max(1,limit)))); return _score("rate_limit_control_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "media_streaming_chunk_optimizer":
        range_request=need_bool(row,"range_request"); alignment=need_int(row,"chunk_alignment_ppm",minimum=0)
        if not range_request: raise InsufficientData("not_range_request")
        if alignment>PPM: raise InvalidData("chunk_alignment_ppm_above_one_million")
        return _score("chunk_alignment_ppm",alignment,threshold_ppm,alignment<threshold_ppm)
    if operation == "cloudflare_kv_isolation_check":
        tenant=need_bool(row,"tenant_present"); cross=need_int(row,"cross_tenant_key_count",minimum=0)
        if not tenant: raise InsufficientData("tenant_missing")
        score=PPM if cross==0 else complement_ppm(min(PPM,cross*250_000)); return _score("tenant_isolation_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "hidden_control_byte_purger":
        total=need_int(row,"control_byte_count",minimum=0); purged=need_int(row,"purged_byte_count",minimum=0)
        if total==0: raise InsufficientData("control_byte_count_zero")
        if purged>total: raise InvalidData("purged_byte_count_exceed_total")
        score=ratio_ppm(purged,total); return _score("control_byte_purge_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "duplicate_h2_url_rewriter":
        total=need_int(row,"h2_count",minimum=0); dup=need_int(row,"duplicate_h2_count",minimum=0)
        if total<2: raise InsufficientData("h2_count_below_two")
        if dup>total: raise InvalidData("duplicate_h2_count_exceed_total")
        score=complement_ppm(ratio_ppm(dup,total)); return _score("heading_uniqueness_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "worker_subrequest_quota_monitor":
        count=need_int(row,"subrequest_count",minimum=0); limit=need_int(row,"quota_limit",minimum=1)
        score=PPM if count<limit else ratio_ppm(limit,max(1,count)); return _score("subrequest_quota_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "metric_execution_header_injector":
        metrics=need_int(row,"timing_metric_count",minimum=0); headers=need_int(row,"timing_header_count",minimum=0)
        if metrics==0: raise InsufficientData("timing_metric_count_zero")
        if headers>metrics: raise InvalidData("timing_header_count_exceed_metrics")
        score=ratio_ppm(headers,metrics); return _score("timing_header_coverage_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "geo_ip_redirect_validator":
        present=need_bool(row,"country_present"); match=need_bool(row,"hreflang_match")
        if not present: raise InsufficientData("client_country_missing")
        score=PPM if match else 0; return _score("geo_route_match_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "mobile_desktop_parity_assert":
        mobile=need_str(row,"mobile_dom_hash"); desktop=need_str(row,"desktop_dom_hash"); score=PPM if mobile==desktop else 0
        return _score("dom_parity_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "url_parameter_spam_scrub":
        total=need_int(row,"query_key_count",minimum=0); spam=need_int(row,"spam_key_count",minimum=0)
        if total==0: raise InsufficientData("query_key_count_zero")
        if spam>total: raise InvalidData("spam_key_count_exceed_total")
        score=complement_ppm(ratio_ppm(spam,total)); return _score("query_hygiene_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "perimeter_session_close_orchestrator":
        before=need_int(row,"open_sockets_before",minimum=0); after=need_int(row,"open_sockets_after",minimum=0)
        if before==0: raise InsufficientData("no_open_sockets")
        if after>before: raise InvalidData("open_sockets_after_exceed_before")
        score=ratio_ppm(before-after,before); return _score("socket_cleanup_ppm",score,threshold_ppm,score<threshold_ppm)
    raise InvalidData(f"unsupported_edge_operation:{operation}")

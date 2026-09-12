from __future__ import annotations
from typing import Any
from .specs_common import add

PROOF_OPERATIONS = (
    ("canonical_singleton_integrity","canonical tag singleton proof"),
    ("canonical_href_consistency","canonical href consistency proof"),
    ("robots_meta_cardinality","robots meta cardinality proof"),
    ("title_singleton_integrity","title singleton proof"),
    ("description_singleton_integrity","description singleton proof"),
    ("hreflang_reciprocity","hreflang reciprocity proof"),
    ("visible_text_retention","visible text retention proof"),
    ("stream_completion_integrity","stream completion proof"),
    ("content_length_match","content length integrity proof"),
    ("checksum_integrity","document checksum proof"),
    ("jsonld_parse_integrity","JSON-LD parse proof"),
    ("jsonld_context_coverage","JSON-LD context coverage proof"),
    ("lang_attribute_consistency","language attribute consistency proof"),
    ("heading_outline_order_score","heading outline order proof"),
    ("image_alt_coverage","informative image alt coverage proof"),
    ("status_code_parity","response status parity proof"),
    ("redirect_chain_parity","redirect chain parity proof"),
    ("content_digest_parity","content digest parity proof"),
    ("header_set_parity","header set parity proof"),
    ("cache_control_parity","cache-control parity proof"),
    ("content_type_parity","content-type parity proof"),
    ("content_encoding_parity","content-encoding parity proof"),
    ("body_length_similarity","body-length similarity proof"),
    ("canonical_header_parity","canonical header parity proof"),
    ("robots_header_parity","robots header parity proof"),
    ("origin_status_parity","origin status parity proof"),
    ("edge_status_parity","edge status parity proof"),
    ("geographic_replica_digest_parity","geographic replica content parity proof"),
    ("ipv4_ipv6_digest_parity","IPv4/IPv6 content parity proof"),
    ("http2_http3_digest_parity","HTTP/2 and HTTP/3 content parity proof"),
    ("warm_cold_digest_parity","warm/cold cache content parity proof"),
    ("crawler_header_set_parity","human/crawler header parity proof"),
    ("crawler_status_parity","human/crawler status parity proof"),
    ("crawler_redirect_parity","human/crawler redirect parity proof"),
    ("crawler_encoding_parity","human/crawler encoding parity proof"),
    ("crawler_content_type_parity","human/crawler content-type parity proof"),
    ("crawler_cache_control_parity","human/crawler cache-control parity proof"),
    ("crawler_csp_parity","human/crawler CSP parity proof"),
    ("crawler_body_length_similarity","human/crawler body-length similarity proof"),
    ("perimeter_evidence_completeness","perimeter evidence completeness proof"),
)

PROOF_BUNDLES = (
    ("canonical_readiness_bundle",("canonical_singleton_integrity","canonical_href_consistency","canonical_header_parity"),"Fuse canonical-tag, resolved-href and response-header proofs into one canonical-readiness evidence state."),
    ("robots_readiness_bundle",("robots_meta_cardinality","robots_header_parity"),"Fuse robots metadata/header proofs without inferring indexing when evidence is absent."),
    ("metadata_readiness_bundle",("title_singleton_integrity","description_singleton_integrity","lang_attribute_consistency"),"Fuse title, description and language-document proofs."),
    ("structured_data_readiness_bundle",("jsonld_parse_integrity","jsonld_context_coverage"),"Fuse parse and context evidence for structured-data readiness."),
    ("content_integrity_bundle",("visible_text_retention","content_length_match","checksum_integrity"),"Fuse visible-text and byte-level document-integrity proofs."),
    ("stream_readiness_bundle",("stream_completion_integrity","content_length_match","content_encoding_parity"),"Fuse stream-completion, content-length and encoding evidence."),
    ("redirect_readiness_bundle",("redirect_chain_parity","crawler_redirect_parity"),"Fuse general and crawler/human redirect-parity evidence."),
    ("status_readiness_bundle",("status_code_parity","origin_status_parity","edge_status_parity","crawler_status_parity"),"Fuse origin, edge and human/crawler status consistency proofs."),
    ("crawler_content_parity_bundle",("crawler_status_parity","crawler_redirect_parity","crawler_content_type_parity","crawler_body_length_similarity"),"Fuse the core human/crawler content-delivery parity evidence used to detect unsafe asymmetric behavior."),
    ("crawler_header_parity_bundle",("crawler_header_set_parity","crawler_cache_control_parity","crawler_csp_parity","crawler_encoding_parity"),"Fuse human/crawler response-header parity evidence."),
    ("protocol_content_parity_bundle",("ipv4_ipv6_digest_parity","http2_http3_digest_parity","warm_cold_digest_parity"),"Fuse content consistency across network protocol and cache state."),
    ("geographic_content_parity_bundle",("geographic_replica_digest_parity","content_digest_parity"),"Fuse geographic and primary/secondary content-digest parity evidence."),
    ("search_appearance_foundation_bundle",("title_singleton_integrity","description_singleton_integrity","canonical_href_consistency","robots_meta_cardinality"),"Fuse core document signals relevant to search appearance and crawl interpretation."),
    ("international_readiness_bundle",("hreflang_reciprocity","lang_attribute_consistency","canonical_href_consistency"),"Fuse language, hreflang and canonical evidence for international consistency."),
    ("perimeter_integrity_bundle",("perimeter_evidence_completeness","header_set_parity","content_type_parity","body_length_similarity"),"Fuse perimeter completeness and response-shape parity evidence."),
)

def build(rows: list[dict[str, Any]]) -> None:
    for operation,label in PROOF_OPERATIONS:
        add(rows,"INDEXATION_READINESS",f"proof_{operation}","upstream_evidence","proof_operation_health",
            {"required_operation":operation},f"Verify the integrity and non-failing state of supplied upstream {label}; absence remains unknown, never 'indexed'.",(),1_000_000)

    for operation,required,purpose in PROOF_BUNDLES:
        add(rows,"INDEXATION_READINESS",operation,"upstream_evidence","proof_bundle_health",
            {"required_operations":list(required)},purpose,(),1_000_000)

    scopes = (
        ("all","none","all observed search demand"),
        ("commercial","local_commercial_terms","commercial-intent demand"),
        ("service","local_service_terms","service-intent demand"),
        ("location","local_location_terms","location-qualified demand"),
        ("urgency","local_urgency_terms","urgent-intent demand"),
    )
    observation_modes = (
        ("landing_document_presence","landing_presence","Measure whether URLs observed in search performance are represented by supplied content documents for {label}."),
        ("impression_weighted_document_presence","impression_presence","Measure impression-weighted content-document coverage for {label}."),
        ("zero_click_document_gap","zero_click_gap","Find zero-click observations whose landing URL has no supplied content document for {label}; this is a content-observation gap, not an index claim."),
        ("high_impression_document_gap","high_impression_gap","Find high-impression observations whose landing URL has no supplied content document for {label}; this never labels the URL unindexed."),
    )
    for scope,cfg,label in scopes:
        for suffix,mode,purpose in observation_modes:
            terms=() if cfg=="none" else (cfg,)
            add(rows,"INDEXATION_READINESS",f"{scope}_{suffix}","MULTI","search_content_observation_readiness",
                {"scope_config":cfg,"mode":mode,"high_impression_floor":100},purpose.format(label=label),terms,800_000)

    proof_sets = (
        ("canonical",("canonical_singleton_integrity","canonical_href_consistency","canonical_header_parity")),
        ("crawl_parity",("crawler_status_parity","crawler_redirect_parity","crawler_content_type_parity","crawler_body_length_similarity")),
        ("metadata",("title_singleton_integrity","description_singleton_integrity","lang_attribute_consistency")),
        ("render_integrity",("visible_text_retention","stream_completion_integrity","checksum_integrity")),
        ("transport",("status_code_parity","content_type_parity","content_encoding_parity","perimeter_evidence_completeness")),
    )
    weighted_scopes = (
        ("all","none","all observed demand"),
        ("commercial","local_commercial_terms","commercial-intent demand"),
        ("local","local_location_terms","location-qualified demand"),
    )
    for proof_name,ops in proof_sets:
        for scope,cfg,label in weighted_scopes:
            terms=() if cfg=="none" else (cfg,)
            add(rows,"INDEXATION_READINESS",f"{scope}_{proof_name}_demand_weighted_risk","MULTI","demand_weighted_proof_risk",
                {"scope_config":cfg,"required_operations":list(ops)},
                f"Weight {proof_name} proof failures by explicitly observed impressions for {label}; this prioritizes remediation and does not predict indexing or ranking.",terms,900_000)

    guards = (
        ("upstream_receipt_hash_integrity_guard","receipt_hash_integrity","Reject supplied upstream receipts whose evidence hash cannot be recomputed exactly."),
        ("upstream_duplicate_module_conflict_guard","duplicate_module_conflict","Reject conflicting upstream receipts that claim the same module identity."),
        ("upstream_duplicate_operation_conflict_guard","duplicate_operation_conflict","Reject conflicting duplicate observations for one upstream operation."),
        ("upstream_execution_error_propagation_guard","execution_error_propagation","Propagate upstream execution errors into readiness rather than silently treating them as passes."),
        ("upstream_finding_propagation_guard","finding_propagation","Propagate upstream findings into readiness rather than hiding them behind aggregate scores."),
        ("whitehat_predecessor_m1200_guard","m1200_safe","Require an explicit safe M1200 white-hat receipt before this batch can be terminally certified."),
        ("search_unobserved_not_unindexed_semantics_guard","no_index_claim","Enforce that missing search observations are represented only as unknown/unobserved, never as proof of non-indexation."),
        ("upstream_proof_minimum_coverage_guard","minimum_proof_coverage","Require a minimum set of concrete upstream technical proofs before declaring readiness."),
        ("upstream_status_domain_integrity_guard","status_domain","Reject upstream receipt status values outside the declared execution/finding domains."),
    )
    for operation,mode,purpose in guards:
        add(rows,"INDEXATION_READINESS",operation,"MULTI","indexation_readiness_guard",{"mode":mode},purpose,(),1_000_000)

    add(rows,"INDEXATION_READINESS","indexation_readiness_batch_certifier","MULTI","indexation_readiness_release_gate",
        {"required_guard_modules":[f"M{i}" for i in range(1391,1400)]},
        "Certify the exact M1391-M1399 readiness-guard receipts plus the predecessor M1200 white-hat gate; fail closed on missing, corrupt, error or finding evidence.",(),1_000_000)

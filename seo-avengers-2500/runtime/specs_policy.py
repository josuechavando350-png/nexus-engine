from __future__ import annotations
from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    policy=(
        ("doorway_pair_similarity_guard","content_documents","content_doorway_similarity_guard",{"shingle_size":5,"similarity_ppm":900_000},"Detect near-duplicate local landing pages whose visible value differs too little to justify separate search-targeted pages.",()),
        ("location_swap_clone_guard","content_documents","content_location_swap_guard",{"shingle_size":4,"similarity_ppm":850_000},"Detect pairs nearly identical after location terms are removed, a doorway-page risk signal.",( "local_location_terms",)),
        ("service_swap_clone_guard","content_documents","content_service_swap_guard",{"shingle_size":4,"similarity_ppm":850_000},"Detect pairs nearly identical after service terms are removed, preventing thin service-page templating.",( "local_service_terms",)),
        ("keyword_repetition_guard","content_documents","content_repetition_guard",{"max_term_share_ppm":80_000},"Detect excessive repetition of configured SEO terms instead of rewarding keyword stuffing.",( "local_service_terms","local_location_terms")),
        ("location_repetition_guard","content_documents","content_repetition_guard",{"max_term_share_ppm":60_000,"terms_config":"local_location_terms"},"Detect excessive repetition of locality terms.",( "local_location_terms",)),
        ("service_repetition_guard","content_documents","content_repetition_guard",{"max_term_share_ppm":60_000,"terms_config":"local_service_terms"},"Detect excessive repetition of service terms.",( "local_service_terms",)),
        ("thin_local_page_guard","content_documents","content_thin_value_guard",{"min_tokens":180},"Flag local documents with too little substantive visible text.",()),
        ("unique_value_floor_guard","content_documents","content_unique_value_guard",{"min_unique_share_ppm":250_000},"Require lexical uniqueness so scaled local pages are not certified because one token changed.",()),
        ("cross_page_unique_shingle_guard","content_documents","content_unique_shingle_guard",{"shingle_size":5,"min_unique_share_ppm":200_000},"Require each local-facing document to contribute shingles not copied from other documents.",()),
        ("local_fact_support_guard","MULTI","content_local_fact_support_guard",{},"Require local claims to be corroborated by supplied local business evidence.",()),
        ("nap_claim_conflict_guard","MULTI","content_nap_conflict_guard",{},"Detect visible NAP claims that conflict with modal supplied local identity.",()),
        ("unsupported_service_claim_guard","content_documents","content_allowed_term_guard",{"observed_config":"local_service_terms","allowed_config":"local_verified_service_terms"},"Block recommendations implying services outside the verified service set.",( "local_service_terms","local_verified_service_terms")),
        ("unsupported_location_claim_guard","content_documents","content_allowed_term_guard",{"observed_config":"local_location_terms","allowed_config":"local_verified_location_terms"},"Block recommendations implying service in locations outside the verified set.",( "local_location_terms","local_verified_location_terms")),
        ("query_only_page_risk_guard","MULTI","query_only_page_risk_guard",{},"Detect local pages whose only differentiating evidence is a search query pattern rather than user-value content.",()),
        ("commercial_intent_without_value_guard","MULTI","commercial_intent_value_guard",{"min_tokens":220},"Detect commercial-demand pages lacking enough substantive content for aggressive optimization.",( "local_commercial_terms",)),
        ("local_intent_without_identity_guard","MULTI","local_intent_identity_guard",{},"Detect location-demand pages with no corroborated business identity evidence.",( "local_location_terms",)),
        ("near_me_without_location_evidence_guard","MULTI","near_me_location_evidence_guard",{},"Detect near-me demand attached to pages without verified local evidence; never fabricate proximity.",()),
        ("refresh_evidence_sufficiency_guard","content_decay_records","refresh_evidence_sufficiency_guard",{"min_decline_ppm":100_000},"Require measurable historical decay evidence before a freshness-oriented refresh recommendation.",()),
        ("predecessor_policy_regression_guard","upstream_evidence","predecessor_policy_regression_guard",{},"Fail closed when supplied predecessor policy/compliance receipts report a prohibited-pattern finding.",()),
        ("scaled_page_cardinality_guard","content_documents","content_scaled_cardinality_guard",{"similarity_ppm":850_000,"max_similar_cluster":5},"Detect large clusters of highly similar local pages.",()),
        ("local_page_information_gain_guard","content_documents","content_information_gain_guard",{"min_novel_token_count":20},"Require measurable information gain relative to the nearest content neighbor.",()),
        ("brand_impersonation_guard","MULTI","brand_identity_conflict_guard",{},"Detect pages whose stated business identity conflicts with verified local identity.",()),
        ("phone_identity_conflict_guard","MULTI","phone_identity_conflict_guard",{},"Detect phone claims that differ from verified local-source quorum.",()),
        ("address_identity_conflict_guard","MULTI","address_identity_conflict_guard",{},"Detect address claims that differ from verified local-source quorum.",()),
        ("whitehat_release_gate","MULTI","whitehat_release_gate",{},"Aggregate M1176-M1199 policy receipts and refuse a safe state when any guard fires.",()),
    )
    for operation,dataset,kernel,params,purpose,terms in policy:
        add(rows,"WHITEHAT_POLICY",operation,dataset,kernel,params,purpose,terms,1_000_000)

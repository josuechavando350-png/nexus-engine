from __future__ import annotations
from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    coverage=(("service","local_service_terms","verified service"),
              ("location","local_location_terms","verified location"),
              ("commercial","local_commercial_terms","commercial intent"),
              ("question","local_question_terms","question intent"),
              ("urgency","local_urgency_terms","urgent user need"))
    for key,cfg,label in coverage:
        add(rows,"LOCAL_CONTENT",f"{key}_term_document_coverage","content_documents","content_term_document_coverage",
            {"terms_config":cfg},f"Measure documents containing at least one configured {label} term.",(cfg,),700_000)
        add(rows,"LOCAL_CONTENT",f"{key}_term_corpus_density","content_documents","content_term_corpus_density",
            {"terms_config":cfg},f"Measure corpus-level token density for {label} terms while flagging absence or excess.",(cfg,),700_000)
        add(rows,"LOCAL_CONTENT",f"{key}_term_page_distribution_gini","content_documents","content_term_distribution_gini",
            {"terms_config":cfg},f"Measure how unevenly {label} evidence is distributed using integer Gini concentration.",(cfg,),650_000)

    pairs=(("service_location","local_service_terms","local_location_terms","service and location"),
           ("brand_service","local_brand_terms","local_service_terms","brand and service"),
           ("brand_location","local_brand_terms","local_location_terms","brand and location"),
           ("service_commercial","local_service_terms","local_commercial_terms","service and commercial intent"),
           ("location_commercial","local_location_terms","local_commercial_terms","location and commercial intent"))
    for key,left,right,label in pairs:
        add(rows,"LOCAL_CONTENT",f"{key}_cooccurrence_coverage","content_documents","content_pair_cooccurrence",
            {"left_config":left,"right_config":right},f"Measure document coverage where {label} terms co-occur naturally.",(left,right),750_000)
        add(rows,"LOCAL_CONTENT",f"{key}_proximity_strength","content_documents","content_pair_proximity",
            {"left_config":left,"right_config":right,"window_tokens":40},
            f"Measure token-window proximity between {label} evidence instead of rewarding raw frequency.",(left,right),700_000)

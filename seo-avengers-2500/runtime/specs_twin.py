from __future__ import annotations
from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    intents = (
        ("service","local_service_terms","service-intent"),
        ("location","local_location_terms","location-qualified"),
        ("commercial","local_commercial_terms","commercial-intent"),
        ("urgency","local_urgency_terms","urgent-intent"),
        ("question","local_question_terms","question-intent"),
        ("brand","local_brand_terms","brand-intent"),
    )
    alignment_modes = (
        ("observed_page_content_presence","page_content_presence","Measure whether pages observed for {label} demand exist in the supplied content corpus."),
        ("query_terms_visible_coverage","query_term_support","Measure whether observed {label} query vocabulary is visibly supported by its landing documents."),
        ("page_specialization_score","page_specialization","Measure whether {label} demand is concentrated on documents whose visible vocabulary matches that intent rather than generic pages."),
        ("zero_click_content_support","zero_click_support","Prioritize zero-click {label} observations whose landing content lacks matching visible evidence."),
        ("first_page_content_support","first_page_support","Audit content support for {label} observations already receiving first-page visibility."),
    )
    for intent,cfg,label in intents:
        for suffix,mode,purpose in alignment_modes:
            add(rows,"LOCAL_OPPORTUNITY_TWIN",f"{intent}_{suffix}","MULTI","twin_query_content_alignment",
                {"intent_config":cfg,"mode":mode},purpose.format(label=label),(cfg,),750_000)

    bands = (
        ("short_1_2",1,2,"one-to-two-token"),
        ("mid_3",3,3,"three-token"),
        ("long_4",4,4,"four-token"),
        ("long_5",5,5,"five-token"),
        ("deep_6plus",6,64,"six-or-more-token"),
    )
    geometry = (
        ("impression_share","impression_share","Measure observed impression share for {label} queries."),
        ("click_share","click_share","Measure observed click share for {label} queries."),
        ("zero_click_share","zero_click_share","Measure the share of {label} impressions attached to zero-click observations."),
        ("landing_dispersion","landing_dispersion","Measure how widely {label} query demand is dispersed across landing pages."),
    )
    for band,min_tokens,max_tokens,label in bands:
        for suffix,mode,purpose in geometry:
            add(rows,"LOCAL_OPPORTUNITY_TWIN",f"{band}_{suffix}","search_performance_records","twin_longtail_geometry",
                {"min_tokens":min_tokens,"max_tokens":max_tokens,"mode":mode},purpose.format(label=label),(),650_000)

    scopes = (
        ("all","none","all observed local demand"),
        ("commercial","local_commercial_terms","commercial local demand"),
        ("urgent","local_urgency_terms","urgent local demand"),
        ("brand","local_brand_terms","brand local demand"),
    )
    portfolio_modes = (
        ("observed_cell_coverage","cell_coverage","Measure observed service×location cell coverage for {label}."),
        ("click_active_cell_share","click_active","Measure service×location cells with at least one observed click for {label}."),
        ("zero_click_cell_share","zero_click","Locate service×location cells with impressions but no clicks for {label}."),
        ("landing_dispersion","landing_dispersion","Detect service×location cells spread across multiple landing pages for {label}."),
        ("page_content_support","page_content_support","Measure whether service×location cells point to content documents that visibly support both dimensions for {label}."),
    )
    for scope,cfg,label in scopes:
        for suffix,mode,purpose in portfolio_modes:
            terms=() if cfg=="none" else (cfg,)
            add(rows,"LOCAL_OPPORTUNITY_TWIN",f"{scope}_service_location_{suffix}","MULTI","twin_service_location_portfolio",
                {"scope_config":cfg,"mode":mode},purpose.format(label=label),terms+("local_service_groups","local_location_groups"),700_000)

    value_intents = (
        ("service","local_service_terms","service-intent"),
        ("location","local_location_terms","location-qualified"),
        ("commercial","local_commercial_terms","commercial-intent"),
        ("urgency","local_urgency_terms","urgent-intent"),
        ("brand","local_brand_terms","brand-intent"),
    )
    value_modes = (
        ("impression_value_exposure","impression_value","Compute a bounded funnel-weighted priority index over observed impressions for {label} demand; this is not a revenue forecast."),
        ("click_value_exposure","click_value","Compute a bounded funnel-weighted priority index over observed clicks for {label} demand; this is not a revenue forecast."),
        ("zero_click_value_exposure","zero_click_value","Weight zero-click {label} demand by explicitly supplied organic funnel economics to prioritize review without predicting sales."),
        ("rank_gap_value_exposure","rank_gap_value","Weight {label} demand outside the first page by explicitly supplied organic funnel economics to prioritize work without predicting rank lift."),
    )
    for intent,cfg,label in value_intents:
        for suffix,mode,purpose in value_modes:
            add(rows,"LOCAL_OPPORTUNITY_TWIN",f"{intent}_{suffix}","MULTI","twin_economic_priority",
                {"intent_config":cfg,"mode":mode},purpose.format(label=label),(cfg,),700_000)

    strategic = (
        ("page_consolidation_query_overlap_risk","query_overlap","Measure pairwise landing-page overlap in observed queries to surface consolidation candidates without auto-merging pages."),
        ("page_split_mixed_intent_risk","mixed_intent","Detect landing pages simultaneously serving materially different configured intent families, a review signal rather than an automatic split."),
        ("top_opportunity_impression_concentration","opportunity_concentration","Measure whether underperforming local opportunity impressions are concentrated in very few landing pages."),
        ("service_portfolio_observed_coverage","service_coverage","Measure which verified service groups are represented in observed search demand."),
        ("location_portfolio_observed_coverage","location_coverage","Measure which verified location groups are represented in observed search demand."),
        ("commercial_location_joint_demand","commercial_location_joint","Measure demand observations containing both commercial and location-qualified evidence."),
        ("urgency_location_joint_demand","urgency_location_joint","Measure demand observations containing both urgency and location-qualified evidence."),
        ("brand_nonbrand_demand_balance","brand_nonbrand_balance","Measure brand versus non-brand observed demand without treating either side as inherently superior."),
        ("search_demand_without_content_document","search_without_content","Detect observed landing URLs absent from the supplied content corpus; this does not claim an indexing state."),
        ("content_document_without_search_observation","content_without_search","Detect supplied content documents with no search-performance observation; this does not claim they are unindexed."),
    )
    for operation,mode,purpose in strategic:
        add(rows,"LOCAL_OPPORTUNITY_TWIN",operation,"MULTI","twin_strategic_portfolio",{"mode":mode},purpose,
            ("local_service_groups","local_location_groups","local_commercial_terms","local_urgency_terms","local_brand_terms"),700_000)

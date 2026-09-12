from __future__ import annotations
from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    intents = (
        ("commercial","local_commercial_terms","commercial-intent"),
        ("service","local_service_terms","service-intent"),
        ("location","local_location_terms","location-qualified"),
        ("urgent","local_urgency_terms","urgent-intent"),
        ("question","local_question_terms","question-intent"),
    )
    bands = (
        ("top3",1000,3000),("page1",3001,10000),
        ("striking",10001,20000),("page3plus",20001,50000),
    )
    for band,lo,hi in bands:
        for intent,cfg,description in intents:
            add(rows,"LOCAL_DEMAND",f"{band}_{intent}_underperformance_opportunity",
                "search_performance_records","search_band_opportunity",
                {"position_min_milli":lo,"position_max_milli":hi,"min_impressions":50,"max_ctr_ppm":50_000},
                f"Detect {description} queries in the {band} ranking band with material impressions and weak observed CTR.",
                (cfg,),600_000)
            add(rows,"LOCAL_DEMAND",f"{band}_{intent}_zero_click_opportunity",
                "search_performance_records","search_band_opportunity",
                {"position_min_milli":lo,"position_max_milli":hi,"min_impressions":25,"max_ctr_ppm":0},
                f"Detect {description} queries in the {band} ranking band receiving impressions but no clicks.",
                (cfg,),700_000)

    for intent,cfg,description in intents:
        for weight in ("impressions","clicks"):
            add(rows,"LOCAL_DEMAND",f"{intent}_{weight}_demand_share_floor",
                "search_performance_records","search_pattern_share",
                {"weight_field":weight,"comparison":"min","share_ppm":100_000},
                f"Measure whether {description} queries contribute a meaningful floor of observed {weight}.",(cfg,),500_000)
            add(rows,"LOCAL_DEMAND",f"{intent}_{weight}_demand_concentration_ceiling",
                "search_performance_records","search_pattern_share",
                {"weight_field":weight,"comparison":"max","share_ppm":800_000},
                f"Detect over-concentration of observed {weight} in {description} queries.",(cfg,),500_000)

    graph = (
        ("all_queries",None,"all observed"),
        ("commercial_queries","local_commercial_terms","commercial"),
        ("service_queries","local_service_terms","service"),
        ("location_queries","local_location_terms","location-qualified"),
        ("urgent_queries","local_urgency_terms","urgent"),
    )
    for name,cfg,description in graph:
        terms=() if cfg is None else (cfg,)
        add(rows,"LOCAL_DEMAND",f"{name}_page_fragmentation","search_performance_records","search_query_page_degree",
            {"min_pages":2},f"Detect {description} queries distributed across multiple landing pages.",terms,650_000)
        add(rows,"LOCAL_DEMAND",f"{name}_severe_page_fragmentation","search_performance_records","search_query_page_degree",
            {"min_pages":3},f"Detect {description} queries distributed across three or more landing pages.",terms,700_000)
        add(rows,"LOCAL_DEMAND",f"{name}_landing_query_breadth","search_performance_records","search_page_query_degree",
            {"min_queries":10},f"Identify landing pages carrying unusually broad {description} demand.",terms,500_000)
        add(rows,"LOCAL_DEMAND",f"{name}_landing_query_overload","search_performance_records","search_page_query_degree",
            {"min_queries":25},f"Identify landing pages carrying very broad {description} demand that may hide distinct needs.",terms,600_000)

    for intent,cfg,description in intents:
        add(rows,"LOCAL_DEMAND",f"{intent}_opportunity_pareto_frontier","search_performance_records","search_pareto_frontier",
            {"min_impressions":25,"position_max_milli":50_000},
            f"Compute the non-dominated opportunity frontier for {description} queries across impressions, CTR deficit and rank distance.",
            (cfg,),700_000)
    for intent,cfg,description in intents:
        add(rows,"LOCAL_DEMAND",f"{intent}_query_impression_gini","search_performance_records","search_gini_concentration",
            {"weight_field":"impressions","group_by":"query"},
            f"Measure integer Gini concentration of impressions among {description} queries.",(cfg,),600_000)

    for metric in ("impressions","clicks"):
        add(rows,"LOCAL_DEMAND",f"service_location_{metric}_tensor_coverage",
            "search_performance_records","search_service_location_tensor",{"weight_field":metric,"mode":"coverage"},
            f"Build a service×location demand tensor and measure classified combinations by {metric}.",
            ("local_service_groups","local_location_groups"),700_000)
    add(rows,"LOCAL_DEMAND","service_location_zero_click_tensor","search_performance_records","search_service_location_tensor",
        {"weight_field":"impressions","mode":"zero_click"},"Locate service×location cells with impressions but zero clicks.",
        ("local_service_groups","local_location_groups"),700_000)
    add(rows,"LOCAL_DEMAND","service_location_rank_gap_tensor","search_performance_records","search_service_location_tensor",
        {"weight_field":"impressions","mode":"rank_gap"},"Locate service×location cells concentrated outside the first result page.",
        ("local_service_groups","local_location_groups"),700_000)
    add(rows,"LOCAL_DEMAND","service_location_page_dispersion_tensor","search_performance_records","search_service_location_tensor",
        {"weight_field":"impressions","mode":"page_dispersion"},"Locate service×location demand dispersed across multiple landing pages.",
        ("local_service_groups","local_location_groups"),700_000)

    for name,cfg,description in (
        ("commercial","local_commercial_terms","commercial-intent"),
        ("service","local_service_terms","service-intent"),
        ("location","local_location_terms","location-qualified"),
    ):
        add(rows,"LOCAL_DEMAND",f"{name}_ctr_confidence_gap","search_performance_records","search_ctr_confidence",
            {"min_impressions":40,"expected_ctr_ppm":60_000},
            f"Use integer confidence bounds to flag {description} CTR underperformance only with sufficient sample.",(cfg,),750_000)
    add(rows,"LOCAL_DEMAND","commercial_click_efficiency_lift","search_performance_records","search_subset_lift",
        {"numerator":"clicks","denominator":"impressions"},"Compare commercial-intent click efficiency with the whole query corpus.",
        ("local_commercial_terms",),600_000)
    add(rows,"LOCAL_DEMAND","service_location_click_efficiency_lift","search_performance_records","search_intersection_lift",
        {"numerator":"clicks","denominator":"impressions"},"Compare click efficiency of queries containing both verified service and location terms.",
        ("local_service_terms","local_location_terms"),600_000)

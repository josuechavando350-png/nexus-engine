from __future__ import annotations

from typing import Any
from .specs_common import add

_SCOPES = (
    ("all", "none", "all observed search demand"),
    ("commercial", "local_commercial_terms", "commercial-intent demand"),
    ("service", "local_service_terms", "verified service demand"),
    ("location", "local_location_terms", "location-qualified demand"),
    ("urgency", "local_urgency_terms", "urgent-intent demand"),
)

_METRICS = (
    ("page_impression_concentration", "authority_page_impression_concentration", 250_000, "Measure whether {label} impressions are excessively concentrated on one landing document."),
    ("page_click_concentration", "authority_page_click_concentration", 250_000, "Measure whether {label} clicks are excessively concentrated on one landing document."),
    ("query_fragmentation", "authority_query_fragmentation", 700_000, "Measure how often one observed query in {label} is fragmented across multiple landing pages."),
    ("impression_weighted_query_fragmentation", "authority_impression_weighted_fragmentation", 700_000, "Weight query-to-page fragmentation by observed impressions for {label}."),
    ("page_query_breadth_concentration", "authority_page_query_breadth", 300_000, "Measure whether query breadth for {label} is disproportionately concentrated on one page."),
    ("page_intent_mixing", "authority_page_intent_mixing", 700_000, "Detect pages receiving three or more configured intent families within {label}, for human review rather than automatic splitting."),
    ("demand_orphan_content_gap", "authority_demand_orphan_content_gap", 950_000, "Measure observed {label} impressions whose landing document is absent from the supplied content corpus; this is not an index-state claim."),
    ("query_content_edge_support", "authority_query_content_edge_support", 700_000, "Measure impression-weighted lexical support between observed queries and supplied landing content for {label}."),
    ("query_content_token_jaccard", "authority_query_content_jaccard", 10_000, "Measure weighted query-to-document token overlap for {label} as an evidence signal, not a ranking score."),
    ("local_identity_corroboration", "authority_local_identity_support", 700_000, "Measure whether landing documents serving {label} visibly corroborate supplied local-business identity evidence."),
    ("brand_nonbrand_bridge_coverage", "authority_brand_nonbrand_bridge", 100_000, "Measure pages that legitimately bridge brand and non-brand observations inside {label}."),
    ("zero_click_demand_gap", "authority_zero_click_demand_gap", 500_000, "Measure the share of {label} impressions attached to zero-click observations for prioritization."),
    ("first_page_underclick_gap", "authority_first_page_underclick_gap", 600_000, "Measure under-clicked observations already appearing in supplied top-ten position data for {label}."),
    ("position_weighted_visibility", "authority_position_weighted_visibility", 300_000, "Compute a bounded position-bucket visibility index for {label}; this is descriptive and not a rank forecast."),
    ("page_demand_gini_health", "authority_page_demand_gini", 250_000, "Measure inequality of observed {label} demand across landing pages using integer Gini arithmetic."),
    ("query_demand_gini_health", "authority_query_demand_gini", 250_000, "Measure inequality of observed {label} demand across queries using integer Gini arithmetic."),
    ("pareto_page_efficiency", "authority_pareto_page_efficiency", 200_000, "Measure how small a landing-page set carries eighty percent of {label} impressions."),
    ("bipartite_component_health", "authority_bipartite_component_health", 500_000, "Measure connectedness of the observed query↔page bipartite graph for {label}."),
    ("page_pair_query_overlap_health", "authority_page_pair_query_overlap", 300_000, "Measure the strongest pairwise query-set overlap among landing pages serving {label}."),
    ("service_location_cell_fragmentation", "authority_service_location_cell_fragmentation", 700_000, "Measure service×location demand cells fragmented across multiple landing pages inside {label}."),
)

def build(rows: list[dict[str, Any]]) -> None:
    for scope, config_key, label in _SCOPES:
        for suffix, kernel, threshold, purpose in _METRICS:
            config_terms = () if config_key == "none" else (config_key,)
            if kernel == "authority_brand_nonbrand_bridge":
                config_terms = tuple(sorted(set(config_terms + ("local_brand_terms",))))
            if kernel == "authority_page_intent_mixing":
                config_terms = tuple(sorted(set(config_terms + (
                    "local_commercial_terms", "local_service_terms", "local_location_terms",
                    "local_urgency_terms", "local_question_terms", "local_brand_terms",
                ))))
            if kernel == "authority_service_location_cell_fragmentation":
                config_terms = tuple(sorted(set(config_terms + ("local_service_groups", "local_location_groups"))))
            add(
                rows,
                "LOCAL_AUTHORITY_GRAPH",
                f"{scope}_{suffix}",
                "MULTI",
                kernel,
                {"scope_config": config_key, "coverage_target_ppm": 800_000, "ctr_floor_ppm": 20_000},
                purpose.format(label=label),
                config_terms,
                threshold,
            )

from __future__ import annotations

from typing import Any
from .specs_common import add

_SCOPES = (
    ("all", "none", "all observed demand"),
    ("commercial", "local_commercial_terms", "commercial-intent demand"),
    ("service", "local_service_terms", "verified service demand"),
    ("location", "local_location_terms", "location-qualified demand"),
    ("urgency", "local_urgency_terms", "urgent-intent demand"),
)

_METRICS = (
    ("impression_share", "conversion_impression_share", 50_000, "Measure the share of total observed impressions represented by {label}."),
    ("click_share", "conversion_click_share", 50_000, "Measure the share of total observed clicks represented by {label}."),
    ("ctr_health", "conversion_ctr_health", 20_000, "Measure observed aggregate CTR for {label} using only supplied search-performance evidence."),
    ("zero_click_health", "conversion_zero_click_health", 500_000, "Measure the complement of zero-click impression share for {label}."),
    ("top10_visibility_share", "conversion_top10_visibility_share", 300_000, "Measure the share of {label} impressions attached to supplied top-ten average-position observations; this is descriptive, not predictive."),
    ("rank_gap_health", "conversion_rank_gap_health", 400_000, "Measure the complement of {label} impressions attached to observations outside the supplied top-ten position band."),
    ("content_support", "conversion_content_support", 700_000, "Measure whether {label} impressions land on supplied documents with visible lexical support for the observed query."),
    ("local_identity_support", "conversion_identity_support", 700_000, "Measure whether pages serving {label} visibly corroborate supplied local-business identity evidence."),
    ("page_specialization", "conversion_page_specialization", 500_000, "Measure how much {label} demand lands on pages where that scope is a clear majority of the page's observed demand."),
    ("landing_concentration_health", "conversion_landing_concentration_health", 250_000, "Measure whether {label} impressions are excessively concentrated on a single landing page."),
    ("query_breadth_share", "conversion_query_breadth_share", 50_000, "Measure the proportion of unique observed queries represented by {label}."),
    ("longtail_impression_share", "conversion_longtail_impression_share", 100_000, "Measure the share of {label} impressions coming from queries of four or more tokens."),
    ("lead_priority_index", "conversion_lead_priority", 5_000, "Combine observed {label} impression share with the explicitly supplied organic lead-conversion rate to create a bounded prioritization index; never a lead forecast."),
    ("close_priority_index", "conversion_close_priority", 5_000, "Combine observed {label} click share with the explicitly supplied organic close rate to create a bounded prioritization index; never a client forecast."),
    ("composed_conversion_priority_index", "conversion_composed_priority", 1_000, "Combine observed {label} impression share with explicitly supplied lead and close rates to rank review priority; never a revenue or client forecast."),
    ("zero_click_lead_priority", "conversion_zero_click_lead_priority", 5_000, "Weight zero-click exposure inside {label} by explicitly supplied organic lead-conversion evidence for review priority only."),
    ("rank_gap_lead_priority", "conversion_rank_gap_lead_priority", 5_000, "Weight outside-top-ten exposure inside {label} by explicitly supplied organic lead-conversion evidence for review priority only."),
    ("content_gap_lead_priority", "conversion_content_gap_lead_priority", 5_000, "Weight content-support gaps inside {label} by explicitly supplied organic lead-conversion evidence for review priority only."),
)

def build(rows: list[dict[str, Any]]) -> None:
    for scope, config_key, label in _SCOPES:
        for suffix, kernel, threshold, purpose in _METRICS:
            config_terms = () if config_key == "none" else (config_key,)
            if kernel in {
                "conversion_lead_priority", "conversion_close_priority", "conversion_composed_priority",
                "conversion_zero_click_lead_priority", "conversion_rank_gap_lead_priority",
                "conversion_content_gap_lead_priority",
            }:
                config_terms = tuple(sorted(set(config_terms + ("organic_funnel_source_ids",))))
            add(
                rows,
                "LOCAL_CONVERSION_INTELLIGENCE",
                f"{scope}_{suffix}",
                "MULTI",
                kernel,
                {"scope_config": config_key, "specialization_floor_ppm": 600_000, "longtail_min_tokens": 4},
                purpose.format(label=label),
                config_terms,
                threshold,
            )

from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m2200_release_guard", "predecessor_safe", "Require exact M2200 entity-proof certification before traffic-portfolio certification."),
        ("traffic_portfolio_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M2201-M2290 receipt hashes and fail closed on mismatch."),
        ("traffic_portfolio_execution_success_guard", "current_execution_success", "Require every M2201-M2290 portfolio capability to execute successfully."),
        ("traffic_portfolio_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across the traffic portfolio."),
        ("traffic_portfolio_forbidden_claim_guard", "forbidden_claims", "Reject guaranteed ranking/indexing/revenue, doorway, cloaking, link-scheme or manipulative semantics."),
        ("traffic_portfolio_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("traffic_portfolio_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping across M2201-M2290."),
        ("traffic_portfolio_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique operation and algorithm identities across M2201-M2290."),
        ("traffic_portfolio_existing_contract_only_guard", "existing_contract_only", "Require every portfolio proof to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 2201, "current_end": 2290, "predecessor_module": "M2200"}
    for operation, mode, purpose in guards:
        add(rows, "TRAFFIC_PORTFOLIO_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "TRAFFIC_PORTFOLIO_CERTIFICATION", "local_traffic_portfolio_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M2200", "guard_start": 2291, "guard_end": 2299,
         "certified_start": "M1001", "certified_end": "M2300"},
        "Certify M2200 plus exact M2291-M2299 traffic-portfolio guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

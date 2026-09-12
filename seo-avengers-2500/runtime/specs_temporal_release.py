from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m2300_release_guard", "predecessor_safe", "Require exact M2300 traffic-portfolio certification before temporal-observatory certification."),
        ("temporal_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M2301-M2390 receipt hashes and fail closed on mismatch."),
        ("temporal_execution_success_guard", "current_execution_success", "Require every M2301-M2390 temporal capability to execute successfully."),
        ("temporal_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across the temporal observatory."),
        ("temporal_forbidden_claim_guard", "forbidden_claims", "Reject causal certainty, guaranteed ranking/indexing/revenue, doorway, cloaking or manipulative semantics."),
        ("temporal_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("temporal_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping across M2301-M2390."),
        ("temporal_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique operation and algorithm identities across M2301-M2390."),
        ("temporal_existing_contract_only_guard", "existing_contract_only", "Require every temporal proof to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 2301, "current_end": 2390, "predecessor_module": "M2300"}
    for operation, mode, purpose in guards:
        add(rows, "TEMPORAL_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "TEMPORAL_CERTIFICATION", "organic_temporal_observatory_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M2300", "guard_start": 2391, "guard_end": 2399,
         "certified_start": "M1001", "certified_end": "M2400"},
        "Certify M2300 plus exact M2391-M2399 temporal-observatory guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

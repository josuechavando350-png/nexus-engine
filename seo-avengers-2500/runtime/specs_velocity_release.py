from __future__ import annotations

from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m1600_release_guard", "predecessor_safe", "Require the exact M1600 certifier to be healthy and release-safe before discovery-velocity certification."),
        ("discovery_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M1601-M1690 receipt hashes and fail closed on any mismatch."),
        ("discovery_execution_success_guard", "current_execution_success", "Require every M1601-M1690 capability to execute successfully before this batch can certify."),
        ("discovery_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across the discovery-velocity slice."),
        ("discovery_forbidden_claim_guard", "forbidden_claims", "Reject guaranteed crawl/index timing, guaranteed ranking, ban-proof claims, or manipulative search-engine semantics."),
        ("discovery_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("discovery_source_mapping_guard", "source_mapping_integrity", "Require exact source_module == module + 1000 mapping across M1601-M1690."),
        ("discovery_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique, well-formed algorithm namespaces and operation identities."),
        ("discovery_existing_contract_only_guard", "existing_contract_only", "Require the discovery slice to declare that it consumes only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 1601, "current_end": 1690, "predecessor_module": "M1600"}
    for operation, mode, purpose in guards:
        add(rows, "DISCOVERY_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "DISCOVERY_CERTIFICATION", "discovery_velocity_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M1600", "guard_start": 1691, "guard_end": 1699,
         "certified_start": "M1001", "certified_end": "M1700"},
        "Certify M1600 plus exact M1691-M1699 discovery guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

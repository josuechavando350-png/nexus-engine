from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m2000_release_guard", "predecessor_safe", "Require exact M2000 link-counterfactual certification before representation certification."),
        ("representation_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M2001-M2090 receipt hashes and fail closed on mismatch."),
        ("representation_execution_success_guard", "current_execution_success", "Require every M2001-M2090 proof capability to execute successfully."),
        ("representation_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY across the representation proof mesh."),
        ("representation_forbidden_claim_guard", "forbidden_claims", "Reject guaranteed rich-result, ranking, crawl/index, doorway, cloaking or link-scheme semantics."),
        ("representation_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("representation_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping across M2001-M2090."),
        ("representation_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique operation and algorithm identities across M2001-M2090."),
        ("representation_existing_contract_only_guard", "existing_contract_only", "Require every representation proof to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 2001, "current_end": 2090, "predecessor_module": "M2000"}
    for operation, mode, purpose in guards:
        add(rows, "REPRESENTATION_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "REPRESENTATION_CERTIFICATION", "search_representation_proof_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M2000", "guard_start": 2091, "guard_end": 2099,
         "certified_start": "M1001", "certified_end": "M2100"},
        "Certify M2000 plus exact M2091-M2099 representation guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

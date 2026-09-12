from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m2100_release_guard", "predecessor_safe", "Require exact M2100 search-representation certification before entity-graph certification."),
        ("entity_graph_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M2101-M2190 receipt hashes and fail closed on mismatch."),
        ("entity_graph_execution_success_guard", "current_execution_success", "Require every M2101-M2190 entity-proof capability to execute successfully."),
        ("entity_graph_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across the entity proof graph."),
        ("entity_graph_forbidden_claim_guard", "forbidden_claims", "Reject invented entity/location/service/review, guaranteed ranking/indexing, cloaking, doorway or link-scheme semantics."),
        ("entity_graph_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("entity_graph_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping across M2101-M2190."),
        ("entity_graph_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique operation and algorithm identities across M2101-M2190."),
        ("entity_graph_existing_contract_only_guard", "existing_contract_only", "Require every entity-graph proof to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 2101, "current_end": 2190, "predecessor_module": "M2100"}
    for operation, mode, purpose in guards:
        add(rows, "ENTITY_GRAPH_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "ENTITY_GRAPH_CERTIFICATION", "local_entity_proof_graph_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M2100", "guard_start": 2191, "guard_end": 2199,
         "certified_start": "M1001", "certified_end": "M2200"},
        "Certify M2100 plus exact M2191-M2199 entity-graph guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m1800_release_guard", "predecessor_safe", "Require exact M1800 topical certifier safety before demand-frontier certification."),
        ("frontier_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute exact M1801-M1890 receipt hashes and fail closed on mismatch."),
        ("frontier_execution_success_guard", "current_execution_success", "Require successful execution of every M1801-M1890 frontier capability."),
        ("frontier_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across M1801-M1890."),
        ("frontier_forbidden_claim_guard", "forbidden_claims", "Reject guaranteed-rank/index/crawl, manipulation, doorway or cloaking semantics."),
        ("frontier_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new APIs, databases, queues, secrets, cloud resources and daemons."),
        ("frontier_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping for M1801-M1890."),
        ("frontier_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require collision-free algorithm namespaces and operation identities."),
        ("frontier_existing_contract_only_guard", "existing_contract_only", "Require all frontier analytics to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 1801, "current_end": 1890, "predecessor_module": "M1800"}
    for operation, mode, purpose in guards:
        add(rows, "FRONTIER_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "FRONTIER_CERTIFICATION", "local_demand_frontier_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M1800", "guard_start": 1891, "guard_end": 1899,
         "certified_start": "M1001", "certified_end": "M1900"},
        "Certify M1800 plus exact M1891-M1899 demand-frontier guards and fail closed on missing, corrupt or blocking evidence.",
        (), 1_000_000)

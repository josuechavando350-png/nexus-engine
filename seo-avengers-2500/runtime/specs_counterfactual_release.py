from __future__ import annotations

from typing import Any
from .specs_common import add


def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m1900_release_guard", "predecessor_safe", "Require exact M1900 demand-frontier certifier safety before link-counterfactual certification."),
        ("counterfactual_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute exact M1901-M1990 receipt hashes and fail closed on mismatch."),
        ("counterfactual_execution_success_guard", "current_execution_success", "Require successful execution of every M1901-M1990 counterfactual capability."),
        ("counterfactual_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across M1901-M1990."),
        ("counterfactual_forbidden_claim_guard", "forbidden_claims", "Reject guaranteed-rank/index/crawl, manipulation, doorway, cloaking, link-scheme, or PageRank-claim semantics."),
        ("counterfactual_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new APIs, databases, queues, secrets, cloud resources and daemons."),
        ("counterfactual_source_mapping_guard", "source_mapping_integrity", "Require exact source-module mapping for M1901-M1990."),
        ("counterfactual_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require collision-free algorithm namespaces and operation identities."),
        ("counterfactual_existing_contract_only_guard", "existing_contract_only", "Require all counterfactual analytics to consume only existing NEXUS evidence contracts."),
    )
    base = {"current_start": 1901, "current_end": 1990, "predecessor_module": "M1900"}
    for operation, mode, purpose in guards:
        add(rows, "LINK_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "LINK_CERTIFICATION", "local_link_counterfactual_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M1900", "guard_start": 1991, "guard_end": 1999,
         "certified_start": "M1001", "certified_end": "M2000"},
        "Certify M1900 plus exact M1991-M1999 internal-link counterfactual guards and fail closed on missing, corrupt or blocking evidence.",
        (), 1_000_000)

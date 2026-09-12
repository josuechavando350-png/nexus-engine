from __future__ import annotations

from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m1400_release_guard", "m1400_safe", "Require the exact M1400 readiness certifier to be healthy and release-safe before this batch can certify."),
        ("current_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute evidence hashes for every M1401-M1590 receipt and fail closed on any mismatch."),
        ("current_execution_integrity_guard", "current_execution_integrity", "Require valid receipt status domains and SUCCESS execution for every M1401-M1590 module before certification."),
        ("current_policy_action_metadata_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata on every current-batch receipt."),
        ("forbidden_claim_semantics_guard", "forbidden_claims", "Reject outputs that claim guaranteed ranking, ban-proof status, definite index state, or manipulative Google behavior."),
        ("conversion_forecast_disclaimer_guard", "forecast_disclaimer", "Require explicit non-forecast disclaimers on every conversion-priority receipt."),
        ("zero_new_infrastructure_contract_guard", "zero_new_infrastructure", "Require the hash-bound runtime contract on every current receipt to declare zero new APIs, databases, queues, secrets, cloud resources, and daemons."),
        ("source_mapping_integrity_guard", "source_mapping_integrity", "Require exact source_module == module_id + 1000 mapping for every M1401-M1590 receipt."),
        ("algorithm_operation_uniqueness_guard", "algorithm_uniqueness", "Require current-batch algorithm namespaces and operations to be well-formed and collision-free."),
    )
    for operation, mode, purpose in guards:
        add(rows, "LOCAL_GROWTH_CERTIFICATION", operation, "MULTI", "growth_release_guard", {"mode": mode}, purpose, (), 1_000_000)

    add(
        rows,
        "LOCAL_GROWTH_CERTIFICATION",
        "local_authority_conversion_batch_certifier",
        "MULTI",
        "growth_release_gate",
        {"required_guard_modules": [f"M{i}" for i in range(1591, 1600)]},
        "Certify M1400 plus the exact M1591-M1599 guard receipts; fail closed on missing, corrupt, non-success, or blocking evidence.",
        (),
        1_000_000,
    )

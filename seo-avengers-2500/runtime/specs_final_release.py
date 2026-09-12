from __future__ import annotations

from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("global_exact_local_receipt_range_guard", "exact_local_receipt_range", "Require exact contiguous local receipt context M1001-M2490."),
        ("global_receipt_hash_integrity_guard", "global_receipt_hash_integrity", "Recompute every local receipt hash through M2490 and fail closed on any mismatch."),
        ("global_execution_integrity_guard", "global_execution_integrity", "Require every local module M1001-M2490 to remain inside the valid SUCCESS/INSUFFICIENT_DATA status domain with no runtime ERROR."),
        ("global_policy_action_integrity_guard", "global_policy_action_integrity", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across all M1001-M2490 receipts."),
        ("global_runtime_contract_integrity_guard", "global_runtime_contract_integrity", "Require every successful local receipt to bind zero-new-infrastructure runtime fields."),
        ("global_operation_algorithm_uniqueness_guard", "global_operation_algorithm_uniqueness", "Require unique operation and algorithm identities across the entire M1001-M2490 local receipt set."),
        ("global_source_mapping_integrity_guard", "global_source_mapping_integrity", "Require exact source-module mapping Mx -> M(x+1000) through M2490."),
        ("global_forbidden_claim_absence_guard", "global_forbidden_claim_absence", "Reject guaranteed rankings/indexing/crawl, ban-proof claims, cloaking, doorway, link-scheme, fake-review/location, or Google-manipulation semantics."),
        ("global_certifier_chain_and_compliance_guard", "certifier_chain_and_compliance_safe", "Require every prior certifier M1200..M2400 to remain release-safe and the M2401-M2490 compliance slice to be clean."),
    )
    for operation, mode, purpose in guards:
        add(rows, "GLOBAL_COMPOSITION_CERTIFICATION", operation, "MULTI", "global_composition_guard", {"mode": mode}, purpose, (), 1_000_000)
    add(
        rows,
        "GLOBAL_COMPOSITION_CERTIFICATION",
        "seo_avengers_2500_terminal_composition_certifier",
        "MULTI",
        "terminal_composition_certifier",
        {"mode": "terminal_m2500"},
        "Terminally certify the exact M001-M2500 composition contract only when the delegated M001-M1000 runtime is wired, M1001-M2500 are exact/unique/safe, M1001-M2499 receipts are hash-valid, all global guards pass, and M2501 is absent.",
        (),
        1_000_000,
    )

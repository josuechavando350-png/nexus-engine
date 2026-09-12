from __future__ import annotations

from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    guards = (
        ("predecessor_m1700_release_guard", "predecessor_safe", "Require the exact M1700 discovery certifier to be healthy and release-safe before topical certification."),
        ("topical_receipt_hash_integrity_guard", "current_hash_integrity", "Recompute M1701-M1790 receipt hashes and fail closed on any mismatch."),
        ("topical_execution_success_guard", "current_execution_success", "Require every M1701-M1790 capability to execute successfully before this batch can certify."),
        ("topical_policy_action_guard", "policy_action_metadata", "Require SAFE_WHITE_HAT and OBSERVE_ONLY metadata across the local topical lattice."),
        ("topical_forbidden_claim_guard", "forbidden_claims", "Reject doorway, scaled-spam, guaranteed-ranking, guaranteed-indexing, or manipulative search-engine semantics."),
        ("topical_zero_infrastructure_guard", "zero_new_infrastructure", "Require zero new API/database/queue/secret/cloud-resource/daemon dependencies."),
        ("topical_source_mapping_guard", "source_mapping_integrity", "Require exact source_module == module + 1000 mapping across M1701-M1790."),
        ("topical_algorithm_uniqueness_guard", "algorithm_uniqueness", "Require unique, well-formed algorithm namespaces and operation identities."),
        ("topical_existing_contract_only_guard", "existing_contract_only", "Require the topical slice to declare that it consumes only existing NEXUS evidence contracts and verified project vocabulary."),
    )
    base = {"current_start": 1701, "current_end": 1790, "predecessor_module": "M1700"}
    for operation, mode, purpose in guards:
        add(rows, "TOPICAL_CERTIFICATION", operation, "MULTI", "extended_release_guard",
            {**base, "mode": mode}, purpose, (), 1_000_000)
    add(rows, "TOPICAL_CERTIFICATION", "local_topical_lattice_batch_certifier", "MULTI",
        "extended_release_gate",
        {"predecessor_module": "M1700", "guard_start": 1791, "guard_end": 1799,
         "certified_start": "M1001", "certified_end": "M1800"},
        "Certify M1700 plus exact M1791-M1799 topical guards; fail closed on missing, corrupt, non-success or blocking evidence.",
        (), 1_000_000)

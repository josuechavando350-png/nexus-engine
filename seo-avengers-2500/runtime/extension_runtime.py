from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import InvalidData, normalize_content_documents, normalize_local_records, normalize_search_records
from .kernel_discovery import discovery_velocity_metric
from .kernel_topical import topical_lattice_metric
from .kernel_frontier import demand_frontier_metric
from .kernel_counterfactual import link_counterfactual_metric
from .kernel_representation import representation_proof_metric
from .kernel_entity_graph import entity_proof_graph_metric
from .kernel_extended_release import extended_release_guard, extended_release_gate

_EXISTING_LIST_CONTRACTS = (
    "search_intent_records",
    "canonicalization_records",
    "persistence_state_records",
    "edge_gateway_records",
    "cwv_edge_records",
    "policy_audit_records",
    "semantic_text_records",
    "revenue_funnel_records",
    "content_decay_records",
    "upstream_evidence",
)

def _existing_list(payload: Mapping[str, Any], key: str) -> list[Any]:
    raw = payload.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    return list(raw)

def _normalize_multi(payload: Mapping[str, Any]) -> Dict[str, Any]:
    search, search_invalid = normalize_search_records(payload.get("search_performance_records", []))
    documents, content_invalid = normalize_content_documents(payload.get("content_documents", []))
    local, local_invalid = normalize_local_records(payload.get("local_business_records", []))
    normalized: Dict[str, Any] = {
        "search_performance_records": search,
        "content_documents": documents,
        "local_business_records": local,
        "invalid_records_count": search_invalid + content_invalid + local_invalid,
    }
    for key in _EXISTING_LIST_CONTRACTS:
        normalized[key] = _existing_list(payload, key)
    normalized["upstream_evidence_raw"] = list(normalized["upstream_evidence"])
    return normalized

def _effective_spec(spec: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    module_id = str(spec.get("module_id") or "")
    if not module_id:
        raise InvalidData("module_id_missing")
    threshold_key = f"{module_id.lower()}_threshold_ppm"
    threshold = config.get(threshold_key, spec.get("threshold_ppm"))
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise InvalidData(f"{threshold_key}_invalid")
    effective = dict(spec)
    effective["threshold_ppm"] = threshold
    return effective

def evaluate_extension_spec(
    spec: Mapping[str, Any],
    payload: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    prior_receipts: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[Any, Any, Dict[str, Any]]:
    if spec.get("dataset_key") != "MULTI":
        raise InvalidData("extension_requires_multi_dataset")
    effective = _effective_spec(spec, config)
    normalized = _normalize_multi(payload)
    kernel = effective.get("kernel")
    if kernel == "discovery_velocity_metric":
        score, violation, details = discovery_velocity_metric(effective, normalized, config)
    elif kernel == "topical_lattice_metric":
        score, violation, details = topical_lattice_metric(effective, normalized, config)
    elif kernel == "demand_frontier_metric":
        score, violation, details = demand_frontier_metric(effective, normalized, config)
    elif kernel == "link_counterfactual_metric":
        score, violation, details = link_counterfactual_metric(effective, normalized, config)
    elif kernel == "representation_proof_metric":
        score, violation, details = representation_proof_metric(effective, normalized, config)
    elif kernel == "entity_proof_graph_metric":
        score, violation, details = entity_proof_graph_metric(effective, normalized, config)
    elif kernel == "extended_release_guard":
        score, violation, details = extended_release_guard(effective, normalized, config, prior_receipts)
    elif kernel == "extended_release_gate":
        score, violation, details = extended_release_gate(effective, normalized, config, prior_receipts)
    else:
        raise InvalidData(f"unsupported_extension_kernel:{kernel}")
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 1_000_000:
        raise InvalidData("extension_kernel_score_out_of_range")
    return payload, normalized, {"score_ppm": score, "violation": bool(violation), **details}

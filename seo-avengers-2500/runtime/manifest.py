from __future__ import annotations

from types import MappingProxyType
from typing import Any, Dict, Mapping

from .common import hash_value
from . import (
    specs_demand,
    specs_entity,
    specs_content,
    specs_policy,
    specs_twin,
    specs_indexation,
    specs_authority,
    specs_conversion,
    specs_release,
    specs_discovery,
    specs_velocity_release,
    specs_topical,
    specs_topical_release,
    specs_frontier,
    specs_frontier_release,
    specs_counterfactual,
    specs_counterfactual_release,
    specs_representation,
    specs_representation_release,
    specs_entity_graph,
    specs_entity_graph_release,
    specs_traffic_portfolio,
    specs_traffic_portfolio_release,
    specs_temporal,
    specs_temporal_release,
)

_ROWS: list[dict[str, Any]] = []
specs_demand.build(_ROWS)
specs_entity.build(_ROWS)
specs_content.build(_ROWS)
specs_policy.build(_ROWS)
specs_twin.build(_ROWS)
specs_indexation.build(_ROWS)
specs_authority.build(_ROWS)
specs_conversion.build(_ROWS)
specs_release.build(_ROWS)
specs_discovery.build(_ROWS)
specs_velocity_release.build(_ROWS)
specs_topical.build(_ROWS)
specs_topical_release.build(_ROWS)
specs_frontier.build(_ROWS)
specs_frontier_release.build(_ROWS)
specs_counterfactual.build(_ROWS)
specs_counterfactual_release.build(_ROWS)
specs_representation.build(_ROWS)
specs_representation_release.build(_ROWS)
specs_entity_graph.build(_ROWS)
specs_entity_graph_release.build(_ROWS)
specs_traffic_portfolio.build(_ROWS)
specs_traffic_portfolio_release.build(_ROWS)
specs_temporal.build(_ROWS)
specs_temporal_release.build(_ROWS)

MODULE_SPECS: Dict[str, Dict[str, Any]] = {row["module_id"]: row for row in _ROWS}
TARGET_MODULES = tuple(f"M{i}" for i in range(1001, 2401))
SOURCE_MODULES = tuple(f"M{i}" for i in range(2001, 3401))
SUPPORTED_FAMILIES = frozenset({
    "LOCAL_DEMAND",
    "LOCAL_ENTITY",
    "LOCAL_CONTENT",
    "WHITEHAT_POLICY",
    "LOCAL_OPPORTUNITY_TWIN",
    "INDEXATION_READINESS",
    "LOCAL_AUTHORITY_GRAPH",
    "LOCAL_CONVERSION_INTELLIGENCE",
    "LOCAL_GROWTH_CERTIFICATION",
    "DISCOVERY_VELOCITY",
    "DISCOVERY_CERTIFICATION",
    "LOCAL_TOPICAL_LATTICE",
    "TOPICAL_CERTIFICATION",
    "LOCAL_DEMAND_FRONTIER",
    "FRONTIER_CERTIFICATION",
    "LOCAL_LINK_COUNTERFACTUAL",
    "LINK_CERTIFICATION",
    "SEARCH_REPRESENTATION_PROOF",
    "REPRESENTATION_CERTIFICATION",
    "LOCAL_ENTITY_PROOF_GRAPH",
    "ENTITY_GRAPH_CERTIFICATION",
    "LOCAL_TRAFFIC_PORTFOLIO",
    "TRAFFIC_PORTFOLIO_CERTIFICATION",
    "ORGANIC_TEMPORAL_OBSERVATORY",
    "TEMPORAL_CERTIFICATION",
})

if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("target range drift")
if len(MODULE_SPECS) != 1400:
    raise RuntimeError("module cardinality mismatch")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != 1400:
    raise RuntimeError("operation collision")
if tuple(spec["source_module"] for spec in MODULE_SPECS.values()) != SOURCE_MODULES:
    raise RuntimeError("source mapping drift")
if len({spec["kernel"] for spec in MODULE_SPECS.values()}) < 74:
    raise RuntimeError("kernel diversity unexpectedly low")
if any(spec["family"] not in SUPPORTED_FAMILIES for spec in MODULE_SPECS.values()):
    raise RuntimeError("unsupported family")
if any(spec["policy_status"] != "SAFE_WHITE_HAT" for spec in MODULE_SPECS.values()):
    raise RuntimeError("unsafe policy status")
if any(spec["action_mode"] != "OBSERVE_ONLY" for spec in MODULE_SPECS.values()):
    raise RuntimeError("unsafe action mode")

def functional_fingerprint(spec: Mapping[str, Any]) -> str:
    return hash_value({
        "family": spec["family"],
        "operation": spec["operation"],
        "dataset_key": spec["dataset_key"],
        "kernel": spec["kernel"],
        "params": spec["params"],
        "purpose": spec["purpose"],
        "config_terms": spec["config_terms"],
        "policy_status": spec["policy_status"],
        "action_mode": spec["action_mode"],
    })

FINGERPRINTS = {module_id: functional_fingerprint(spec) for module_id, spec in MODULE_SPECS.items()}
if len(set(FINGERPRINTS.values())) != 1400:
    raise RuntimeError("functional fingerprint collision")

READ_ONLY_MODULE_SPECS = MappingProxyType(MODULE_SPECS)

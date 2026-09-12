from __future__ import annotations

from types import MappingProxyType
from typing import Any, Dict, Mapping

from .common import hash_value
from . import specs_demand, specs_entity, specs_content, specs_policy

_ROWS: list[dict[str, Any]] = []
specs_demand.build(_ROWS)
specs_entity.build(_ROWS)
specs_content.build(_ROWS)
specs_policy.build(_ROWS)

MODULE_SPECS: Dict[str, Dict[str, Any]] = {row["module_id"]: row for row in _ROWS}
TARGET_MODULES = tuple(f"M{i}" for i in range(1001, 1201))
SOURCE_MODULES = tuple(f"M{i}" for i in range(2001, 2201))
SUPPORTED_FAMILIES = frozenset({"LOCAL_DEMAND","LOCAL_ENTITY","LOCAL_CONTENT","WHITEHAT_POLICY"})

if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("target range drift")
if len(MODULE_SPECS) != 200:
    raise RuntimeError("module cardinality mismatch")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("operation collision")
if tuple(spec["source_module"] for spec in MODULE_SPECS.values()) != SOURCE_MODULES:
    raise RuntimeError("source mapping drift")
if len({spec["kernel"] for spec in MODULE_SPECS.values()}) < 40:
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
if len(set(FINGERPRINTS.values())) != 200:
    raise RuntimeError("functional fingerprint collision")

READ_ONLY_MODULE_SPECS = MappingProxyType(MODULE_SPECS)

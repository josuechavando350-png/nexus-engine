from __future__ import annotations

from typing import Any, Dict

from .edge_specs import EDGE_SPECS
from .html_specs import HTML_SPECS
from .relational_specs import RELATIONAL_SPECS
from .semantic_specs import SEMANTIC_SPECS

SUPPORTED_FAMILIES = frozenset({
    "SEMANTIC_NLP",
    "HTML_STREAM",
    "EDGE_PERIMETER",
    "RELATIONAL_TERMINAL",
})

MODULE_SPECS: Dict[str, Dict[str, Any]] = {}
for source in (SEMANTIC_SPECS, HTML_SPECS, EDGE_SPECS, RELATIONAL_SPECS):
    for module_id, spec in source.items():
        if module_id in MODULE_SPECS:
            raise RuntimeError(f"duplicate module id:{module_id}")
        MODULE_SPECS[module_id] = dict(spec)

TARGET_MODULES = tuple(f"M{i}" for i in range(801, 1001))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1801, 2001))

if tuple(MODULE_SPECS) != TARGET_MODULES:
    raise RuntimeError("target range drift")
if set(MODULE_SPECS) != set(TARGET_MODULES):
    raise RuntimeError("target set drift")
if {spec["source_module"] for spec in MODULE_SPECS.values()} != set(SOURCE_MODULES):
    raise RuntimeError("source range drift")
if len(MODULE_SPECS) != 200:
    raise RuntimeError("implemented module cardinality mismatch")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("operation collision")
if len({spec["source_module"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("source collision")
if "M1001" in MODULE_SPECS:
    raise RuntimeError("M1001 forbidden")

for target, spec in MODULE_SPECS.items():
    if target != spec.get("module_id"):
        raise RuntimeError("key/spec mismatch")
    if spec.get("source_module") != f"M{int(target[1:]) + 1000}":
        raise RuntimeError("source mapping drift")
    family = spec.get("family")
    if family not in SUPPORTED_FAMILIES:
        raise RuntimeError("unsupported family")
    dataset_key = spec.get("dataset_key")
    if not isinstance(dataset_key, str) or not dataset_key:
        raise RuntimeError("dataset key invalid")
    operation = spec.get("operation")
    if not isinstance(operation, str) or not operation:
        raise RuntimeError("operation invalid")
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise RuntimeError("threshold type")
    if not 0 <= threshold <= 1_000_000:
        raise RuntimeError("threshold range")
    fields = spec.get("input_fields")
    if not isinstance(fields, tuple) or not fields:
        raise RuntimeError("input fields invalid")
    if len(fields) != len(set(fields)):
        raise RuntimeError("input fields duplicate")
    if any(not isinstance(field, str) or not field for field in fields):
        raise RuntimeError("input field invalid")


def source_to_target_map() -> Dict[str, str]:
    return {str(spec["source_module"]): target for target, spec in MODULE_SPECS.items()}

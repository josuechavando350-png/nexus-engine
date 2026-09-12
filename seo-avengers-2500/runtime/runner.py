from __future__ import annotations

from typing import Any, Dict, Mapping

from .catalog import module_registry
from .module_runtime import execute_module

_TERMINAL_MODULES = {"M1200", "M1400", "M1600", "M1700", "M1800"}

def run_module(module_id: str, payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    if module_id in _TERMINAL_MODULES:
        raise ValueError(f"{module_id} requires exact prior receipt context; use the batch runner")
    return execute_module(module_id, payload, config)

def run_batch_1001_1200(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts: Dict[str, Dict[str, Any]] = {}
    for number in range(1001, 1200):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    policy_receipts = {f"M{i}": receipts[f"M{i}"] for i in range(1176, 1200)}
    receipts["M1200"] = execute_module("M1200", payload, config, prior_receipts=policy_receipts)
    if tuple(receipts) != tuple(f"M{i}" for i in range(1001, 1201)):
        raise RuntimeError("batch M1001-M1200 receipt range drift")
    return receipts

def run_batch_1001_1400(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts = run_batch_1001_1200(payload, config)
    for number in range(1201, 1391):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    guard_context: Dict[str, Dict[str, Any]] = {"M1200": receipts["M1200"]}
    for number in range(1201, 1391):
        guard_context[f"M{number}"] = receipts[f"M{number}"]
    for number in range(1391, 1400):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config, prior_receipts=guard_context)
    gate_context: Dict[str, Dict[str, Any]] = {"M1200": receipts["M1200"]}
    for number in range(1391, 1400):
        gate_context[f"M{number}"] = receipts[f"M{number}"]
    receipts["M1400"] = execute_module("M1400", payload, config, prior_receipts=gate_context)
    expected = tuple(f"M{i}" for i in range(1001, 1401))
    if tuple(receipts) != expected:
        raise RuntimeError("batch M1001-M1400 receipt range drift")
    return receipts

def run_batch_1001_1600(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts = run_batch_1001_1400(payload, config)
    for number in range(1401, 1591):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    guard_context: Dict[str, Dict[str, Any]] = {"M1400": receipts["M1400"]}
    for number in range(1401, 1591):
        guard_context[f"M{number}"] = receipts[f"M{number}"]
    for number in range(1591, 1600):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config, prior_receipts=guard_context)
    gate_context: Dict[str, Dict[str, Any]] = {"M1400": receipts["M1400"]}
    for number in range(1591, 1600):
        gate_context[f"M{number}"] = receipts[f"M{number}"]
    receipts["M1600"] = execute_module("M1600", payload, config, prior_receipts=gate_context)
    expected = tuple(f"M{i}" for i in range(1001, 1601))
    if tuple(receipts) != expected:
        raise RuntimeError("batch M1001-M1600 receipt range drift")
    return receipts

def run_batch_1001_1700(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts = run_batch_1001_1600(payload, config)
    for number in range(1601, 1691):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    guard_context: Dict[str, Dict[str, Any]] = {"M1600": receipts["M1600"]}
    for number in range(1601, 1691):
        guard_context[f"M{number}"] = receipts[f"M{number}"]
    for number in range(1691, 1700):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config, prior_receipts=guard_context)
    gate_context: Dict[str, Dict[str, Any]] = {"M1600": receipts["M1600"]}
    for number in range(1691, 1700):
        gate_context[f"M{number}"] = receipts[f"M{number}"]
    receipts["M1700"] = execute_module("M1700", payload, config, prior_receipts=gate_context)
    expected = tuple(f"M{i}" for i in range(1001, 1701))
    if tuple(receipts) != expected:
        raise RuntimeError("batch M1001-M1700 receipt range drift")
    return receipts

def run_batch_1001_1800(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts = run_batch_1001_1700(payload, config)
    for number in range(1701, 1791):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    guard_context: Dict[str, Dict[str, Any]] = {"M1700": receipts["M1700"]}
    for number in range(1701, 1791):
        guard_context[f"M{number}"] = receipts[f"M{number}"]
    for number in range(1791, 1800):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config, prior_receipts=guard_context)
    gate_context: Dict[str, Dict[str, Any]] = {"M1700": receipts["M1700"]}
    for number in range(1791, 1800):
        gate_context[f"M{number}"] = receipts[f"M{number}"]
    receipts["M1800"] = execute_module("M1800", payload, config, prior_receipts=gate_context)
    expected = tuple(f"M{i}" for i in range(1001, 1801))
    if tuple(receipts) != expected:
        raise RuntimeError("batch M1001-M1800 receipt range drift")
    return receipts

def suite_state() -> Dict[str, Any]:
    registry = module_registry()
    return {
        "suite": "SEO_AVENGERS_2500",
        "target_registry_size": 2500,
        "delegated_production_count": 1000,
        "implemented_local_count": 800,
        "reserved_not_executable_count": 700,
        "current_implemented_range": ["M1001", "M1800"],
        "final_target_range": ["M1", "M2500"],
        "m2501_present": False,
        "registry": registry,
    }

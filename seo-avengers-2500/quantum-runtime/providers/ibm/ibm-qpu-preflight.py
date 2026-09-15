#!/usr/bin/env python3
"""Read-only IBM Quantum Compute preflight for NEXUS Quantum One.

This bridge authenticates, resolves one named backend, validates that it is a
physical QPU, captures backend status/capability/topology evidence, and performs
seeded ISA transpilation of the exact logical circuit. It never submits a
Sampler job and therefore never claims physical execution.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unicodedata
from typing import Any

SCHEMA_VERSION = 1
PROVIDER = "IBM_QUANTUM_COMPUTE"
BRIDGE_ID = "NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1"
API_KEY_ENV = "NEXUS_IBM_QUANTUM_API_KEY"
INSTANCE_CRN_ENV = "NEXUS_IBM_QUANTUM_INSTANCE_CRN"
MAX_TRANSPILER_SEED = 2_147_483_647


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    return unicodedata.normalize("NFC", value.strip())


def _required_int(value: Any, label: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ValueError(f"{label} must be integer >= {minimum}")
    return value


def _optional_transpiler_seed(value: Any) -> int | None:
    if value is None:
        return None
    seed = _required_int(value, "transpilerSeed", 0)
    if seed > MAX_TRANSPILER_SEED:
        raise ValueError(f"transpilerSeed must be <= {MAX_TRANSPILER_SEED}")
    return seed


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return format(value, ".17g")
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _json_safe(model_dump())
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _json_safe(to_dict())
    raise TypeError(f"provider value is not JSON-safe:{type(value).__name__}")


def _artifact_json(value: Any) -> str:
    return json.dumps(_json_safe(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _validate_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("preflight request must be object")
    expected = {
        "schemaVersion",
        "provider",
        "backendName",
        "logicalQubitCount",
        "transpilerSeed",
        "logicalCircuitArtifact",
    }
    if set(payload) != expected:
        raise ValueError("unexpected IBM preflight request keys")
    if payload["schemaVersion"] != SCHEMA_VERSION or payload["provider"] != PROVIDER:
        raise ValueError("unsupported IBM preflight schema/provider")
    _required_text(payload["backendName"], "backendName")
    _required_int(payload["logicalQubitCount"], "logicalQubitCount", 1)
    _optional_transpiler_seed(payload["transpilerSeed"])

    artifact = payload["logicalCircuitArtifact"]
    if not isinstance(artifact, dict) or set(artifact) != {
        "format", "qasm3", "qasm3Sha256", "sourceCircuitSha256"
    }:
        raise ValueError("invalid IBM preflight logical circuit artifact")
    if artifact["format"] != "OPENQASM_3":
        raise ValueError("IBM preflight requires OPENQASM_3")
    qasm = _required_text(artifact["qasm3"], "logical QASM3")
    if _sha256_text(qasm) != artifact["qasm3Sha256"]:
        raise ValueError("logical QASM3 digest mismatch")
    for field in ("qasm3Sha256", "sourceCircuitSha256"):
        value = _required_text(artifact[field], field)
        if not value.startswith("sha256:") or len(value) != 71:
            raise ValueError(f"{field} must be sha256 digest")
    return payload


def _backend_is_physical(backend: Any, backend_name: str) -> bool:
    lowered = backend_name.lower()
    if any(token in lowered for token in ("simulator", "fake", "emulator", "statevector")):
        return False
    configuration_fn = getattr(backend, "configuration", None)
    if callable(configuration_fn):
        configuration = configuration_fn()
        if bool(getattr(configuration, "simulator", False)):
            return False
    return True


def _topology_artifact(backend: Any) -> str:
    edges: list[list[int]] = []
    coupling_map = getattr(backend, "coupling_map", None)
    get_edges = getattr(coupling_map, "get_edges", None) if coupling_map is not None else None
    if callable(get_edges):
        edges = sorted([list(map(int, edge)) for edge in get_edges()])
    return _artifact_json({"backend": str(getattr(backend, "name", "")), "edges": edges})


def _capabilities_artifact(backend: Any) -> str:
    target = getattr(backend, "target", None)
    operation_names: list[str] = []
    if target is not None:
        names = getattr(target, "operation_names", None)
        if names is not None:
            operation_names = sorted(str(name) for name in names)
    return _artifact_json({
        "backend": str(getattr(backend, "name", "")),
        "numQubits": int(getattr(backend, "num_qubits", 0) or 0),
        "operationNames": operation_names,
    })


def _transpiler_options(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "optimization_level": 1,
        "seed_transpiler": _optional_transpiler_seed(request["transpilerSeed"]),
    }


def _instruction_names(circuit: Any) -> list[str]:
    names: list[str] = []
    for instruction in getattr(circuit, "data", []):
        operation = getattr(instruction, "operation", None)
        name = getattr(operation, "name", None)
        if name is None and isinstance(instruction, tuple) and instruction:
            name = getattr(instruction[0], "name", None)
        if name is None:
            raise RuntimeError("IBM_PREFLIGHT_TRANSPILED_INSTRUCTION_WITHOUT_NAME")
        names.append(str(name))
    return names


def _two_qubit_gate_count(circuit: Any) -> int:
    count = 0
    for instruction in getattr(circuit, "data", []):
        qubits = getattr(instruction, "qubits", None)
        if qubits is None and isinstance(instruction, tuple) and len(instruction) > 1:
            qubits = instruction[1]
        if qubits is not None and len(qubits) == 2:
            count += 1
    return count


def _readiness(*, operational: bool, status_message: str, capacity_ok: bool, native_ok: bool) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if not operational:
        reasons.append("BACKEND_NOT_OPERATIONAL")
    if status_message.lower() != "active":
        reasons.append("BACKEND_STATUS_NOT_ACTIVE")
    if not capacity_ok:
        reasons.append("LOGICAL_QUBIT_CAPACITY_EXCEEDED")
    if not native_ok:
        reasons.append("TRANSPILED_CIRCUIT_NOT_NATIVE_TO_TARGET")
    return ("READY" if not reasons else "NOT_READY", reasons)


def _execute(request: dict[str, Any]) -> dict[str, Any]:
    api_key = _required_text(os.environ.get(API_KEY_ENV), API_KEY_ENV)
    instance_crn = _required_text(os.environ.get(INSTANCE_CRN_ENV), INSTANCE_CRN_ENV)

    try:
        import qiskit  # type: ignore
        from qiskit import qasm3  # type: ignore
        from qiskit.transpiler import generate_preset_pass_manager  # type: ignore
        import qiskit_ibm_runtime  # type: ignore
        from qiskit_ibm_runtime import IBMQuantumComputeService  # type: ignore
    except Exception as exc:  # pragma: no cover - live provider environment only
        raise RuntimeError("IBM_QPU_PREFLIGHT_DEPENDENCIES_UNAVAILABLE") from exc

    service = IBMQuantumComputeService(
        channel="ibm_quantum_platform",
        token=api_key,
        instance=instance_crn,
    )
    backend = service.backend(request["backendName"])
    backend_name = str(getattr(backend, "name", request["backendName"]))
    if backend_name != request["backendName"]:
        raise RuntimeError("IBM_PREFLIGHT_BACKEND_IDENTITY_MISMATCH")
    if not _backend_is_physical(backend, backend_name):
        raise RuntimeError("IBM_PREFLIGHT_BACKEND_IS_NOT_PHYSICAL_QPU")

    status = backend.status()
    operational = bool(getattr(status, "operational", False))
    pending_jobs = int(getattr(status, "pending_jobs", 0) or 0)
    status_message = str(getattr(status, "status_msg", "") or "")
    backend_qubits = int(getattr(backend, "num_qubits", 0) or 0)
    logical_qubits = request["logicalQubitCount"]
    capacity_ok = backend_qubits >= logical_qubits and backend_qubits > 0

    logical_qasm = request["logicalCircuitArtifact"]["qasm3"]
    circuit = qasm3.loads(logical_qasm)
    if int(circuit.num_qubits) != logical_qubits:
        raise RuntimeError("IBM_PREFLIGHT_LOGICAL_QUBIT_COUNT_MISMATCH")

    pass_manager = generate_preset_pass_manager(backend=backend, **_transpiler_options(request))
    isa_circuit = pass_manager.run(circuit)
    isa_qasm3 = qasm3.dumps(isa_circuit)
    instruction_names = _instruction_names(isa_circuit)
    target = getattr(backend, "target", None)
    target_names = set(str(name) for name in (getattr(target, "operation_names", []) or []))
    native_ok = bool(target_names) and all(name in target_names for name in instruction_names)
    readiness, reasons = _readiness(
        operational=operational,
        status_message=status_message,
        capacity_ok=capacity_ok,
        native_ok=native_ok,
    )

    topology_json = _topology_artifact(backend)
    capabilities_json = _capabilities_artifact(backend)
    transpiled_sha = _sha256_text(isa_qasm3)
    gate_count = int(getattr(isa_circuit, "size")())
    depth = int(getattr(isa_circuit, "depth")())

    return {
        "schemaVersion": SCHEMA_VERSION,
        "bridgeId": BRIDGE_ID,
        "preflight": {
            "provider": PROVIDER,
            "backendDevice": backend_name,
            "physicalQpu": True,
            "operational": operational,
            "statusMessage": status_message,
            "pendingJobs": pending_jobs,
            "logicalQubitCount": logical_qubits,
            "backendQubitCount": backend_qubits,
            "qubitCapacitySufficient": capacity_ok,
            "nativeOperationSetSatisfied": native_ok,
            "transpilerSeed": None if request["transpilerSeed"] is None else str(request["transpilerSeed"]),
            "logicalQasm3Sha256": request["logicalCircuitArtifact"]["qasm3Sha256"],
            "transpiledCircuitSha256": transpiled_sha,
            "topologySha256": _sha256_text(topology_json),
            "capabilitiesSha256": _sha256_text(capabilities_json),
            "resourceEstimate": {
                "gateCount": gate_count,
                "twoQubitGateCount": _two_qubit_gate_count(isa_circuit),
                "depth": depth,
            },
            "providerSdk": "qiskit-ibm-runtime",
            "providerSdkVersion": str(getattr(qiskit_ibm_runtime, "__version__", "unknown")),
            "compiler": "qiskit.generate_preset_pass_manager",
            "compilerVersion": str(getattr(qiskit, "__version__", "unknown")),
            "readiness": readiness,
            "reasons": reasons,
            "submissionAttempted": False,
            "physicalExecutionVerdict": "NOT_TESTED",
        },
        "artifacts": {
            "logicalQasm3": logical_qasm,
            "logicalQasm3Sha256": request["logicalCircuitArtifact"]["qasm3Sha256"],
            "transpiledQasm3": isa_qasm3,
            "transpiledQasm3Sha256": transpiled_sha,
            "topologyJson": topology_json,
            "topologySha256": _sha256_text(topology_json),
            "capabilitiesJson": capabilities_json,
            "capabilitiesSha256": _sha256_text(capabilities_json),
        },
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        request = _validate_request(payload)
        response = _execute(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}:{exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

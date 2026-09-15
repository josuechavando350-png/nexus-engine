#!/usr/bin/env python3
"""Real IBM Quantum Compute bridge for NEXUS Quantum One.

This program is intentionally credential-free in source control. It becomes a live
hardware path only when the caller supplies IBM Quantum credentials in environment
variables and invokes it through the JS adapter. It imports the pinned IBM/Qiskit
SDKs only inside the live execution path so repository verification can syntax-check
this file without installing provider dependencies.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
import sys
import unicodedata
from typing import Any

SCHEMA_VERSION = 1
PROVIDER = "IBM_QUANTUM_COMPUTE"
BRIDGE_ID = "NEXUS_IBM_QUANTUM_QISKIT_BRIDGE_V1"
API_KEY_ENV = "NEXUS_IBM_QUANTUM_API_KEY"
INSTANCE_CRN_ENV = "NEXUS_IBM_QUANTUM_INSTANCE_CRN"


def _canonical(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, str):
        return json.dumps(unicodedata.normalize("NFC", value), separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not value.is_integer():
            raise TypeError("non-integral float cannot enter canonical evidence")
        return str(int(value))
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, tuple):
        return _canonical(list(value))
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = unicodedata.normalize("NFC", str(key))
            if normalized_key in normalized:
                raise TypeError("normalized evidence key collision")
            normalized[normalized_key] = item
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _canonical(normalized[key])
            for key in sorted(normalized)
        ) + "}"
    raise TypeError(f"unsupported canonical evidence type:{type(value).__name__}")


def _artifact_json(value: Any) -> str:
    return _canonical(_json_safe(value))


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        # Provider metrics can contain fractional seconds. Evidence artifacts preserve
        # those exactly as decimal strings instead of introducing binary float hashes.
        return format(value, ".17g")
    if isinstance(value, datetime):
        return _iso(value)
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


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("+00:00"):
        return text[:-6] + "Z"
    return text


def _parse_timestamp(value: str, label: str) -> datetime:
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f"{label} timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def _millis_between(start: str, end: str, label: str) -> int:
    delta = _parse_timestamp(end, label + " end") - _parse_timestamp(start, label + " start")
    milliseconds = int(delta.total_seconds() * 1000)
    if milliseconds < 0:
        raise ValueError(f"{label} cannot be negative")
    return milliseconds


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    return unicodedata.normalize("NFC", value.strip())


def _required_int(value: Any, label: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ValueError(f"{label} must be integer >= {minimum}")
    return value


def _validate_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("bridge request must be object")
    expected = {
        "schemaVersion",
        "provider",
        "adapterId",
        "adapterVersion",
        "backendName",
        "shots",
        "logicalQubitCount",
        "measurementBitOrder",
        "problemBindingSha256",
        "optimizationProblemReportSha256",
        "optimizationModelSha256",
        "circuitSha256",
        "logicalCircuitArtifact",
    }
    if set(payload) != expected:
        raise ValueError("unexpected IBM bridge request keys")
    if payload["schemaVersion"] != SCHEMA_VERSION or payload["provider"] != PROVIDER:
        raise ValueError("unsupported IBM bridge schema/provider")
    artifact = payload["logicalCircuitArtifact"]
    if not isinstance(artifact, dict) or set(artifact) != {
        "format", "compilerId", "compilationSha256", "qasm3", "qasm3Sha256", "sourceCircuitSha256"
    }:
        raise ValueError("invalid logical circuit artifact")
    if artifact["format"] != "OPENQASM_3" or artifact["sourceCircuitSha256"] != payload["circuitSha256"]:
        raise ValueError("logical circuit artifact binding mismatch")
    if _sha256_text(_required_text(artifact["qasm3"], "logical QASM3")) != artifact["qasm3Sha256"]:
        raise ValueError("logical QASM3 digest mismatch")
    _required_text(payload["backendName"], "backendName")
    _required_text(payload["adapterId"], "adapterId")
    _required_text(payload["adapterVersion"], "adapterVersion")
    _required_int(payload["shots"], "shots", 1)
    _required_int(payload["logicalQubitCount"], "logicalQubitCount", 1)
    if payload["measurementBitOrder"] != "QUBIT_0_RIGHTMOST":
        raise ValueError("unsupported measurement bit order")
    for field in (
        "problemBindingSha256", "optimizationProblemReportSha256", "optimizationModelSha256", "circuitSha256"
    ):
        value = _required_text(payload[field], field)
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
    if coupling_map is not None:
        get_edges = getattr(coupling_map, "get_edges", None)
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
    num_qubits = int(getattr(backend, "num_qubits", 0) or 0)
    physical_qubits = int(getattr(backend, "physical_qubits", num_qubits) or num_qubits)
    return _artifact_json({
        "backend": str(getattr(backend, "name", "")),
        "numQubits": num_qubits,
        "physicalQubits": physical_qubits,
        "operationNames": operation_names,
    })


def _calibration_artifact(job: Any) -> tuple[dict[str, Any], str | None]:
    properties_fn = getattr(job, "properties", None)
    properties = properties_fn() if callable(properties_fn) else None
    if properties is None:
        return {
            "status": "PROVIDER_NOT_EXPOSED",
            "calibrationId": None,
            "capturedAt": None,
            "providerReportedAt": None,
            "metadataSha256": None,
        }, None
    properties_dict = _json_safe(properties)
    artifact = _artifact_json(properties_dict)
    digest = _sha256_text(artifact)
    last_update = None
    if isinstance(properties_dict, dict):
        last_update = properties_dict.get("last_update_date")
    timestamp = _iso(last_update)
    if timestamp is None:
        return {
            "status": "PROVIDER_NOT_EXPOSED",
            "calibrationId": None,
            "capturedAt": None,
            "providerReportedAt": None,
            "metadataSha256": None,
        }, artifact
    return {
        "status": "CAPTURED",
        "calibrationId": "ibm-properties-" + digest.removeprefix("sha256:")[:24],
        "capturedAt": timestamp,
        "providerReportedAt": timestamp,
        "metadataSha256": digest,
    }, artifact


def _extract_counts(pub_result: Any, expected_shots: int, logical_qubits: int) -> dict[str, int]:
    data = getattr(pub_result, "data", None)
    if data is None:
        raise ValueError("IBM Sampler result missing data bin")
    candidate = getattr(data, "c", None)
    if candidate is None:
        for name in dir(data):
            if name.startswith("_"):
                continue
            try:
                value = getattr(data, name)
            except Exception:
                continue
            if callable(getattr(value, "get_counts", None)):
                if candidate is not None:
                    raise ValueError("IBM Sampler result has ambiguous classical registers")
                candidate = value
    get_counts = getattr(candidate, "get_counts", None)
    if not callable(get_counts):
        raise ValueError("IBM Sampler result has no count-bearing classical register")
    raw_counts = get_counts()
    if not isinstance(raw_counts, dict):
        raw_counts = dict(raw_counts)
    counts: dict[str, int] = {}
    for bitstring, count in raw_counts.items():
        bits = str(bitstring).replace(" ", "")
        if len(bits) != logical_qubits or any(bit not in "01" for bit in bits):
            raise ValueError(f"IBM Sampler returned invalid bitstring:{bits}")
        normalized_count = int(count)
        if normalized_count < 1:
            raise ValueError("IBM Sampler returned non-positive measurement count")
        counts[bits] = counts.get(bits, 0) + normalized_count
    if sum(counts.values()) != expected_shots:
        raise ValueError("IBM Sampler counts do not equal requested shots")
    return dict(sorted(counts.items()))


def _execute(request: dict[str, Any]) -> dict[str, Any]:
    api_key = _required_text(os.environ.get(API_KEY_ENV), API_KEY_ENV)
    instance_crn = _required_text(os.environ.get(INSTANCE_CRN_ENV), INSTANCE_CRN_ENV)

    try:
        import qiskit  # type: ignore
        from qiskit import qasm3  # type: ignore
        from qiskit.transpiler import generate_preset_pass_manager  # type: ignore
        import qiskit_ibm_runtime  # type: ignore
        from qiskit_ibm_runtime import IBMQuantumComputeService, SamplerV2  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised only in configured provider environment
        raise RuntimeError("IBM_QPU_BRIDGE_DEPENDENCIES_UNAVAILABLE") from exc

    service = IBMQuantumComputeService(
        channel="ibm_quantum_platform",
        token=api_key,
        instance=instance_crn,
    )
    backend = service.backend(request["backendName"])
    backend_name = str(getattr(backend, "name", request["backendName"]))
    if backend_name != request["backendName"]:
        raise RuntimeError("IBM_BACKEND_IDENTITY_MISMATCH")
    if not _backend_is_physical(backend, backend_name):
        raise RuntimeError("IBM_BACKEND_IS_NOT_PHYSICAL_QPU")

    logical_qasm = request["logicalCircuitArtifact"]["qasm3"]
    circuit = qasm3.loads(logical_qasm)
    if int(circuit.num_qubits) != request["logicalQubitCount"]:
        raise RuntimeError("IBM_LOGICAL_QUBIT_COUNT_MISMATCH")

    pass_manager = generate_preset_pass_manager(backend=backend, optimization_level=1)
    isa_circuit = pass_manager.run(circuit)
    isa_qasm3 = qasm3.dumps(isa_circuit)
    transpiled_circuit_sha256 = _sha256_text(isa_qasm3)

    topology_json = _topology_artifact(backend)
    capabilities_json = _capabilities_artifact(backend)

    sampler = SamplerV2(mode=backend)
    job = sampler.run([isa_circuit], shots=request["shots"])
    job_id = _required_text(job.job_id(), "IBM job ID")
    result = job.result()
    if job.errored():
        raise RuntimeError("IBM_QPU_JOB_ERRORED_AFTER_RESULT")
    if not job.done():
        raise RuntimeError("IBM_QPU_JOB_NOT_DONE_AFTER_RESULT")

    counts = _extract_counts(result[0], request["shots"], request["logicalQubitCount"])
    metrics = _json_safe(job.metrics())
    if not isinstance(metrics, dict) or not isinstance(metrics.get("timestamps"), dict):
        raise RuntimeError("IBM_QPU_JOB_METRICS_MISSING_TIMESTAMPS")
    timestamp_map = metrics["timestamps"]
    submitted_at = _iso(timestamp_map.get("created"))
    started_at = _iso(timestamp_map.get("running"))
    completed_at = _iso(timestamp_map.get("finished"))
    if not submitted_at or not started_at or not completed_at:
        raise RuntimeError("IBM_QPU_PROVIDER_TIMESTAMPS_INCOMPLETE")

    calibration_evidence, calibration_json = _calibration_artifact(job)
    if calibration_evidence["status"] == "PROVIDER_NOT_EXPOSED":
        calibration_evidence["providerReportedAt"] = completed_at

    raw_result_json = _artifact_json({
        "provider": PROVIDER,
        "backend": backend_name,
        "jobId": job_id,
        "shots": request["shots"],
        "counts": counts,
        "pubMetadata": _json_safe(getattr(result[0], "metadata", {})),
    })
    raw_result_sha256 = _sha256_text(raw_result_json)
    metrics_json = _artifact_json(metrics)
    provider_receipt_json = _artifact_json({
        "provider": PROVIDER,
        "backend": backend_name,
        "jobId": job_id,
        "status": "SUCCEEDED",
        "metrics": metrics,
        "rawResultSha256": raw_result_sha256,
        "transpiledCircuitSha256": transpiled_circuit_sha256,
    })
    provider_receipt_sha256 = _sha256_text(provider_receipt_json)

    evidence = {
        "provider": PROVIDER,
        "backendDevice": backend_name,
        "jobId": job_id,
        "status": "SUCCEEDED",
        "timestamps": {
            "submittedAt": submitted_at,
            "startedAt": started_at,
            "completedAt": completed_at,
        },
        "timing": {
            "queueTimeMillis": _millis_between(submitted_at, started_at, "IBM queue time"),
            "executionTimeMillis": _millis_between(started_at, completed_at, "IBM execution time"),
            "providerReportedTotalMillis": _millis_between(submitted_at, completed_at, "IBM provider total time"),
        },
        "shotsRequested": request["shots"],
        "shotsCompleted": sum(counts.values()),
        "problemBindingSha256": request["problemBindingSha256"],
        "optimizationProblemReportSha256": request["optimizationProblemReportSha256"],
        "optimizationModelSha256": request["optimizationModelSha256"],
        "circuitSha256": request["circuitSha256"],
        "transpilationApplied": True,
        "transpiledCircuitSha256": transpiled_circuit_sha256,
        "calibrationEvidence": calibration_evidence,
        "rawResultSha256": raw_result_sha256,
        "measurementCounts": counts,
        "hardwareIdentity": {
            "manufacturer": "IBM",
            "deviceId": backend_name,
            "deviceType": "QPU",
            "topologySha256": _sha256_text(topology_json),
            "capabilitiesSha256": _sha256_text(capabilities_json),
        },
        "providerReceiptSha256": provider_receipt_sha256,
        "reproducibilityMetadata": {
            "adapterId": request["adapterId"],
            "adapterVersion": request["adapterVersion"],
            "providerSdk": "qiskit-ibm-runtime",
            "providerSdkVersion": str(qiskit_ibm_runtime.__version__),
            "compiler": "qiskit.generate_preset_pass_manager",
            "compilerVersion": str(qiskit.__version__),
            "seed": None,
        },
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "bridgeId": BRIDGE_ID,
        "evidence": evidence,
        "artifacts": {
            "logicalQasm3": logical_qasm,
            "logicalQasm3Sha256": request["logicalCircuitArtifact"]["qasm3Sha256"],
            "transpiledQasm3": isa_qasm3,
            "transpiledQasm3Sha256": transpiled_circuit_sha256,
            "rawResultJson": raw_result_json,
            "rawResultSha256": raw_result_sha256,
            "providerReceiptJson": provider_receipt_json,
            "providerReceiptSha256": provider_receipt_sha256,
            "metricsJson": metrics_json,
            "topologyJson": topology_json,
            "topologySha256": _sha256_text(topology_json),
            "capabilitiesJson": capabilities_json,
            "capabilitiesSha256": _sha256_text(capabilities_json),
            "calibrationJson": calibration_json,
            "calibrationSha256": _sha256_text(calibration_json) if calibration_json is not None else None,
        },
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        request = _validate_request(payload)
        response = _execute(request)
        sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
        return 0
    except Exception as exc:
        # Never echo credentials, provider payloads, or arbitrary exception reprs.
        sys.stderr.write(f"IBM_QPU_BRIDGE_ERROR:{type(exc).__name__}:{str(exc)[:160]}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

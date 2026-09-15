from __future__ import annotations

import hashlib
import importlib.util
import inspect
from pathlib import Path
import unittest


PREFLIGHT_PATH = Path(__file__).resolve().parents[1] / "quantum-runtime" / "providers" / "ibm" / "ibm-qpu-preflight.py"
SPEC = importlib.util.spec_from_file_location("nexus_ibm_qpu_preflight", PREFLIGHT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load IBM QPU preflight module")
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def request(seed: int | None = 1337) -> dict[str, object]:
    qasm = "OPENQASM 3.0;\nqubit[1] q;\nbit[1] c;\nc[0] = measure q[0];"
    return {
        "schemaVersion": 1,
        "provider": "IBM_QUANTUM_COMPUTE",
        "backendName": "ibm_contract_qpu",
        "logicalQubitCount": 1,
        "transpilerSeed": seed,
        "logicalCircuitArtifact": {
            "format": "OPENQASM_3",
            "qasm3": qasm,
            "qasm3Sha256": sha256_text(qasm),
            "sourceCircuitSha256": sha256_text("source-circuit"),
        },
    }


class IbmQpuPreflightContractTest(unittest.TestCase):
    def test_exact_request_contract_and_seed_are_validated(self) -> None:
        checked = PREFLIGHT._validate_request(request(1337))
        self.assertEqual(checked["transpilerSeed"], 1337)
        self.assertEqual(
            PREFLIGHT._transpiler_options(checked),
            {"optimization_level": 1, "seed_transpiler": 1337},
        )

    def test_logical_qasm_digest_drift_fails_closed(self) -> None:
        payload = request()
        payload["logicalCircuitArtifact"]["qasm3"] += "\n"
        with self.assertRaisesRegex(ValueError, "logical QASM3 digest mismatch"):
            PREFLIGHT._validate_request(payload)

    def test_ready_requires_active_operational_capacity_and_native_target(self) -> None:
        verdict, reasons = PREFLIGHT._readiness(
            operational=True,
            status_message="active",
            capacity_ok=True,
            native_ok=True,
        )
        self.assertEqual(verdict, "READY")
        self.assertEqual(reasons, [])

        verdict, reasons = PREFLIGHT._readiness(
            operational=True,
            status_message="internal",
            capacity_ok=True,
            native_ok=True,
        )
        self.assertEqual(verdict, "NOT_READY")
        self.assertIn("BACKEND_STATUS_NOT_ACTIVE", reasons)

    def test_capacity_and_native_failures_are_preserved(self) -> None:
        verdict, reasons = PREFLIGHT._readiness(
            operational=False,
            status_message="offline",
            capacity_ok=False,
            native_ok=False,
        )
        self.assertEqual(verdict, "NOT_READY")
        self.assertEqual(
            reasons,
            [
                "BACKEND_NOT_OPERATIONAL",
                "BACKEND_STATUS_NOT_ACTIVE",
                "LOGICAL_QUBIT_CAPACITY_EXCEEDED",
                "TRANSPILED_CIRCUIT_NOT_NATIVE_TO_TARGET",
            ],
        )

    def test_live_preflight_source_contains_no_sampler_submission_path(self) -> None:
        source = inspect.getsource(PREFLIGHT._execute)
        self.assertNotIn("SamplerV2", source)
        self.assertNotIn("sampler.run", source)
        self.assertNotIn("job.result", source)
        self.assertIn("backend.status()", source)
        self.assertIn("generate_preset_pass_manager", source)

    def test_simulator_like_backend_names_fail_physical_identity(self) -> None:
        class Backend:
            pass

        backend = Backend()
        self.assertFalse(PREFLIGHT._backend_is_physical(backend, "fake_backend"))
        self.assertFalse(PREFLIGHT._backend_is_physical(backend, "statevector_qpu"))
        self.assertTrue(PREFLIGHT._backend_is_physical(backend, "ibm_contract_qpu"))


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import hashlib
import importlib.util
import inspect
from pathlib import Path
import unittest


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "quantum-runtime" / "providers" / "ibm" / "ibm-qpu-bridge.py"
SPEC = importlib.util.spec_from_file_location("nexus_ibm_qpu_bridge_seed_contract", BRIDGE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load IBM QPU bridge contract module")
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def bridge_request(seed: int | None) -> dict[str, object]:
    qasm = "OPENQASM 3.0;\nqubit[1] q;\nbit[1] c;\nc[0] = measure q[0];\n"
    circuit_sha = sha256_text("seed-contract-circuit")
    return {
        "schemaVersion": 1,
        "provider": "IBM_QUANTUM_COMPUTE",
        "adapterId": "NEXUS_IBM_QUANTUM_COMPUTE_QPU_ADAPTER_V1",
        "adapterVersion": "1.0.0",
        "backendName": "ibm_seed_contract_qpu",
        "shots": 100,
        "logicalQubitCount": 1,
        "measurementBitOrder": "QUBIT_0_RIGHTMOST",
        "problemBindingSha256": sha256_text("problem-binding"),
        "optimizationProblemReportSha256": sha256_text("optimization-report"),
        "optimizationModelSha256": sha256_text("optimization-model"),
        "circuitSha256": circuit_sha,
        "transpilerSeed": seed,
        "logicalCircuitArtifact": {
            "format": "OPENQASM_3",
            "compilerId": "NEXUS_QAOA_OPENQASM3_COMPILER_V1",
            "compilationSha256": sha256_text("compilation"),
            "qasm3": qasm,
            "qasm3Sha256": sha256_text(qasm),
            "sourceCircuitSha256": circuit_sha,
        },
    }


class IbmSeededTranspilationContractTest(unittest.TestCase):
    def test_explicit_seed_is_validated_and_forwarded_to_qiskit_options(self) -> None:
        request = BRIDGE._validate_request(bridge_request(1337))
        self.assertEqual(request["transpilerSeed"], 1337)
        self.assertEqual(
            BRIDGE._transpiler_options(request),
            {"optimization_level": 1, "seed_transpiler": 1337},
        )

    def test_unseeded_mode_remains_explicitly_null(self) -> None:
        request = BRIDGE._validate_request(bridge_request(None))
        self.assertIsNone(request["transpilerSeed"])
        self.assertEqual(
            BRIDGE._transpiler_options(request),
            {"optimization_level": 1, "seed_transpiler": None},
        )

    def test_invalid_seed_values_fail_closed(self) -> None:
        for invalid in (-1, BRIDGE.MAX_TRANSPILER_SEED + 1, True, "1337"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    BRIDGE._validate_request(bridge_request(invalid))

    def test_seed_field_is_required_by_exact_bridge_request_contract(self) -> None:
        request = bridge_request(1337)
        del request["transpilerSeed"]
        with self.assertRaisesRegex(ValueError, "unexpected IBM bridge request keys"):
            BRIDGE._validate_request(request)

    def test_live_execute_path_consumes_validated_transpiler_options(self) -> None:
        source = inspect.getsource(BRIDGE._execute)
        self.assertIn("generate_preset_pass_manager(backend=backend, **_transpiler_options(request))", source)
        self.assertIn('"seed": seed_text', source)
        self.assertIn('"transpilerSeed": seed_text', source)


if __name__ == "__main__":
    unittest.main()

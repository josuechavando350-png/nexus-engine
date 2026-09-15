# IBM Seeded Transpilation V1

This phase closes the reproducibility gap identified by the Physical QPU Run Operator without claiming that physical IBM hardware has been executed.

## Contract

The IBM adapter now carries an explicit nullable `transpilerSeed` from the JavaScript adapter request into the Python bridge. When a seed is configured it must be a safe integer in the inclusive range `0..2147483647`.

The bridge validates that field before provider SDK imports, forwards it to Qiskit's preset pass manager as `seed_transpiler`, and records the exact decimal seed string in `ExecutionReceipt.reproducibilityMetadata.seed` through the provider evidence returned to the physical backend.

The seed is also bound into the provider-receipt artifact and the filesystem evidence manifest. The JavaScript adapter rejects provider evidence when the returned seed does not exactly match the requested seed.

## Compatibility and fail-closed behavior

`transpilerSeed: null` remains a supported preparation/runtime compatibility mode. It does not satisfy the Physical QPU Run Operator's seeded reproducibility control and therefore cannot by itself promote a repeated physical series to operator `PASS`.

Supplying a non-null seed without the rest of the IBM physical provider configuration does not create a hardware path. The adapter still requires the API key, service-instance CRN, named backend, and evidence sink before a provider executor exists.

Invalid, missing, or drifting seed evidence fails closed at the bridge or adapter boundary. No verifier, WALLE gate, execution receipt validator, or skip detector is relaxed by this phase.

## Physical hardware boundary

This code makes seeded physical execution possible; it does not prove that one occurred.

Physical IBM status remains `NOT_TESTED` until an authorized account supplies all of the following and a real job is actually submitted and retained as evidence:

- IBM Quantum API credentials and service-instance CRN;
- an explicitly named accessible physical QPU backend;
- a configured non-null transpiler seed;
- real provider job ID and timestamps;
- completed shot counts and raw result digest;
- ISA-transpiled circuit artifact and digest;
- topology/capability evidence and calibration evidence when exposed;
- provider receipt and immutable evidence bundle.

Even after controlled physical runs pass, `quantumAdvantageClaimAllowed` remains false unless a separate fair comparison protocol establishes such a claim with evidence.

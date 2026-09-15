# Provider transpilation evidence V1

Physical QPU providers do not all expose the final transpiled circuit bytes after a job is submitted. The execution contract must distinguish three facts without inventing evidence:

- `transpilationApplied=false` and `transpiledCircuitSha256=null`: no provider-side transpilation is claimed.
- `transpilationApplied=true` with a `transpiledCircuitSha256`: transpilation occurred and the exact resulting circuit bytes were captured and hashed.
- `transpilationApplied=true` and `transpiledCircuitSha256=null`: transpilation occurred, but the provider did not expose retrievable transpiled-circuit bytes. This is valid evidence, but it is incomplete and must remain `INCONCLUSIVE` with `TRANSPILED_CIRCUIT_NOT_CAPTURED`.

A non-null `transpiledCircuitSha256` while `transpilationApplied=false` is contradictory and fails closed.

This distinction is required for provider integrations whose current APIs execute or compile circuits internally but do not return the final transpiled circuit artifact. The runtime must preserve that absence rather than fabricating a hash, pretending that no transpilation occurred, or promoting the run to PASS.

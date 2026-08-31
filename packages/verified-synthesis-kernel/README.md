# @nexus/verified-synthesis-kernel

Motor #6 is NEXUS's bounded verified-synthesis layer. It does not grant an AI model mutation authority and it does not store chain-of-thought. It accepts a typed integer IR, searches for bounded parameter assignments, validates every candidate against recomputable constraints, optionally asks configured runtime/browser counterexample oracles for concrete failures, and returns proof-carrying structural evidence.

## Core flow

`problem -> equality saturation -> solver -> candidate -> deterministic verification -> runtime/browser counterexamples -> CEGIS refinement -> proof`

The built-in solver is a deterministic bounded enumerator. `ExternalSmtLibSolver` is a shell-free adapter for real SMT or SyGuS tools such as Z3 or cvc5. If a requested tool is absent, the result is `UNAVAILABLE`; candidate-budget exhaustion is `NOT_VERIFIED`; solver timeout is `TIMEOUT`. No missing external toolchain is upgraded to a pass.

`CommandCounterexampleOracle` can connect a trusted executable harness to either the `RUNTIME` or `BROWSER` evidence boundary. The harness receives a bounded JSON request on stdin and must return strict JSON. Invalid, oversized, timed-out, cancelled, or unavailable harness execution fails closed.

The proof object is structurally recomputable: it binds the exact problem, normalized constraints, accepted counterexamples, candidate, deterministic evaluations, iteration records, and oracle evidence digests. This is proof-carrying output, not a claim that an unavailable external prover was executed.

## Authority boundary

Motor #6 never gives Claude, OpenAI, or another model direct state-write authority. Advisory models may propose structured inputs upstream, but the governed NEXUS executor remains the single writer. A solver or oracle only returns evidence/counterexamples; neither can mutate GitHub, the semantic graph, deployments, approvals, commerce state, or other governed state through this package.

## CLI

`nexus-verified-synthesis problem.json`

Optional operator-selected adapters:

- `--solver=internal`
- `--solver=z3`
- `--solver=cvc5-smt`
- `--solver=cvc5-sygus`
- `--runtime-oracle=/trusted/executable`
- `--browser-oracle=/trusted/executable`

The CLI bounds the input file to 2 MiB, rejects non-regular files, detects in-place changes while reading, and supports SIGINT/SIGTERM cancellation.

# Motor #6 capability audit

Implemented surface:

- typed bounded integer synthesis IR with strict unknown-field rejection
- bounded equality saturation with only semantics-preserving rewrite rules
- deterministic internal bounded solver
- shell-free SMT-LIB adapter and SyGuS adapter with bounded stdin/stdout and honest `UNAVAILABLE`/`TIMEOUT`/`UNKNOWN` states
- CEGIS loop that incorporates runtime/browser counterexamples only as bounded validated constraints
- shell-free runtime/browser command oracles with scope/problem/candidate binding
- proof-carrying output with recomputable SHA-256 linkage
- cancellation, candidate/iteration/counterexample/e-graph/tool-output budgets
- production runtime and CLI consumer

Threats explicitly covered by tests or validation:

- fake UNSAT on search-budget exhaustion
- absent solver/oracle promoted to success
- proof/candidate/counterexample tampering
- unknown-field smuggling
- unbounded variable domains
- counterexample identifier replay/collision
- duplicate oracle authority
- candidate outside declared bounds
- solver candidates that do not satisfy recomputed constraints
- oracle response smuggling and malformed output
- post-dispatch tool timeout/cancellation

External limitations are represented honestly. This package does not claim Lean, zkVM, Z3, cvc5, browser, or runtime evidence unless the corresponding real configured tool actually runs. Lean/ZK are deliberately not simulated or represented as verified when their real toolchains are absent.

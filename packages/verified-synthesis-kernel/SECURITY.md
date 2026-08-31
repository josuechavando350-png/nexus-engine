# Security boundary

The verified synthesis kernel is a computation/evidence component, not a mutation authority. Solvers and counterexample oracles receive bounded problem/candidate data and cannot write NEXUS state through this package.

External solver/oracle execution is shell-free, output-bounded, timeout-bounded, cancellable, and fail-closed. Tool absence is `UNAVAILABLE`; malformed output is `ERROR`; solver search exhaustion under a configured candidate budget is `NOT_VERIFIED`, never `UNSAT`.

All accepted counterexamples are revalidated against the original typed IR variable set and are bound into the final proof digest. Proof verification recomputes the exact normalized constraint set and candidate evaluations.

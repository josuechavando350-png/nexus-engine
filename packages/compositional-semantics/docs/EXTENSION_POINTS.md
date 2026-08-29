# Extension points

Stable boundaries for Motor 3:

1. `SemanticState` is the input evidence surface.
2. `SemanticFormula` is a safe, closed AST; extend it by adding explicit operators and tests, never by evaluating source strings.
3. `SemanticContract` owns requires/ensures/invariants.
4. `SemanticEffect` is the only state mutation surface.
5. `SemanticComposition` models step/sequence/parallel/nest.
6. `VerificationResult` and `SemanticVerificationCertificate` are evidence surfaces for Motor 4.
7. Adapters from Visual Algebra and Topology point upward; Motors 1–2 do not depend on Motor 3.
8. Motor 4 may consume certificates but must not mutate or reinterpret Motor 3 results.
9. Motor 5 may consume semantic metrics/facts through an adapter; Motor 3 must not depend on originality.
10. Deterministic encoding, stable IDs and finite numeric state are compatibility requirements.

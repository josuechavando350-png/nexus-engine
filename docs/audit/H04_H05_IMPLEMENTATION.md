# H-04 / H-05 implementation target

This branch closes two audit findings on the current `main` baseline.

- H-04: authorized ontology mutation and its ALLOW audit record must be one recoverable unit. The in-memory adapter must roll back both sides when audit persistence fails after mutation staging, and a retry must yield exactly one committed mutation and one ALLOW record.
- H-05: idempotency keys are scoped by ontology scope, principal, action and request id, and replay is bound to a canonical request fingerprint. A payload mismatch fails closed.

No fallback to a non-atomic success path is permitted.

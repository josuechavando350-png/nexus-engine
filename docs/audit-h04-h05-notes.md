# H-04 / H-05 repair invariants

This branch is intentionally fail-closed while the action mutation/audit boundary is hardened.

## H-04 atomic mutation + audit

A successful action must never expose a committed ontology mutation without its corresponding ALLOW audit record. The repair must provide rollback or a single atomic commit boundary, include failure injection between mutation staging and audit persistence, and prove retry does not duplicate mutation or audit evidence.

## H-05 scoped idempotency

`requestId` alone is not a global idempotency key. Action replay identity is scoped by ontology scope, principal and action, and is bound to a canonical request fingerprint. Reusing the same scoped key with a different payload fails closed instead of returning an unrelated prior result.

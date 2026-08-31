# Capability #26 — NEXUS Ventaja Agentic Commerce / Cierre

Capability #26 extends the canonical `@nexus/control-sdk` control-plane architecture instead of creating a parallel transaction authority.

The governed commerce boundary is tenant-scoped, approval-gated, idempotent, audited, and replay-safe. Preparing an action does not execute it. A human approval is bound to the exact scoped action digest and expires fail-closed. Execution is performed only through an injected `CommerceExecutor`; no provider execution is fabricated by the SDK.

If the executor is absent or unavailable, the transaction records `UNAVAILABLE` and no external action is attempted. If transport, timeout, or cancellation fails after execution has begun, the transaction records `OUTCOME_UNKNOWN` and automatic replay is blocked because the external side effect may already have occurred. This deliberately prefers reconciliation over duplicate orders or charges.

The `GovernedCommerceRuntime` is the operational consumer. It routes prepare -> approval/denial -> execute through the same `GovernedCommerceEngine`; providers and callers cannot mutate transaction state directly.

The capability does not claim payment settlement, inventory reservation, merchant acceptance, business outcome, or external provider success unless a real configured executor returns that result.

# NEXUS Generative Presence

Capability #25 extends the existing `@nexus/generative-readiness` package instead of creating a second GEO/AEO engine.

The scoped presence report binds canonical page readiness evidence to tenant, organization, and brand scope. It deliberately reports external provider visibility as `NOT_VERIFIED` or `UNAVAILABLE` unless a later governed provider boundary supplies real, independently validated observation evidence.

A readiness score is not evidence of visibility, citation, ranking, traffic, or inclusion in any provider answer. No provider result is fabricated by this package.

Operational consumer: `nexus-generative-presence <request.json>` accepts a bounded JSON request, validates strict top-level fields and scope, supports operator cancellation, and emits replay-verifiable scoped readiness evidence.

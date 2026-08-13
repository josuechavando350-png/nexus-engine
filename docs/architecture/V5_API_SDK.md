# V5 API / SDK

`nexus-api-contracts` is transport-neutral and versioned (`v1`). HTTP/JSON and gRPC are adapters to benchmark later. Mutating requests carry a request ID and optional idempotency key. Updates use expected versions for optimistic concurrency.

`nexus-sdk` injects a Transport; `@nexus/control-sdk` mirrors the minimal public resource vocabulary for TypeScript. No SDK owns authorization logic.

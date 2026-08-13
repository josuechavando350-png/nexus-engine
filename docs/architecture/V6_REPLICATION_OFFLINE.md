# V6 Replication and Offline Operation

`nexus-replication` models immutable replicated operations using stream sequence, content hash and idempotency key. Gaps are surfaced instead of silently accepted.

`nexus-offline` provides an edge journal. Offline operation is permitted only within the capability/policy envelope already issued to the edge workload. Reconnection performs explicit reconciliation.

Conflict policy must be domain specific. V6 does not apply an arbitrary universal last-write-wins rule to safety or authority data.

Replay and reconciliation must not create duplicate physical effects. Physical effect identity remains inherited from V4 durable execution and V3 signed task semantics.

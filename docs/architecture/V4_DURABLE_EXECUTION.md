# V4 Durable Execution
Checkpoint and replay semantics belong to NEXUS. `DurableStore` is replaceable. Checkpoints are monotonic and carry committed effect IDs so recovery can detect already-committed side effects. Replay modes are simulation/audit only and cannot physically dispatch.

# V6 Cluster and Consensus

`nexus-cluster` owns membership semantics; `nexus-consensus` owns a minimal replicated-decision contract. Neither owns a specific Raft implementation.

Candidate adapter: OpenRaft. Candidate external coordination store: etcd. They must be benchmarked on NEXUS operations before promotion.

Required semantics:
- monotonic membership epochs;
- tombstones prevent accidental stale-node resurrection;
- explicit voter/quorum evidence;
- separate linearizable, lease and stale-allowed read intent;
- snapshots/log compaction belong to adapter/storage implementation, not callers;
- membership transitions are auditable.

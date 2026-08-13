# V6 Placement and Discovery

Placement is constraint-first. A candidate failing role, capacity, region or labels is not scoreable. Ranking never converts an invalid node into a valid one.

Kubernetes is a deployment/orchestration adapter candidate, not NEXUS's placement model. NEXUS needs placement semantics that can also work on VMs, bare metal and constrained edge.

Service discovery uses leased, health-filtered endpoints behind the `Discovery` trait. etcd, Consul, Kubernetes DNS/API and DNS-based discovery can be compared without changing callers.

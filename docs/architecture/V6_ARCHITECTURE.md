# NEXUS V6 — Distributed Runtime

V6 distributes NEXUS from cloud to private servers, factories and edge nodes without allowing distribution mechanics to bypass V3 safety, V4 cognitive semantics, or V5 authorization.

## Planes

- **Cluster plane:** membership, epochs, health, draining, capacity.
- **Consensus plane:** replicated decisions with explicit consistency classes.
- **Replication plane:** immutable operations, watermarks, anti-entropy and gap detection.
- **Placement plane:** hard constraints first, deterministic ranking second.
- **Discovery plane:** leased healthy endpoints behind a provider-neutral trait.
- **Federation plane:** explicit grants between trust domains; no implicit transitive trust.
- **Offline plane:** append-only edge journal and explicit reconciliation.
- **Secure mesh plane:** workload identity and peer authorization; WireGuard/SPIFFE/QUIC are mechanisms, not NEXUS domain semantics.
- **Fleet/update plane:** enrollment lifecycle, rollout rings, health thresholds, signature/provenance/SBOM checks and rollback protection.
- **Distribution composition:** placement requires prior policy evidence and artifact digest; distribution cannot create a physical execution bypass.

## Core invariant

A scheduler may decide **where** approved work runs. It may never decide **whether** a prohibited or unapproved physical action becomes permitted.

## Failure domains

Region, zone and node are separate failure-domain labels. Placement should remain deterministic for the same cluster view; failover is explicit and observable, not hidden retry magic.

## Eventual vs strong consistency

NEXUS must not pretend every datum needs consensus. Strong consistency is reserved for coordination facts whose split-brain semantics would be dangerous: membership changes, leases/leadership, durable ownership, update rollout transitions and other control decisions. Telemetry and replayable observations remain stream/replication problems.

# NEXUS V5 — Control Plane Architecture

V5 turns the V1–V4 engines into an operable multi-tenant platform. The control plane owns **resource lifecycle and authorization**, not industrial execution semantics.

Mutation path: `authenticate → tenant boundary → authorize → validate/version → mutate registry → append audit`.

V5 resources: organizations, users/principals, agents, datasets, graphs, models, versions, workflows, simulations, edge devices, policies, alerts, secret references, usage/cost records and audit records.

The control plane never creates a second physical-dispatch path. `Execute`/`Approve` are control commands that must delegate to the existing V4/V3 execution chain.

## Own IP
- versioned control-resource model shared across heterogeneous NEXUS planes;
- capability/action semantics that survive authorization-engine replacement;
- tenant boundary invariant independent from provider;
- optimistic concurrency contract for administrative mutations;
- audit/provenance linking control decisions to runtime evidence;
- SecretRef/lease semantics preventing control APIs from becoming secret exfiltration surfaces.

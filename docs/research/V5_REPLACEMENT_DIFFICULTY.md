# V5 Replacement Difficulty Ledger

| Component | Commodity alternative | NEXUS-owned semantics that must be rebuilt |
|---|---|---|
| Resource model | CRUD framework | one typed lifecycle spanning agents, data, graph, models, workflows, simulation, edge, policy and evidence |
| Authorization | OpenFGA/Cedar/OPA | NEXUS action vocabulary, tenant invariant, execution/approval semantics and linkage to V3/V4 safety |
| Registry | SQL CRUD | optimistic versioning and typed cross-plane resource references |
| Secrets | Vault/cloud manager | provider-neutral SecretRef + purpose/TTL lease contract and audit linkage |
| API/SDK | REST/gRPC framework | transport-neutral versioned control commands, idempotency/concurrency semantics |
| Audit | log stack | actor→decision→resource→runtime evidence provenance chain |
| Cost | billing service | usage provenance tied to model/agent/runtime operations rather than invoice-only accounting |

Question: could five OSS projects reproduce V5 in a weekend? They can supply transports, stores, FGA and secrets. They do not supply the NEXUS cross-plane resource semantics, execution-safety linkage, evidence model, replacement boundaries or one coherent lifecycle across V1–V4 assets.

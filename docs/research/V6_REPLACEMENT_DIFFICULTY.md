# V6 Replacement Difficulty Ledger

The value of V6 is not OpenRaft, Kubernetes, SPIFFE, WireGuard, QUIC, TUF, Sigstore, etcd or Consul. Those are replaceable building blocks.

| Component | Commodity candidates | NEXUS-owned IP/semantics | Why installing OSS is insufficient |
|---|---|---|---|
| cluster | etcd/OpenRaft/K8s | membership epochs, stale-node tombstones, NEXUS node roles/failure domains | OSS does not define NEXUS lifecycle or safety interaction |
| replication | broker/storage systems | operation identity, watermarks, explicit gap detection, reconciliation hooks | generic replication cannot infer NEXUS effect/provenance rules |
| placement | Kubernetes/Nomad-style schedulers | cross cloud/private/edge constraint model tied to policy evidence | a scheduler alone does not understand NEXUS authority/evidence |
| federation | SPIFFE/mTLS/service mesh | expiring trust-domain grants and non-transitive authority semantics | connectivity/identity does not define authorization semantics |
| offline | local DB/queue | ordered journal, reconciliation boundary and no duplicate physical effect invariant | generic offline queues do not know NEXUS side-effect identity |
| mesh | WireGuard/QUIC/TLS | identity + peer authorization + NEXUS trust boundaries | encryption alone is not authorization |
| fleet | device managers | lifecycle, quarantine/drain, rollout rings, health gates | generic fleet APIs do not define NEXUS operational invariants |
| updates | TUF/Sigstore | artifact+SBOM+provenance manifest, rollout state, rollback floor | signing a file is not safe fleet rollout |
| composition | all above | V3 safety + V4 cognition + V5 authorization + V6 distribution evidence chain | OSS components do not provide the integrated semantics |

## Required question
What did V6 build that a competent team cannot reproduce by wiring five open-source projects together in a weekend?

Answer target: the hard part is the cross-layer semantics — authority remains separate from placement, simulated/inferred state remains separate from observation, offline replay cannot duplicate physical effects, federation cannot amplify permissions, updates require provenance and anti-rollback, and every distributed decision must remain traceable to NEXUS policy/evidence. That integration must be proven by tests and fault injection before V6 is closed.

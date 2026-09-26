# NQC Tranche 37 — Physical Unified Dry-Run & Evidence Generator

Status: **IN PROGRESS**

T37 is the architecture-close tranche. It must prove that the unified NQC path can preserve identity, canonical-truth separation, deterministic replay, funding safety, durable-action semantics and evidence generation at the scale required by the production objective.

## Non-negotiable scale envelope

The architecture target is **20,000–25,000+ real live blockchain markets under observation**, with headroom beyond that operating point. Synthetic stress is allowed only as capacity evidence and must never be represented as live-market evidence.

T37 Phase 1 therefore requires:

- synthetic market registry: **>= 50,000 markets**;
- synthetic strategy surfaces: **>= 250,000 surfaces**;
- deterministic signal stress: **>= 1,000,000 signals**;
- active synthetic market cohort: **>= 25,000 markets**;
- cold-market observability: **100%**;
- global full-market scans per signal: **0**;
- bounded affected-market fanout;
- deterministic replay: byte-identical outputs for identical seed/configuration;
- reorg invalidation exercised;
- content-addressed evidence bundle generation;
- authority issuance: **0**.

These are capacity and architecture gates, not claims that 25,000 real markets are already connected.

## Unified path contract

The final T37 path is:

```text
owned Reth P2P / ExEx
  -> Sensor Fabric
  -> Market Census + Surface/Market Fabric
  -> impact-index fanout
  -> candidate preparation
  -> exact simulation
  -> Flash Funding Executor / VCR
  -> Adaptive Execution Governor
  -> Action Fence + durable WAL
  -> private execution transport
  -> canonical outcome
  -> realized economics
  -> EvidenceBundle(ExecutionIdentity)
```

Signal lanes remain speculative/noncanonical. Canonical truth remains independently anchored. No signal, model score, shadow allocation or positive realization may self-promote authority.

## Real-market admission contract

A market does not count toward the 20,000–25,000 target merely because an address or pool ID exists. Real-market evidence must eventually bind at least:

```text
chain_id
protocol_semantics
deployment / pool / market address
code identity
asset identities
canonical state anchor
lifecycle/activity status
signal observability
simulation support state
funding compatibility state
execution compatibility state
evidence provenance
```

The real-market census gate is downstream in T37 and remains **NOT TESTED** until those records are physically enumerated from blockchain state/evidence.

## Economic scope

T37 does not certify profitability. It creates the measurement path required to later prove canonical realized net P&L, missed edge, capture efficiency and rolling 30-day target probabilities. Synthetic economics may test accounting invariants only and must be labeled synthetic.

## Global status

NQC remains:

`NOT_CERTIFIED / ACCELERATION_EVIDENCE_NOT_TARGET_ADMISSION`

until the downstream build, fork, canary, resilience and economic-evidence gates are satisfied.

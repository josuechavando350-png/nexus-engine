# V4 Replacement Difficulty Ledger

| Component | Commodity dependency | NEXUS-owned IP in V4 | Why five OSS projects are insufficient |
|---|---|---|---|
| Memory | optional vector/DB backend | typed memory kinds, temporal validity, provenance, scope, confidence, store contract | vector similarity alone does not define memory semantics or authority |
| Goals | optional durable backend | closed lifecycle, retry/cancellation semantics, history | workflow engine state is not NEXUS goal semantics |
| Planner | optional model provider | typed DAG, evidence binding, capability/policy metadata, validation/scoring | LLM output alone is not an executable/auditable plan |
| World model | graph/simulator backends | observed/inferred/predicted/simulated separation and branch rules | databases do not prevent simulated facts becoming observations |
| Replay | durable engine | side-effect-free replay + committed effect identity | vendor retries do not define NEXUS physical safety semantics |
| Multi-agent | optional agent framework | capability-subset delegation | framework delegation commonly passes messages; it does not create authority semantics |
| Inference | any model | provider-neutral capability routing contract | model vendors are replaceable and cannot grant execution authority |
| Recovery | infrastructure adapters | failure taxonomy + bounded recovery decisions | generic retry libraries cannot reason about policy denial vs stale world state |

## Gate question
**What did V4 build that a competent team does not get by wiring five OSS projects for a weekend?**

Answer: the owned semantics connecting evidence-grounded memory, persistent goals, typed plans, world-state class separation, capability-bounded delegation, side-effect-free replay, bounded recovery and a hard boundary that forces every physical effect back through V3 policy/simulation/approval. The OSS products can implement ports; they do not define this integrated contract.

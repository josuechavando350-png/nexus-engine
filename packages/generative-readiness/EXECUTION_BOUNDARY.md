# NEXUS Provider Execution Boundary

NEXUS uses a single-writer model for repository, motor, semantic-graph, deployment, approval, transaction, and other governed mutations.

External model providers such as Anthropic Claude, and any other advisory model including OpenAI models used as proposal sources, are advisory-only. They are never elevated into writers or symmetric executors. Their outputs enter NEXUS only as bounded, tenant-scoped, digest-bound `AdvisoryProposal` data. An advisory proposal has no GitHub credentials, motor access, semantic-graph mutation path, deployment authority, approval authority, transaction authority, or write capability.

Provider neutrality applies only to advisory proposal ingestion. Write authority is not provider-neutral: the sole writer is the NEXUS executor operated by the OpenAI/ChatGPT control plane.

The enforced flow is:

`advisor -> AdvisoryProposal -> NEXUS validation -> tenant/scope -> authorization/capability/budget/approval -> NEXUS_OPENAI_OPERATOR executor -> motor/GitHub/governed state -> audit/evidence -> output verification`

The NEXUS governance port must fail closed unless authorization, the required capability, execution budget, and authoritative approval are all verified. The proposal-side approval envelope is integrity data only and is not itself proof of approval authority. Provider transport failures, policy failures, timeout/cancellation, cross-tenant attempts, stale/replayed proposals, idempotency conflicts, or malformed evidence cannot fall through to execution.

Production callers must create one long-lived `GovernedAdvisoryRuntime` per governed scope with `createGovernedAdvisoryRuntime(...)` and reuse that instance across requests. Creating a fresh runtime per request is not a valid production integration because it would discard in-process idempotency bindings, concurrent-request coalescing, terminal `OUTCOME_UNKNOWN` state, and the tamper-evident audit chain. Durable cross-process guarantees remain the responsibility of the authoritative governance/executor/storage layer; this package does not claim that its in-memory runtime state is durable across process restarts.

There is no direct advisor-to-GitHub, advisor-to-motor, advisor-to-deployment, advisor-to-transaction, or advisor-to-graph write path.

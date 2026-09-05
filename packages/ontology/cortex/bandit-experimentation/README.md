# CORTEX 01 — Server-Side Contextual Multi-Armed Bandit

This module is the governed server-side experimentation engine for NEXUS CORTEX. It uses an upper-confidence-bound (UCB) policy over explicitly registered variants and persists assignment/outcome state through the NEXUS ontology transaction boundary.

## Production contract

- **Server-side assignment only.** Callers provide a request id, a policy-approved context, and the set of eligible arm ids. The client does not choose its own variant.
- **Controlled variants.** Every arm is registered up front with immutable JSON payload plus minimum and maximum traffic shares.
- **Evidence before automation.** Each eligible arm must meet `minimumObservationsPerArm` before confident exploitation is possible.
- **Deterministic fallback.** When confidence intervals do not establish a winner, the configured default arm is served whenever its traffic ceiling permits it.
- **Bounded exploration.** Minimum and maximum traffic shares are enforced on assignment. UCB is used only inside the allowed envelope.
- **Economic reward.** Outcomes combine conversion and normalized economic value using immutable weights captured on each decision.
- **Idempotency.** A request id maps to one persisted assignment. Replaying the same outcome is safe; conflicting replays are rejected.
- **Context isolation.** Only allowlisted context keys are accepted. Raw context values are not persisted in learning state; the engine stores deterministic digests.
- **Configuration isolation.** Policy or variant changes produce a new configuration digest so evidence from incompatible configurations is never blended.
- **Rollback and kill switch.** `FALLBACK_ONLY` forces the default arm; `KILLED` disables automatic allocation immediately and also serves the default arm.
- **Auditable evidence.** Every decision captures the policy/configuration digests, reason, evidence snapshot, issuance time, status and integrity digest. `auditSnapshot()` exposes traffic, outcome, value, confidence and UCB metrics.
- **Transactional persistence.** Assignment+exposure and outcome+reward updates are each committed atomically through `OntologyTransactionPort` with optimistic conflict retries.

## Reward

For an observed outcome:

`reward = conversionWeight * conversion + economicValueWeight * min(1, economicValue / economicValueNormalizationCap)`

Weights must each be in `[0,1]` and sum to `1`. Economic value must be finite and non-negative. Outcomes outside the decision's configured attribution window are rejected.

## Confidence and selection

For each arm with `n` observations, the engine computes a bounded Hoeffding confidence interval around mean reward using the configured confidence level. A winner exists only when the best arm's lower confidence bound is strictly above every competitor's upper confidence bound. Until then, the engine falls back deterministically after satisfying minimum observation and traffic-floor requirements. UCB scoring is retained for governed exploration/rebalancing when ceilings prevent the preferred assignment.

## Production integration

`production-runtime.ts` is the production HTTP boundary and `scripts/cortex-bandit-control-plane.mjs` is the executable entry point. The executable imports only the compiled CORTEX runtime, opens `SqliteOntologyTransactionStore` on `NEXUS_CORTEX_STATE_DB`, loads an exact versioned experiment configuration from `NEXUS_CORTEX_BANDIT_CONFIG`, and exposes authenticated selection, outcome and runtime-control endpoints.

The executable **fails closed** unless:

- `NEXUS_CORTEX_STATE_DB` is an absolute non-memory path;
- `NEXUS_CORTEX_PERSISTENCE_ACK=durable-volume` explicitly confirms that the path is backed by a persistent mounted volume;
- `NEXUS_CORTEX_BANDIT_CONFIG` is an absolute regular-file path containing a bounded version-1 configuration;
- `NEXUS_CORTEX_API_TOKEN` is present and at least 32 characters.

This prevents accidental deployment on an ephemeral serverless filesystem. SQLite remains the included single-node durable adapter; multi-node deployment requires a transaction adapter with the same atomic/CAS guarantees rather than sharing a SQLite file over an unsafe network filesystem.

Runtime control is not a process-local flag. `CortexBanditRuntimeController` persists `ACTIVE`, `FALLBACK_ONLY` or `KILLED` through the same transaction boundary, requires expected-revision CAS on every change, and atomically appends an integrity-digested control event. Control state and its audit history therefore survive process restarts. A selection request cannot supply its own mode; the server always reads the durable control state and applies it to the engine.

The HTTP boundary requires bearer authentication for all experiment endpoints, rejects unknown routes and methods, bounds JSON request bodies, rejects non-JSON media types, emits `Cache-Control: no-store`, and reports only minimized operational telemetry. Raw request context and request bodies are never written to telemetry by this runtime.

The production path is:

`authenticated caller -> production HTTP runtime -> durable runtime control -> ServerSideContextualBanditEngine -> OntologyTransactionPort -> durable SQLite volume`

and outcomes return through the same runtime into the exact persisted decision and reward state.

CORTEX Control Plane integration across technologies remains the scope of GREEN-SPEC #21; it will orchestrate this already-live runtime rather than replace or duplicate its allocation logic.

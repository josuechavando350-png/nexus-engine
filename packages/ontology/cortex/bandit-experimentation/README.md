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

## Integration

Create one `ServerSideContextualBanditEngine` per experiment configuration and inject the NEXUS `OntologyTransactionPort` used by the runtime. The in-memory transaction store is intended for tests/reference execution; production wiring must provide the runtime's transactional persistence implementation. Call `select()` at the server decision point and `recordOutcome()` only after the business outcome has been observed and validated.

CORTEX Control Plane risk policies are intentionally not embedded here; they are the scope of GREEN-SPEC technology #21 and will wrap this engine rather than duplicating its allocation logic.

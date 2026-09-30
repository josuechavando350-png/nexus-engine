# NQC Quant Firm OS

Status: ARCHITECTURE_ONLY / NOT A PROFITABILITY CLAIM / NOT PRODUCTION AUTHORITY

## Objective

NQC is not designed as a single trading bot. The target architecture is a quantitative firm encapsulated in software: deterministic execution surrounded by independent research, market-truth, capital, routing, risk, verification and reliability systems.

The architecture optimizes for evidence-backed net economic capacity, not raw opportunity count:

```
realizable_net_capacity
= edge
× executable_capacity
× capture_probability
× availability
× strategy_breadth
- all_costs
- tail_reserves
- collision_losses
```

No architectural feature, model score, backtest, simulated P&L or agent opinion is allowed to claim realized profitability.

## Non-negotiable runtime boundary

LLM/agent inference is forbidden from the money-moving hot path.

The hot path must remain deterministic code with explicit inputs, bounded arithmetic, replayable decisions and independently verifiable receipts:

```
canonical state
-> candidate
-> sizing
-> financing
-> routing
-> simulation
-> policy/risk gate
-> transaction construction
-> submission/inclusion strategy
-> settlement verification
-> P&L reconciliation
```

Agents may research, propose, falsify, compare, generate tests and prepare candidate strategy specifications. They may not silently bypass certified gates or self-promote a strategy into live execution.

## Canonical agent topology

NQC defines 48 logical specialist roles arranged as eight desks of six roles and an exact operational fleet of 350 agent instances when Quant Firm mode is enabled. The 48 roles define responsibility and authority boundaries; the 350 instances provide parallel research, falsification and independent reproduction. Deterministic batch workers are a separate compute class and do not count toward the 350-agent fleet.

**Fleet invariant:** `REGISTERED_OPERATIONAL_AGENTS == 350`. Starting a 351st agent must fail closed. Running with fewer than 350 is permitted only in an explicitly declared degraded/recovery mode and may not claim full Quant Firm fleet readiness.

### Desk A — Market Truth & Discovery

1. Protocol Cartographer — discovers protocol families, versions, deployments and upgrade surfaces.
2. Market Census Agent — enumerates canonical markets from independent discovery sources and reconciles deltas.
3. State Reconstruction Agent — reconstructs exact block-pinned market state.
4. Position Universe Agent — derives and reconciles active accounts/positions against authoritative chain state.
5. Oracle Truth Agent — verifies oracle configuration, price source, freshness, decimals and fallback behavior.
6. Token Semantics Agent — classifies decimals, rebasing, fee-on-transfer, hooks and other execution-affecting behavior.

### Desk B — Capital & Funding

7. Flash Liquidity Agent — discovers and verifies flash-loan capacity and fee semantics.
8. Flash Swap Agent — discovers and verifies flash-swap capacity and settlement semantics.
9. External Credit Agent — models evidence-bound credit facilities and repayment constraints.
10. Gas Funding Agent — proves non-operator gas funding availability and cost.
11. Funding Router Agent — constructs feasible funding compositions under atomicity/cap constraints.
12. Capital Auditor — independently proves OWN_CAPITAL=0 and detects hidden operator-capital dependence.

### Desk C — Liquidity, Routing & Monetization

13. Venue State Agent — reconstructs exact DEX/venue state at the execution anchor.
14. Route Discovery Agent — finds direct and multi-hop routes without trusting one aggregator.
15. Price Impact Agent — computes exact size-dependent impact and fee curves.
16. Fragmentation Agent — models liquidity split across venues/pools/chains.
17. Monetization Agent — proves that seized/output assets can actually be converted into the valuation asset.
18. Route Red-Team Agent — searches for slippage, stale route, callback, sandwich and state-drift failure modes.

### Desk D — Execution & Inclusion Research

19. Transaction Construction Agent — researches minimal deterministic calldata/executor plans.
20. Simulation Agent — runs exact pre-state/post-state simulations and classifies reverts.
21. Inclusion Intelligence Agent — studies public/private flow and inclusion mechanisms without assuming guaranteed access.
22. Builder/Relay Research Agent — measures supported builder/relay behavior and evidence-bound costs.
23. Latency Engineering Agent — identifies where latency materially changes capture probability.
24. Reorg/Failure Agent — models replacement, reorg, invalidation, replay and settlement failure behavior.

### Desk E — Strategy Research

25. Transaction Archaeology Agent — mines historical transactions for reproducible economic patterns.
26. Hypothesis Miner — converts observed structure into explicit falsifiable strategy hypotheses.
27. Strategy Generator — produces machine-readable candidate strategy specifications, never live authority.
28. Historical Replay Agent — evaluates hypotheses against historical block-pinned truth.
29. Regime Agent — partitions results by volatility, gas, liquidity, competition, chain and protocol regimes.
30. Strategy Challenger — actively tries to destroy proposed edges before promotion.

### Desk F — Quant Risk, Economics & Portfolio

31. Cost Model Agent — accounts for protocol, flash, swap, impact, gas, priority, builder, financing, failure and other costs.
32. Capture Calibration Agent — estimates capture only from empirical evidence with intervals and provenance.
33. Capacity/Conflict Agent — builds N-way shared-resource contention and capacity constraints.
34. Correlation Agent — detects double counting and common-factor dependence.
35. Tail Risk Agent — models worst case, loss probability, drawdown and explicit reserves.
36. Portfolio Research Agent — formulates global allocation across mutually compatible opportunities; deterministic solver authority remains separate.

### Desk G — Independent Verification & Security

37. Evidence Verifier — validates hashes, manifests, anchors, commits, trees and artifact provenance.
38. Independent Reproducer — rebuilds results from raw authenticated inputs without trusting the producing agent.
39. Statistical Red-Team Agent — searches for survivorship, look-ahead, leakage, cherry-picking and invalid inference.
40. Arithmetic/Invariant Agent — attacks integer arithmetic, overflow, rounding and conservation assumptions.
41. Security/Supply-Chain Agent — audits dependencies, executors, signing boundaries and software supply-chain risk.
42. Certification Gatekeeper — checks terminal proof requirements and can only fail closed; it cannot invent evidence.

### Desk H — Platform, Reliability & Meta-Research

43. Data Plane Agent — optimizes deterministic ingestion, partitioning, compression, checkpoints and replay.
44. Node/RPC Reliability Agent — compares provider/node truth, health and divergence.
45. SRE/Observability Agent — owns metrics, traces, failure budgets and deterministic incident evidence.
46. Experiment Orchestrator — schedules isolated research experiments and prevents evidence contamination.
47. Agent Performance Auditor — measures which agents add validated information versus noise/cost.
48. Meta-Research Controller — allocates research work across desks from explicit priorities; no direct execution authority.

## Authority model

The 48 roles are advisory/research/verification authorities only inside their declared scopes. Money-moving authority remains deterministic and gated.

A strategy must move through this lifecycle:

```
DISCOVERED
-> CANONICALIZED
-> REPRODUCIBLE
-> HISTORICALLY_REPLAYED
-> ADVERSARIALLY_CHALLENGED
-> ECONOMICALLY_FEASIBLE
-> SHADOW_ELIGIBLE
-> SHADOW_CALIBRATED
-> CANARY_ELIGIBLE
-> CANARY_PROVEN
-> PRODUCTION_ELIGIBLE
```

No stage may be skipped. Failure at any stage returns the strategy to research or rejection.

## Quant Firm software planes

### 1. Market Intelligence Fabric

Own-node/RPC inputs, protocol discovery, canonical state, oracle truth, token semantics, account universe and incremental refresh.

### 2. Capital Graph

All atomic and permitted persistent external financing represented as block-pinned capacity edges with fee, repayment, collateral, cap, failure and atomicity semantics.

### 3. Execution Fabric

Deterministic executors, transaction builders, simulation, route plans, submission policies, receipts, reorg handling and settlement reconciliation.

### 4. Global Portfolio Engine

Shared-resource constraints across borrower, market, debt/collateral, capital source, DEX liquidity, oracle event, protocol cap, block/builder slot and any future scarce resource. The objective is portfolio net P&L/capacity, not independent opportunity count.

### 5. Research OS

Transaction archaeology, strategy hypotheses, replay, regime analysis, challengers and automatic test generation.

### 6. Digital Twin / Shadow

Live state and candidate generation with action writes suppressed. Produces empirical capture, decay, route survival, inclusion, failure and cost distributions.

### 7. Evidence Kernel

Content-addressed manifests, exact commit/tree identity, authenticated source artifacts, independent recounts and fail-closed certification.

### 8. Reliability & Security Plane

Node health, deterministic checkpoints, incident replay, signing isolation, secrets boundaries, dependency provenance and measurable SLOs.

## Promotion invariants

- No agent output is sufficient evidence by itself.
- No synthetic fixture may be presented as live-market evidence.
- No model probability may be admitted without a calibration source and observation window.
- Gross P&L is never reported as net P&L.
- Operator capital must never be silently substituted for missing external capital.
- Any disagreement across providers, indexers, state reconstruction, simulation or accounting enters a mismatch ledger.
- UNKNOWN is not a terminal classification.
- Every production-relevant decision must be replayable from authenticated inputs.
- Every material numeric path uses exact integer/fixed-point semantics appropriate to the underlying protocol.
- Downstream stages pin exact upstream run/artifact/code identities.
- New strategy families inherit the same evidence hierarchy; they do not bypass it.

## Scaling policy

Forty-eight roles are canonical and the full operational agent fleet is exactly 350 instances. Agent-instance count is therefore bounded; compute concurrency is elastic only through deterministic workers.

The canonical desk allocation is:

| Desk | Operational agents |
|---|---:|
| Market Truth & Discovery | 55 |
| Capital & Funding | 30 |
| Liquidity, Routing & Monetization | 45 |
| Execution & Inclusion Research | 45 |
| Strategy Research | 65 |
| Quant Risk, Economics & Portfolio | 40 |
| Independent Verification & Security | 55 |
| Platform, Reliability & Meta-Research | 15 |
| **Total** | **350** |

Examples:
- the 55 Market Truth agents divide by chain/protocol/state responsibility;
- Historical Replay may fan out across millions of deterministic jobs without creating additional agents;
- independent Reproducer agents remain distinct members of the 350-agent fleet;
- hot-path executors remain deterministic services, not agent replicas.

A 351st agent is not a scaling mechanism. Massive replay, census, simulation and parameter-search workloads scale through deterministic workers, which must remain attributable to a registered agent/task but have no independent agent authority.

## Economic objective

The system must optimize Conservative Realizable Capacity rather than headline backtest P&L.

Required outputs eventually include:
- executable opportunity arrival rate;
- size-to-net-P&L curves;
- capture probability intervals;
- failure/revert distributions;
- opportunity lifetime and decay;
- shared-resource conflict sets;
- competition-adjusted capacity;
- tail-adjusted capacity;
- realized Shadow and Canary reconciliation;
- out-of-sample and regime-specific performance;
- net P&L with every material cost included.

The current target values remain hypotheses to falsify. Architecture is not evidence that any target is reachable.

## Integration with the existing NQC roadmap

This architecture does not replace current certification order.

```
Protocol/Fork Truth
-> Real Market Census
-> Shadow Execution
-> Apex Execution Hardening
-> Canary
-> Real P&L Evidence
-> Final Liquidation Certification
-> Multi-Strategy Expansion
-> Global Capacity Optimization
-> NQC Apex Continuous Autonomous Optimization
```

RMC remains responsible for canonical market/economic/actionability truth. The 48-role Quant Firm OS is introduced without granting any new production authority. Agent-driven research becomes materially authoritative only after the relevant phase gates are certified.

## Terminal design principle

NQC should behave like a quantitative organization with software-enforced separation of duties:

- researchers search for edge;
- challengers attempt to falsify it;
- verifiers reproduce it;
- deterministic systems execute it;
- accounting proves what actually happened;
- certification controls promotion.

The system earns production authority from evidence. It never receives it from architecture, ambition or agent consensus.


## Reuse of existing NEXUS agent technology

The Quant Firm agent plane should reuse proven architectural primitives already present in NEXUS rather than creating a parallel framework:

- `runtime/crates/nexus-agents-v4`: typed `AgentSpec`, bounded capabilities/tools and delegation that cannot elevate authority;
- `runtime/crates/nexus-intelligence`: evidence-grounded cognitive decisions that remain proposals and require a downstream dispatch gate;
- `runtime/crates/nexus-event`: canonical event/evidence envelopes;
- `runtime/crates/nexus-observability`: structured telemetry and append-only audit evidence;
- V6 distributed-runtime contracts: placement, discovery, federation, replication and failure-domain separation without turning placement into authorization.

NQC-specific finance semantics remain outside the generic NEXUS runtime. Integration is through typed adapters/contracts so the generic runtime stays reusable and NQC retains its own market/economic certification boundaries.

The 350-agent fleet must preserve the existing NEXUS rule that text delegation is not authority. Every delegated capability must be a subset of both parent authority and child capability, and model output alone cannot grant execution rights.

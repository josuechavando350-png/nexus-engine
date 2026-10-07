# RMC-015B — Temporal Opportunity Episode Reconstruction

## Mission

RMC-015B reconstructs the full historical lifecycle of every material economic
liquidation opportunity discovered from authenticated RMC-015A trigger authority.

For each opportunity lineage, the required lifecycle is:

healthy -> threshold approach -> first liquidatable/actionable state ->
first executable state -> active interval -> captured / expired / recovered /
reorg-invalidated / right-censored terminal.

RMC-015B is not allowed to reuse one current RMC-013 anchor to value historical
opportunities. Every historical episode binds its own exact pre-state execution
and economics authority.

## Canonical temporal ordering

Every transition binds a canonical order point:

- PRE_TX(block, transaction_index)
- LOG(block, transaction_index, log_index)
- POST_TX(block, transaction_index)
- END_BLOCK(block)

Ordering is total and deterministic. END_BLOCK sorts after all transactions and
logs in that block.

## Censoring

- left_censored=true means the opportunity was already active at the declared
  window start. Birth time MUST remain unknown.
- right_censored=true means the opportunity remained active at the declared
  window end. Death/lifetime MUST remain unknown.

Censored episodes cannot be silently converted into uncensored duration
observations.

## Competitor observability

Canonical chain data can prove inclusion order. It cannot prove mempool, P2P or
builder-arrival time.

Therefore:

- competitor_inclusion may be observed from chain evidence;
- time_to_first_competitor_arrival remains UNKNOWN unless timestamped
  mempool/P2P/relay evidence is explicitly bound.

UNKNOWN arrival latency is not a terminal blocker when the observability class
makes that quantity fundamentally unobserved; it must remain explicitly
UNKNOWN rather than being imputed.

## No-look-ahead Nexus counterfactual

Every Nexus historical counterfactual is ex ante. Its evidence maximum order
must be <= the decision order point. Post-outcome route, price, winner,
competitor, gas or inclusion information cannot enter the prediction.

## Episode identity and evidence

Each episode binds:

- temporal opportunity lineage id;
- canonical market/deployment identity;
- borrower/position identity;
- debt/collateral pair;
- birth state or explicit left-censoring;
- first actionable state;
- first executable state;
- exact historical execution/economics authority;
- active interval transitions;
- terminal outcome or explicit right-censoring;
- winner transaction/searcher evidence when observable;
- capital/route/gas/builder evidence when observable;
- Nexus pre-state-only counterfactual;
- capture observability class;
- exact code/evidence commitments.

## Conservation

Every material RMC-015A trigger entering the episode builder must be accounted
for exactly once as either:

- consumed by one or more linked episode transitions under one lineage; or
- explicitly rejected with a non-UNKNOWN reason.

No trigger may disappear, and no trigger may be counted under multiple unrelated
lineages.

## Terminal gate

RMC015_TEMPORAL_OPPORTUNITY_AUTHORITY_PASS is legal only when:

- authenticated RMC-015A trigger authority is pinned;
- complete trigger conservation passes;
- every retained episode has deterministic canonical ordering;
- every historical executable state has its own pre-state execution/economics
  replay authority;
- censoring is explicit and duration is never invented;
- competitor arrival remains UNKNOWN unless direct timestamped evidence exists;
- Nexus counterfactuals contain no look-ahead;
- unresolved mismatch count = 0;
- material terminal UNKNOWN count = 0 except explicitly modeled
  observability-limited fields;
- evidence manifests bind every retained artifact.

Foundation tests are not terminal authority.

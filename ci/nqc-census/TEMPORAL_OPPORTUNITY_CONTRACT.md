# RMC-015 — Temporal Opportunity Authority Contract

## Mission

RMC-015 converts structurally valid Census candidates into reproducible historical temporal authority. It measures when opportunities appear, how long they remain actionable, how they terminate, whether and when a competing liquidation arrives, recurrence, and regime dependence.

RMC-015 is retrospective state/competition evidence. It MUST NOT claim that Nexus would have captured an opportunity, MUST NOT invent capture probability, and MUST NOT use future state when constructing ex-ante economic decisions.

## Upstream boundary

Terminal RMC-015 may consume only one exact immutable RMC_014_STRUCTURAL_CHAIN_CERTIFIED artifact. The upstream structural certificate must retain real_market_census_closed=false, realized_profitability_proven=false, and monthly_target_probability_proven=false.

## Observation windows

Every observation window binds chain id, inclusive start/end block, start/end block hashes, start/end timestamps, explicit regime_id, and a non-zero completeness commitment. Windows must be strictly ordered and non-overlapping on the same chain.

block-coverage.jsonl MUST tile every observation window exactly with no unexplained block gap or overlap. Every coverage segment binds a content-addressed source artifact and status PASS. Missing blocks are not zero opportunities; a gap is terminal failure.

## Stable opportunity identity

Temporal recurrence uses a stable key containing chain id, protocol family/version, deployment id, market address, borrower, collateral asset and debt asset. stable_opportunity_id is SHA-256 over canonical JSON of that key under domain NQC-RMC015-STABLE-OPPORTUNITY-V1.

## Episode semantics

An episode is one maximal actionable interval for one stable opportunity inside one declared observation window. It binds deterministic episode id, recurrence index, start/end block/hash/timestamp/reason/evidence, left/right censoring flags, optional first competitor, and non-empty content-addressed evidence.

Allowed start reasons: ACTIONABLE_THRESHOLD_CROSS; WINDOW_OPEN_ACTIVE only when left-censored.

Allowed end reasons: COMPETITOR_CAPTURE; STATE_RECOVERY; ORACLE_MOVE; DEBT_REPAID; COLLATERAL_CHANGE; MARKET_PAUSED; CONFIGURATION_CHANGE; WINDOW_END_RIGHT_CENSORED.

A right-censored episode must end exactly at the window boundary and is not an observed lifetime event. A left-censored episode must start exactly at the window boundary and is excluded from exact start-to-end lifetime and competitor-latency estimation. It remains preserved in the raw population.

Episodes for the same stable opportunity must not overlap. Recurrence indices must be contiguous and deterministic.

## Competitor evidence

first_competitor is permitted only for COMPETITOR_CAPTURE and binds exact block, transaction hash, actor address and evidence. Its block/timestamp must equal episode termination. Observed competitor arrival is not equivalent to Nexus capture probability.

## Censoring-aware statistics

Statistics use exact integer/rational arithmetic: non-left-censored arrival count divided by observed seconds; Kaplan-Meier lifetime survival with right censoring; median lifetime only when survival crosses 1/2; competing-risk cumulative incidence for first competitor vs other termination; recurrence; and regime partitions. Fractions are numerator/denominator strings. Floating-point probability is not certification authority.

## Rejections and mismatches

Every excluded temporal item requires an explicit non-UNKNOWN reason and evidence. UNKNOWN is never PASS. Terminal admission requires exact window coverage, zero gaps, zero episode identity mismatch, zero overlap/recurrence mismatch, zero censoring-semantic mismatch, zero UNKNOWN rejection, and zero unresolved mismatch.

## Anti-look-ahead boundary

Later blocks may label retrospective outcomes only. Future blocks must not be incorporated into the ex-ante start snapshot or any RMC-013 quote. Start evidence and outcome evidence remain distinct.

## Explicit non-claims

RMC-015 does not certify actual Nexus capture probability, realized P&L, optimal simultaneous scheduling, full concurrent physical capacity, Month-1 USD 300,000 target reliability, Shadow performance, or Canary performance.

## Terminal marker

A passing RMC-015 emits only RMC_015_TEMPORAL_OPPORTUNITY_AUTHORITY=PASS. It never emits REAL_MARKET_CENSUS_CLOSED.

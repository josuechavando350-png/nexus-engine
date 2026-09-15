# WALLE Outcome Calibration V1

Outcome Calibration V1 measures how previously bound WALLE model components compare with later observed first-party outcomes. It is deliberately descriptive: it does not infer that an SEO action caused an outcome, and it does not turn historical error into a Google ranking probability.

## Why this layer exists

Growth Scenario V1 is intentionally hypothetical. Client Quality / Cohorts V1 adds privacy-safe observed business outcomes. Outcome Calibration V1 links those worlds without rewriting either one.

Every calibration observation binds immutable SHA-256 identities for:

- the historical Growth Scenario report;
- the exact Growth assumption profile;
- the historical feasibility report;
- the historical opportunity-decision report;
- the action receipt;
- the WALLE `growth_attribution` receipt;
- the Client Quality / Cohorts report.

Historical hashes are evidence. Calibration never mutates or replaces them.

## Real attribution boundary

Real outcome attribution remains in WALLE `growth_attribution`. Calibration only consumes an authorized composite export whose source authority is exactly:

`WALLE_GROWTH_ATTRIBUTION_CALIBRATION_EXPORT_V1`

Each record must include a `growth_attribution_receipt_sha256`. The calibration layer does not substitute a Growth Scenario value for observed attribution.

The tenant wrapper additionally binds the calibration export to the current tenant control generation and current evidence-manifest SHA-256, then rechecks both control and evidence after evaluation. Drift produces `STALE`.

## What V1 calibrates

V1 calibrates business-model components that have a compatible later observed aggregate:

- lead-conversion PPM;
- close-rate PPM;
- average-ticket micros when a later observed ticket exists.

For each metric, the signed error is `observed - modeled`. The engine derives deterministic empirical descriptive statistics using integer arithmetic:

- mean signed error;
- mean absolute error;
- nearest-rank P50 absolute error;
- nearest-rank P90 absolute error;
- maximum absolute error.

There are no hidden weights, no magic accuracy score, and no floating-point calculations.

## Deliberate count/revenue boundary

Growth Scenario V1 does not currently define an explicit future forecast horizon. Therefore V1 **does not** compare projected absolute client counts or projected revenue with future totals. Doing so would mix quantities whose time bases are not proven equivalent.

The report carries:

`ABSOLUTE_CLIENT_AND_REVENUE_COUNT_CALIBRATION_DEFERRED_UNTIL_EXPLICIT_SCENARIO_HORIZON_EXISTS`

This is intentional fail-closed behavior, not a missing implementation.

## Observation integrity

Each calibration record contains:

- scenario and rank-target identity;
- all immutable report/action/attribution hashes;
- prediction creation time;
- action execution time;
- observation-window start/end;
- observation-complete flag;
- attribution-completeness PPM;
- modeled and later observed funnel components.

Chronology must be `prediction <= action <= observation-window start < observation-window end`. Duplicate calibration IDs or duplicate action receipts fail closed so one action cannot silently inflate the sample.

The calibration snapshot itself is canonical SHA-256 bound, including source capture SHA, record SHA, tenant control generation, evidence manifest hash, capture ID, and observed timestamp.

## Sufficiency and exclusion

The operator supplies an explicit hash-bound profile containing:

- `minimum_records`;
- `minimum_attribution_completeness_ppm`;
- profile ID and provenance.

Incomplete observation windows and records below the required attribution completeness are excluded from the empirical sample with explicit reasons. If the accepted sample is smaller than `minimum_records`, the report is `INSUFFICIENT_DATA` rather than pretending a stable calibration exists.

Scenario-specific bands are reported independently. A scenario with too few observations remains `INSUFFICIENT_DATA` even when the global sample is sufficient.

## Non-claims

Outcome Calibration V1 is not:

- causal SEO-lift evidence;
- a Google ranking probability;
- a rank guarantee or time-to-rank prediction;
- a future client-count guarantee;
- a future revenue guarantee;
- a confidence interval or statistical-significance test;
- a replacement for WALLE `growth_attribution`.

Empirical error bands are descriptive summaries of the exact evidence set only.

## Runtime authority

The layer has no provider-network client, Google Search scraper, browser/process execution, site/CMS mutation, content publishing, link creation, or tenant-control mutation authority. It consumes only caller-supplied authorized calibration snapshots plus the existing read-only tenant control/evidence boundary.

## Next dependency

Outcome Calibration is evidence for a later Rank Transition Model and Decision Engine, but it does not create transition probabilities itself. Rank probabilities remain deferred until enough comparable longitudinal cohorts exist for empirical calibration.

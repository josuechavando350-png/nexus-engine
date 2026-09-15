# WALLE Growth Scenario Engine

## Purpose

The Growth Scenario Engine converts authorized first-party search and funnel evidence into bounded hypothetical scenarios. It exists to answer questions such as:

- what traffic range is mechanically implied by an explicit CTR assumption for Top 10, Top 3, or Top 1;
- what sessions, leads, signed-client equivalents, and economic value would follow if the observed funnel continued to behave at its measured rates;
- which assumptions are responsible for a scenario result.

It is **not** a Google rank predictor, ranking guarantee, traffic guarantee, lead guarantee, or revenue guarantee.

## Operational path

The production-facing entrypoint is:

`growth-scenario/tenant-scenario.mjs -> buildTenantGrowthScenario(...)`

It does not accept an unverified provider export directly. It first calls the existing fail-closed `readTenantEvidenceSnapshot(...)` boundary and therefore inherits:

- tenant authorization and kill-switch enforcement;
- exact control-generation binding;
- tenant isolation;
- manifest validation;
- dataset SHA-256 revalidation;
- symlink/path hardening;
- a second control check after evidence reading.

After scenario calculation it rechecks tenant control and re-reads the evidence snapshot. A generation change or manifest change makes the scenario `STALE` and suppresses the report.

## Required evidence

V1 requires:

- `search_performance_records` from the authorized Search Console evidence path;
- `revenue_funnel_records` from the authorized aggregated CRM evidence path.

Missing required evidence is `INSUFFICIENT_DATA`; it is never converted into zero demand, zero conversion, or a fabricated optimistic scenario.

## Assumption profile

There are intentionally **no built-in Google CTR constants**.

Every run requires an explicit assumption profile with:

- `profile_id`;
- `provenance`;
- `click_to_session_ppm`;
- `organic_funnel_source_ids`;
- exactly three bands: `CONSERVATIVE`, `BASE`, `UPSIDE`;
- explicit CTR PPM values for `TOP_10`, `TOP_3`, and `TOP_1`.

The engine validates monotonicity across both rank targets and scenario bands. The normalized profile is bound to a canonical SHA-256 included in the report.

A later calibration layer can derive these inputs from approved first-party cohorts or separately reviewed research. That calibration must remain explicit provenance; the scenario engine itself does not invent them.

## Integer model

All rates use parts per million (PPM). Fractional counts use thousandths (`*_milli`). Economic values use micros.

The deterministic flow is:

`observed impressions`

`x explicit scenario CTR`

`= modeled clicks`

`x explicit click-to-session rate`

`= modeled sessions`

`x observed weighted lead conversion`

`= modeled leads`

`x observed weighted close rate`

`= modeled signed-client equivalents`

`x observed weighted average ticket`

`= modeled economic value`

Intermediate multiplication uses integer `BigInt` arithmetic. Outputs must still fit the safe JSON integer range or the run fails closed.

## Baseline semantics

`modeledCurrent` applies the same click-to-session and observed funnel mechanics to current Search Console clicks. Scenario deltas are compared with this modeled baseline so assumptions remain internally consistent.

It is deliberately not labeled actual revenue or actual signed clients. Actual outcomes remain the responsibility of WALLE growth attribution and first-party business evidence.

## Client quality

V1 does **not** claim to measure client quality from a generic aggregate funnel.

It exposes observed close rate and average ticket as first-party value signals, but emits the boundary:

`CLIENT_QUALITY_REQUIRES_SEGMENTED_FIRST_PARTY_FUNNEL_EVIDENCE`

A later version may compare query/intent cohorts only after CRM evidence is explicitly segmented and privacy-safe. It must not infer a “better client” merely from a keyword or from a ranking assumption.

## Non-authority

The scenario layer has no authority to:

- call Google or any provider;
- scrape Google Search;
- obtain OAuth credentials;
- enable/disable tenants;
- clear a kill switch;
- write CMS content;
- mutate DNS, redirects, links, GBP, ads, or website files;
- claim causal lift;
- claim Google will rank a page at a target position.

It is an evidence-bound read-only decision-support layer.

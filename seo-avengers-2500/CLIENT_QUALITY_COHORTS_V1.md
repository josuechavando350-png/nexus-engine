# WALLE Client Quality / Cohorts V1

Client Quality / Cohorts V1 adds privacy-safe, aggregate first-party outcome evidence to WALLE without introducing raw client PII, query-level attribution claims, or a magic client-quality score.

## Purpose

The layer answers a bounded question:

> Across explicitly defined acquisition cohorts, what aggregate conversion, close, signed-client, and ticket outcomes have actually been observed, and which cohort dimensions were observed versus classified or estimated?

It does not claim that a search query caused a client, that an SEO action caused revenue, or that one cohort guarantees future results.

## Authorized evidence

The authorized provider boundary accepts `NEXUS_CRM -> client_cohort_records` only as aggregate rows. Every row contains exactly:

- service category + evidence basis;
- intent + evidence basis;
- geography + evidence basis;
- urgency + evidence basis;
- ticket band + evidence basis;
- source + evidence basis;
- aggregate sessions, leads, signed clients, and revenue micros;
- one shared observation window.

The schema has no name, email, phone, address, external client ID, free-form note, message body, or other raw-person field. Extra keys fail closed.

The cohort dataset is provenance-backed with `source_authority`, `source_capture_sha256`, canonical `records_sha256`, capture ID, observed time, and record count. The tenant wrapper recomputes the canonical dataset digest before releasing a report.

## Mapping contract

The operator supplies an explicit, hash-bound cohort profile containing:

- allowed service categories;
- intents;
- geographies;
- urgencies;
- ticket bands;
- sources;
- minimum aggregate sessions and leads for a reportable cohort;
- `mapping_profile_id` and `mapping_profile_sha256` for the upstream segmentation/classification contract.

Rows outside the allowed mapping profile fail closed. WALLE does not silently invent or remap categories.

Every dimension carries one of three evidence bases:

- `OBSERVED` — directly present in authorized source evidence;
- `CLASSIFIED` — assigned by an explicit upstream classifier/mapping contract;
- `ESTIMATED` — inferred upstream and explicitly labeled as estimated.

`CLASSIFIED` and `ESTIMATED` are never relabeled as observed.

## Privacy suppression

A cohort is reportable only when it satisfies the explicit `minimum_sessions` and `minimum_leads` thresholds. Small cohorts are omitted from the public cohort list. Their normalized rows are represented only by a SHA-256 digest plus a suppressed-cohort count, preventing the report from exposing small-cell outcome details.

The thresholds are operator-defined and hash-bound. V1 does not pretend they are universal privacy constants.

## Derived outcome metrics

For each eligible cohort V1 derives, with integer arithmetic only:

- lead conversion PPM;
- close rate PPM;
- signed-client rate PPM;
- observed average ticket micros when at least one client was signed;
- revenue per lead micros.

The report also includes aggregate eligible totals and the same aggregate ratios. There is no weighted `clientQualityScore`, success probability, or hidden scalar ranking.

## Decision boundary

Client Cohort Evidence remains a parallel evidence layer.

`CLIENT_COHORT_EVIDENCE_REMAINS_CONTEXT_UNTIL_EXPLICIT_ATTRIBUTION_MAPPING_EXISTS`

It does not modify Rank Feasibility, Competition, Authority, or Opportunity Prioritization V2. A later attribution/calibration layer may connect cohort outcomes to decisions only when the linking evidence is explicit, provenance-bound, and statistically sufficient.

## Fail-closed behavior

V1 rejects:

- raw/extra PII-like fields through exact schema enforcement;
- leads greater than sessions;
- signed clients greater than leads;
- positive revenue with zero signed clients;
- mixed observation windows;
- conflicting duplicate cohorts;
- categories outside the hash-bound mapping profile;
- invalid evidence bases;
- missing or malformed provider provenance;
- canonical dataset hash mismatch;
- stale tenant control or evidence drift during evaluation.

## Runtime authority

The layer has no provider-network client, Google Search scraper, browser/process execution, site/CMS mutation, publishing, link creation, or tenant-control mutation authority. It consumes only the existing authorized, read-only tenant evidence boundary.

## Non-claims

V1 does not claim or guarantee:

- Google ranking;
- rank probability or time-to-rank;
- query-level client attribution;
- causal SEO lift;
- future client count;
- future ticket or revenue;
- individual client quality;
- statistical significance for undersized cohorts.

The next layer after sufficient longitudinal cohort evidence is Outcome Calibration. Attribution remains separate from hypothetical Growth Scenario output.

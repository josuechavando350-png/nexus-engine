# CANO commercial tournament: GAUSS + AXIOMA integration contract

Status: design and evidence boundary only. **No CANO tournament has been executed or certified by this document.** Base revision: `903bbd45c090277b90a66a5d77015869ae42cf14`.

## Existing implementation and blocker

- `seo-avengers-2500/scripts/nexus-commercial-demand-tournament-v4.mjs` accepts `--scenario`, `--v3-evidence`, and `--v4-evidence`.
- `seo-avengers-2500/commercial-demand/tournament-engine-v4.mjs` is **not** a generic business runner: it requires a specific Nexus Bot Studio V3 winner, specific snapshot identifiers, an exact `https://www.nexusbotstudio.com/` offer URL, and fixed software-intent families. Substituting a CANO JSON file alone must fail rather than bypass those guards.
- `gauss/axioma/` supplies independent mathematical reference checks for bounded GAUSS operators. Mathematical agreement does not validate a marketing funnel or establish causal business effectiveness.
- The existing connected GAUSS proof entrypoint is `bash walle/adapters/gauss.sh`; its source/evidence bindings must be preserved when an actual CANO adapter is implemented.

## CANO evidence boundary

Only use dated, attributable exports from CANO's own accounts and confirmed business records. Separate these classes in machine-readable inputs:

1. `OBSERVED`: source, property/account, exact date range, metric definition, units, extraction timestamp, and evidence digest or immutable artifact reference. Google Ads clicks are not leads; Google Ads all-conversions are not necessarily primary conversions or clients; Search Console clicks are organic Google Search clicks, not all site sessions.
2. `CLIENT_CONFIRMED`: counts of real WhatsApp conversations, relevant criminal-law inquiries, retained clients, and their dates, only when supplied by the client; avoid storing names, messages, or sensitive case details in the public repository.
3. `ASSUMPTION`: explicit sensitivity parameters, with units and range, never silently promoted to observed conversion or close rates.
4. `UNAVAILABLE`: absent or still-processing metrics. In particular, a blank 28-day Search Console report is **not** zero clicks, zero impressions, or zero demand.

Do not carry over Nexus Bot Studio keyword volumes, funnel rates, winning strategies, or offer evidence. Do not use the 24-hour Search Console snapshot as a 28-day observation. A screenshot is a preliminary observation until its property, window, and freshness are documented.

## Required implementation sequence

1. Introduce a separate CANO scenario schema and evidence validator; reject missing source metadata, mismatched windows, duplicate evidence IDs, non-finite numbers, and unsupported conversions. Reject any cross-client evidence.
2. Extract reusable, business-agnostic calculations from V2/V3/V4 without weakening the existing Nexus Bot Studio regression checks. Keep the current V4 entrypoint and expected results intact.
3. Identify GAUSS operator IDs and exact input/output contracts for descriptive rates, uncertainty bounds, and bounded sensitivity calculations. Test edge cases including zero denominators and unavailable inputs. Do not claim that every calculation requires GAUSS.
4. Add an AXIOMA independent reference for each newly connected GAUSS calculation or explicitly report `NOT_VERIFIED`. Bind input digest, GAUSS output digest, source revision, reference result, and comparison verdict. Run through WALLE only after verifying the adapter's evidence contract.
5. Run deterministic fixtures and adversarial tests (missing Search Console window, zero versus unavailable, duplicate records, mismatched accounts, false lead-to-client mapping, and cross-client contamination). Then run against attributable CANO exports, publish the exact SHA and evidence manifest, and review the result before any campaign changes.

## Acceptance criteria

- The CANO runner cannot read the default Nexus Bot Studio scenario or silently inherit its rates, market estimates, or strategy winner.
- Every reported number is tagged `OBSERVED`, `CLIENT_CONFIRMED`, `ASSUMPTION`, `DERIVED`, or `UNAVAILABLE` with its lineage. `DERIVED` numbers name the inputs and formula/operator.
- GAUSS and AXIOMA are invoked in executable tests, not merely named in a report. An absent or failing AXIOMA reference prevents a `VERIFIED` label.
- Missing conversion evidence yields an explicitly limited decision report, never an invented client forecast or guaranteed effectiveness percentage.
- No production app, Ads campaign, DNS, Search Console setting, or `main` branch changes are required for the initial proof.

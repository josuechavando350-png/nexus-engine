# SEO Avengers 2500 — WALLE read-only production canary

## Purpose

This stage proves the operational path that sits between already-published tenant evidence and the existing SEO Avengers sidecar without using a real customer as a testbed.

The canary identity is hard-coded to `walle-production-canary`. The runner does not accept a caller-supplied site ID, does not create or enable tenant control state, does not collect provider data, does not crawl Google, does not publish content and does not mutate a client project.

## What a certified canary proves

A canary result is `CERTIFIED` only when:

1. the existing tenant control plane authorizes `walle-production-canary`;
2. the existing read-only evidence reader returns a digest-valid snapshot bound to the same control generation;
3. the existing tenant sidecar releases the real M1001-M2500 local range;
4. all 1,500 local receipts have `execution_status=SUCCESS`, `policy_status=SAFE_WHITE_HAT` and `action_mode=OBSERVE_ONLY`;
5. M2500 remains `NO_FINDING`, `release_safe=true`, `strict_white_hat_only=true` and `no_google_scraping=true`;
6. the result is persisted as a new immutable file under a result root outside the source tree;
7. the persisted proof binds exact Git source revision/tree, control generation, evidence manifest hash, config hash, execution hash, terminal evidence hash and a hash of the released worker result.

A duplicate run ID cannot overwrite prior evidence. Corrupt persisted bytes fail re-verification.

## WALLE adapter

`walle/adapters/seo-avengers-2500-canary.sh` is the operational entrypoint. It requires externally prepared control/evidence/result roots and an operator-supplied canary run ID. It binds the run to exact `HEAD` and `HEAD^{tree}`, requires a pristine source tree before and after execution, requires all runtime-authority roots to live outside the repository, and runs the current Google Search safety gate before the canary.

The adapter never enables the canary itself. Activation remains a separate explicit control-plane operation so the kill switch remains authoritative.

## CI smoke

The repository verifier includes a controlled smoke that:

- creates only the synthetic `walle-production-canary` control identity in temporary storage;
- publishes a deterministic test-only evidence snapshot using the existing Avengers fixture contracts;
- executes the real local Python sidecar for M1001-M2500;
- requires the immutable canary proof to certify all 1,500 local receipts;
- activates the existing kill switch;
- proves that the next run returns `OFF` and is not persisted.

The CI fixture is not a production measurement source and does not read a client app or external provider.

## Important scope boundary

This canary executes the sidecar's locally implemented M1001-M2500 range. It must **not** be described as 2,500 freshly executed tenant modules. M001-M1000 remain a delegated runtime boundary. The separate WALLE execution proof certifies repository-level controlled execution of M001-M2500; this canary certifies the first operational read-only tenant path for the local 1,500-module sidecar range.

No ranking, indexation, traffic, lead, client or revenue outcome is guaranteed by a canary certificate.

## What comes after this

The next production step is an authorized collector layer that publishes real first-party/provider evidence into the existing read-only evidence contract. That collector must use supported APIs/contracts, hold evidence-publication authority only, remain unable to mutate tenant control state, and preserve the no-Google-Search-scraping boundary.

Only after the collector and canary are independently green should a real tenant be considered for read-only activation, and that activation requires explicit operator approval. This stage does not activate CANO, SOMA or Nexus Bot Studio.

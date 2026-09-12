# SEO Avengers 2500 — out-of-band sidecar worker

This worker is the execution bridge between the merged tenant control plane, the merged read-only evidence boundary, and the existing deterministic M1001-M2500 runtime.

It is intentionally **not** part of any client request path. It does not modify a client app, publish content, mutate a CMS, change Google Ads, crawl Google, create links, write evidence, write tenant control state, or start a daemon/queue/scheduler.

## Execution contract

A run is released only when all of these remain true:

1. the tenant is currently authorized by the control plane;
2. the evidence snapshot is `READY`, tenant-bound, digest-valid and bound to the same control generation;
3. authorization is rechecked immediately before suite execution;
4. the local deterministic runtime returns the exact M1001-M2500 receipt range (1500 receipts), every receipt remains `SAFE_WHITE_HAT` + `OBSERVE_ONLY`, no runtime receipt is `ERROR`, and M2500 certifies with `SUCCESS` / `NO_FINDING` and `release_safe=true`;
5. authorization is rechecked after execution;
6. the evidence manifest is re-read and must still have the same hash and control generation;
7. authorization is checked one final time immediately before the result is released to the caller.

If a tenant is killed, disabled or moved to a newer generation while a run is executing, the worker suppresses the receipts. If the evidence snapshot changes during the run, the worker returns `STALE` and suppresses the receipts. If the post-execution evidence becomes malformed or integrity-invalid, the worker returns `BLOCKED`.

## Delegated M001-M1000 boundary

This worker executes the 1500 locally implemented modules M1001-M2500. It does **not** re-run M001-M1000 for every tenant job. Those modules remain delegated to `seo-avengers-1000` and are chained by repository verification, while M2500 certifies the exact suite composition contract. A sidecar `RELEASED` result must therefore not be described as 2500 freshly executed tenant modules.

## Result states

- `OFF`: the tenant is not currently authorized, or its generation changed before release.
- `INSUFFICIENT_DATA`: the tenant is authorized but no evidence snapshot exists yet.
- `BLOCKED`: evidence/configuration/runtime integrity failed. No receipts are released.
- `STALE`: valid evidence changed or disappeared while execution was in flight. No receipts are released.
- `RELEASED`: the exact local suite completed under unchanged authorization/evidence and the receipts are returned to the caller.

`RELEASED` is an execution/integrity statement. It does not guarantee rankings, indexation, traffic, leads, clients, revenue, policy immunity or legal compliance.

## Process isolation

The Node sidecar launches only the repository-local Python bridge `sidecar/execute_suite.py` as the `sidecar.execute_suite` module with `shell: false`. The Python bridge imports the existing deterministic `runtime.runner.run_batch_1001_2500()` function. It does not implement a second SEO engine.

The child process receives only two JSON objects over stdin: the already-validated evidence payload and the factual configuration object. The worker enforces an execution timeout and a maximum stdout size. The suite output is validated again before release.

The current CLI writes the final envelope to stdout only. There is deliberately no result database, outbox, cloud sink or client-site write in this PR. A later result-persistence layer must define its own atomic/durable publication contract before production use.

## CLI

```bash
node seo-avengers-2500/scripts/seo-avengers-2500-sidecar.mjs \
  --control-root /trusted/avengers-control \
  --evidence-root /trusted/avengers-evidence \
  --site-id example-tenant \
  --config /trusted/config/example-tenant.json
```

The configuration file is optional and defaults to `{}`. It must remain factual tenant configuration; it is not a source of fabricated provider observations.

## Current activation state

This PR does not create or enable a tenant. It does not activate CANO or Nexus Bot Studio. No site is connected merely because this worker exists in the repository.

The intended next integration stage is a controlled Nexus Bot Studio canary after this worker is merged, with observability/alerting and an independently tested hot-disable path before any CANO read-only activation.

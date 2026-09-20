# FORJA job inspection and local observer

This increment does **not** deploy an always-on service, authenticate GitHub runners, audit unregistered Nexus source, authorize production writes, or make the job store tamper-proof against its filesystem owner. The existing single-host durable worker remains read-only.

## Inspect an existing job

On the **same clean Git checkout** at the job's recorded SHA, inspect the immutable source-byte evidence again:

```sh
node forja/state-inspector.mjs "$(pwd)" /absolute/private/forja-state JOB_UUID
```

A successful result reports four validated evidence files and a positive `checkedSourceBytes` count. If the checkout differs, an artifact is missing/extra, report identity is wrong, or recomputed source bytes disagree, inspection exits nonzero. A queued/failed/interrupted job may pass **structural inspection only**, with `checkedSourceBytes: null`; it is never reclassified as a successful execution. Inspection reads but never repairs or replays jobs.

## Read-only local status

Provision a separate private host and process supervisor if this must run continuously. Supply a separately generated 32–256 byte bearer token from your secret store; do not commit it, expose it in URLs or proxy the plain HTTP port to the internet.

```sh
FORJA_STATUS_TOKEN="$(openssl rand -hex 32)" node forja/observe.mjs "$(pwd)" /absolute/private/forja-state 8765
```

The process binds **only** `127.0.0.1`. Authenticate requests with `Authorization: Bearer <token>` to `GET /v1/health`, `GET /v1/jobs`, or `GET /v1/jobs/JOB_UUID`. Every other method is rejected; no submit, replay, recovery, Git mutation, deployment, or merge endpoints exist. The detailed job endpoint performs read-only inspection, including source-byte recomputation for SUCCEEDED jobs, and returns a generic error on corrupted evidence. Status list is a lightweight unverified snapshot. Local loopback and bearer authentication are not TLS, multi-host coordination, external uptime monitoring, or a production deployment.

CI runs the inspector against a **real four-step durable job** and separately tests token isolation, read-only methods, corrupted records, path validation, and unexpected artifacts. These proofs cover only the registered FORJA subset; do not extrapolate them to all of Nexus or GAUSS 100.

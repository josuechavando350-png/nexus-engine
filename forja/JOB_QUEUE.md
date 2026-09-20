# FORJA local durable evidence jobs — bounded operational slice

Node 24 + Git, POSIX filesystem. This is executable, single-host, **read-only evidence work**, not a deployed 24/7 service, distributed scheduler, autonomous coding agent, certification of all engines or production control plane. There are no arbitrary commands, provider tokens, auto-merges, deploys or data migrations. The fixed job runs actual `inventory.mjs`, `audit.mjs`, `contract-probe.mjs` and `evidence-gate.mjs` against one **clean** Git checkout. The final gate verifies the registered source-file bytes. Sources not in `registry.json` remain NOT_AUDITED.

Create an **absolute, private state directory outside the repository** (e.g., `/var/lib/forja/evidence`, mode 0700). On the trusted local host, from the repository root:

```sh
node forja/job-queue.mjs submit /var/lib/forja/evidence
node forja/job-queue.mjs run /var/lib/forja/evidence
node forja/job-queue.mjs status /var/lib/forja/evidence
node forja/job-queue.mjs serve /var/lib/forja/evidence
```

`serve` polls once a second until SIGTERM/SIGINT, finishing the active job before stopping. Running it permanently requires **your own** process supervisor and provisioned host; this PR does not install, start or monitor that host. `run` executes at most one pending job. `status` can optionally take a UUID after the directory. A submitted job binds to the exact HEAD SHA; if HEAD moves before execution the job becomes STALE and is never silently rerun. If any stage fails, the job becomes FAILED and the next stage is not invoked. Evidence and JSON state are written atomically to the external directory with private modes and fsync. Each stage's successful report persists separately. This is **local crash recovery**, not a transactional database or signed provenance.

A worker owns an exclusive on-disk lock. After a crash, a RUNNING job is **not retried automatically**. Inspect the host and then, only if the lock owner is dead on the same hostname, run `node forja/job-queue.mjs recover /var/lib/forja/evidence` to mark affected jobs INTERRUPTED and clear the stale lock. Submit a **new** job to run again. If the lock metadata is missing/invalid or the PID may have been reused, fail closed and inspect manually; never delete a live worker's lock. Do not run this on shared/NFS storage or expose its directory to untrusted users. Full power-loss, physical durability, multi-host HA, policy authorizations, output authentication, alerting and periodic scheduling require further work.

The read-only CI workflow runs ten adversarial/fault-path tests and an actual job on its exact PR SHA. It asserts all four fixed stages and the final five registered byte proofs before recording bounded artifacts. This does not imply complete engine coverage or an independently audited software supply chain.

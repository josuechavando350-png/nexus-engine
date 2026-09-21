# FORJA local durable evidence jobs — bounded operational slice

Node 24 + Git, POSIX filesystem. This is executable, single-host, **read-only evidence work**, not a deployed 24/7 service, distributed scheduler, autonomous coding agent, certification of all engines or production control plane. There are no arbitrary commands, provider tokens, auto-merges, deploys or data migrations. The fixed job runs actual `inventory.mjs`, `audit.mjs`, `contract-probe.mjs` and `evidence-gate.mjs` against one **clean** Git checkout. The final gate verifies the registered source-file bytes. Sources not in `registry.json` remain NOT_AUDITED.

Create an **absolute, private state directory outside the repository** (e.g., `/var/lib/forja/evidence`, mode 0700). On the trusted local host, from the repository root:

```sh
node forja/job-queue.mjs submit /var/lib/forja/evidence
node forja/job-queue.mjs run /var/lib/forja/evidence
node forja/job-queue.mjs status /var/lib/forja/evidence
node forja/job-queue.mjs serve /var/lib/forja/evidence
```

`serve` polls once a second until SIGTERM/SIGINT, finishing the active job before stopping. Running it permanently requires **your own** process supervisor and provisioned host; this module does not install, start or monitor that host. `run` executes at most one pending job. `status` can optionally take a UUID after the directory. A submitted job binds to the exact HEAD SHA; if HEAD moves before execution the job becomes STALE and is never silently rerun. If any stage fails, the job becomes FAILED and the next stage is not invoked. Evidence and JSON state are written atomically to the external directory with private modes and fsync. Each stage's successful report persists separately. This is **local crash recovery**, not a transactional database or signed provenance.

## Crash recovery is a manual safety boundary

A worker owns an exclusive on-disk lock. It durably records the process-group ID of each detached step when it starts. If the parent is killed, its detached step or a grandchild **may still be running**. An absent parent PID is never sufficient proof that the children exited; there is also a small spawn-to-fsync window where no child group has yet been recorded. After a crash, a RUNNING job is **not retried automatically**, and `recover` without an explicit confirmation refuses to clear the lock.

On the **same Linux host**, stop the supervisor so it cannot restart FORJA, identify the former worker and any surviving detached child/grandchild processes (including any recorded `activeGroupPid` in the private `worker.lock/owner.json`), and verify that all of them have exited. Inspect the actual process tree and process groups, not just the parent's PID. Do not claim clearance when any process identity is ambiguous, when metadata is missing, or after a reboot without understanding which processes may have persisted. Only after the operator has genuinely checked, run:

```sh
node forja/job-queue.mjs recover /var/lib/forja/evidence --confirmed-no-surviving-children
```

This explicit flag is an **operator assertion, not automated evidence of no children**. Recovery also probes the last recorded detached process group on Linux and refuses to clear the lock if it is alive or its liveness cannot be checked. It rejects a still-live worker and foreign-host locks even with the flag. Incomplete jobs become `INTERRUPTED` and are never silently replayed; submit a new job only after the recovery has finished. If the lock metadata is missing or invalid, the owner PID may have been reused, or the process group cannot be verified, fail closed and investigate. Do **not** manually delete the lock to bypass these checks. Do not run this on shared/NFS storage or expose its directory to untrusted users.

The read-only CI workflow runs adversarial/fault-path tests and an actual job on its exact PR SHA. It asserts all four fixed stages and the final five registered byte proofs before recording bounded artifacts. This does not imply complete engine coverage, physical durability, reliable operator clearance, power-loss recovery, multi-host HA, policy authorizations, output authentication, alerting, periodic scheduling, or an independently audited software supply chain.

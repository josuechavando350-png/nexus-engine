# FORJA on a Linux computer you control (no paid host)

FORJA can run using **your own persistent Linux computer**. This is an operator procedure, not an installer, remote access mechanism, or evidence that any such computer has been provisioned. It adds no commercial API, paid service, npm package or external credentials. Linux, Git and Node.js 24 are existing free software dependencies; they are not authored by FORJA. A GitHub Actions Ubuntu runner and the ChatGPT execution container are **temporary** and cannot substitute for your own persistent host.

Requirements: a non-root dedicated local account, a clean checked-out repository at the **exact Git SHA you intend to audit**, Node.js 24+, and four **different**, private (`0700`) owner-only absolute directories outside the checkout: `state`, `backup`, `receipts`, `keys`. Keep the keys out of backups and the checkout. An existing computer may be used; no server purchase is required. The preflight does not create directories, install software, change permissions, access secrets or start any process.

Under that dedicated account, substitute actual local paths and the exact 40-character checkout SHA:

```sh
node forja/host-preflight.mjs /absolute/repo /absolute/private/state /absolute/private/backups /absolute/private/receipts /absolute/private/keys EXPECTED_SHA
node forja/job-queue.mjs status /absolute/private/state
node forja/job-queue.mjs serve /absolute/private/state
```

The preflight fails closed for an unsupported host/runtime, root user, dirty checkout, wrong source revision, symlinks/public or overlapping storage roots, worker lock or less than 128 MiB/100 free inodes on checked state and backup volumes. The space check is a **minimal preflight**, not a workload capacity guarantee. `serve` processes only four fixed evidence stages (inventory, audit, contract and consistency). It does not perform repairs, merges, arbitrary shell commands or production deployments. `serve` stays attached to its terminal; you must configure your own supervision and restart policy if desired, after operational review.

For backups, **stop `serve` and all job submitters and approval redeemers first**; confirm each has exited before invoking the offline snapshot. Follow [STATE_BACKUP.md](STATE_BACKUP.md) and [SIGNED_BACKUP.md](SIGNED_BACKUP.md). Never delete an ambiguous worker lock to force backup. After crash, use the documented explicit `recover` command only after independently verifying the owner died. **Never automatically restart interrupted jobs or replay old human-approval nonces**. A correct Ed25519 signature does not prove freshness; recovered state stays quarantined until an independently retained monotonic record is reconciled or all previous nonces are retired and fresh human approvals obtained.

The preflight cannot prove the machine persists across reboots, that the disks are independent, that hardware won't fail, that backup and key data are secure from the host administrator, that permissions cannot change later, or that production deployment is authorized. No production host, RPO/RTO, offline independent approval key, operator custody, off-host disaster recovery, backup retention schedule, or monitored supervisor is provisioned by this change. These require real-host acceptance evidence and explicit human decisions, **not just CI green**.

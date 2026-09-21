# FORJA offline state snapshot and restore

`forja/state-backup.mjs` creates a bounded, SHA-256-checked **offline** snapshot of the local FORJA queue, four-stage reports and one-time approval redemption receipts, without reading or modifying the source checkout. Node 24, local POSIX filesystem and a private service account are required. It is **not** a running backup service, a remote disaster-recovery system, a database transaction or an independently signed attestation.

**Stop FORJA's `serve` process and every process that can submit jobs or redeem approvals; verify all have exited before taking a snapshot.** Absence of `worker.lock` is checked but it does not fence a concurrent submitter or redeemer. Do not use the snapshot command while writers are active. Never remove a live or ambiguous worker lock to force a snapshot. Place the state and backup roots in separate absolute, owner-only (`0700`) directories outside the checkout, on storage you control. Keep the backup root outside the state root. This tool supports no more than 10,000 files, 2 MiB per file and 64 MiB total, and refuses unknown files, symlinks, public directories and ambiguous worker locks rather than omitting evidence. It requires regular files to have one hard link and private permissions.

After stopping all writers, create and verify a snapshot (replace paths with your private directories):

```sh
node forja/state-backup.mjs create /var/lib/forja/evidence /var/lib/forja/backups
node forja/state-backup.mjs verify /var/lib/forja/backups SNAPSHOT_UUID
node forja/state-backup.mjs restore /var/lib/forja/backups SNAPSHOT_UUID /var/lib/forja/recovered-new
```

`create` copies the exact job, artifact and redemption bytes to a private staging directory, fsyncs file contents and directories, rechecks source bytes, then atomically publishes the snapshot directory and its manifest. `verify` checks every file, its length and SHA-256 against a sorted manifest and rejects missing, additional or malformed paths. `restore` verifies first and writes a separate new private state directory; it never intentionally overwrites an existing target or automatically starts jobs. Inspect the recovered jobs and reports independently using the existing state inspector. Compare the retained source revision to the checkout before any new work.

**Replay hazard:** restoring an older snapshot can erase knowledge of approvals consumed after that snapshot, so restored redemption receipts are *not* a fresh authority to approve, merge or deploy anything. Treat the recovered state as quarantined evidence until an operator reconciles it against an independently retained monotonic redemption log or trust anchor. Until one exists, retire all previous approval nonces and obtain fresh human approvals. Never silently resume `RUNNING` or replay interrupted jobs. A malicious actor able to replace both snapshot bytes and their manifest can produce a self-consistent forgery; SHA-256 alone does not authenticate the backup. Off-host encrypted storage, immutable retention, tested host provisioning, protection against storage rollback, and defined RPO/RTO remain separate work.

CI tests corruption, malicious paths, symlinks, locks, permissions, duplicate restore, and real four-stage job round-trip on the exact PR SHA with ephemeral fixture data. It does not provision a production host or operator keys.

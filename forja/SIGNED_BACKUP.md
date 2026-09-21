# FORJA: independent-key signed offline snapshots

The optional `forja/signed-backup.mjs` binds a verified **offline** state snapshot to an Ed25519 signature produced with an operator-controlled private key. Verification requires a public key **and its independently retained SHA-256 SPKI fingerprint**. This uses Node's built-in cryptography; no hosted key service, paid API or additional npm dependency is required. It works on a private local POSIX filesystem with Node 24. A signature authenticates the signed manifest *relative to the separately trusted key*. It does **not** prove the host was uncompromised, the source code was audited, the snapshot is the latest snapshot or restored approvals remain valid.

**Before every snapshot, stop the worker and all submitters/redeemers.** See [STATE_BACKUP.md](STATE_BACKUP.md) for the quiescence, file limits and recovery requirements. Snapshot and receipts roots must be different private, owner-only (`0700`) absolute directories. Store the private key outside the checkout, backup and receipts roots in another private directory; do not upload or commit it. Keep the public key and its fingerprint in a separately trusted location; a public key bundled with an untrusted backup is not an independent trust anchor.

For an **example only**, generate a new backup-only Ed25519 keypair locally in a private directory that already exists and is `0700` (never reuse approval-signing keys):

```sh
node --input-type=module -e '
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[1];
const pair = generateKeyPairSync("ed25519");
writeFileSync(join(dir, "private.pem"), pair.privateKey.export({type:"pkcs8",format:"pem"}), {flag:"wx",mode:0o600});
writeFileSync(join(dir, "public.pem"), pair.publicKey.export({type:"spki",format:"pem"}), {flag:"wx",mode:0o600});
console.log(createHash("sha256").update(pair.publicKey.export({type:"spki",format:"der"})).digest("hex"));
' /absolute/private/key-directory
```

Retain the printed fingerprint independently from the snapshot, receipts and key-directory contents. Substitute your own private paths and actual ID/fingerprint:

```sh
node forja/state-backup.mjs create /absolute/private/state /absolute/private/backups
node forja/signed-backup.mjs sign /absolute/private/backups SNAPSHOT_UUID /absolute/private/key-directory/private.pem /absolute/private/receipts
node forja/signed-backup.mjs verify /absolute/private/backups SNAPSHOT_UUID /absolute/private/receipts /absolute/private/key-directory/public.pem PINNED_SHA256_SPKI
node forja/signed-backup.mjs restore /absolute/private/backups SNAPSHOT_UUID /absolute/private/receipts /absolute/private/key-directory/public.pem PINNED_SHA256_SPKI /absolute/private/recovered-new
```

In the commands, `PINNED_SHA256_SPKI` means a single 64-character lowercase hexadecimal SHA-256 fingerprint (without any spaces). `sign` atomically creates one private receipt at `receipts/SNAPSHOT_UUID.json` with `O_EXCL` and fsync; it cannot overwrite a previously issued receipt. `verify` refuses an untrusted key, malformed/altered receipt, broken signature, forged manifest, changed bytes or unexpected files. `restore` re-checks the signed manifest hash on the bytes used to populate an **absent** recovery directory, and does not launch the worker. Retain the signing key offline between signing operations if possible.

**Never resume or replay based on restored approval receipts.** An old, correctly signed snapshot is still old: an attacker who can roll storage back can remove knowledge of nonces consumed since the backup, and a signed snapshot cannot detect that on its own. Quarantine recovered state; reconcile against an independent monotonic record or retire all earlier approval nonces and request fresh approvals. There is no production host, independently provisioned key, off-host backup or automated freshness/rollback guarantee in this implementation. CI tests use ephemeral keys and offline files, not operational credentials.

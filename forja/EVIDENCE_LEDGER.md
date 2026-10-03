# FORJA local evidence ledger (incremental capability)

`forja/evidence-ledger.mjs capture` runs the **real** inventory, audit and bounded GAUSS→classical-Quantum report verifier against one clean Git revision, then runs the existing real WALLE→GAUSS→AXIOMA adapter and its replay verifier. Only a `CONSISTENT` source-byte report and a `PASS` WALLE chain bound to the same source revision can enter the local ledger.

On a Node 24 checkout, from the repository root:

```sh
export FORJA_SOURCE_SHA="$(git rev-parse HEAD)"
node forja/inventory.mjs > /tmp/forja-inventory.json
node forja/audit.mjs > /tmp/forja-audit.json
node forja/contract-probe.mjs > /tmp/forja-contract.json
node forja/evidence-ledger.mjs capture /tmp/forja-inventory.json /tmp/forja-audit.json /tmp/forja-contract.json /tmp/forja-ledger
node forja/evidence-ledger.mjs verify /tmp/forja-ledger sha256:<id-from-capture>
```

The store must be an **absolute directory outside the repository**. Each record is keyed by SHA-256 of its JSON payload, written into a private temporary file, synced and atomically published via a hard link that cannot overwrite an existing record. Concurrent identical writes converge; corruption, a partial file or a symlink causes verification to fail rather than silently replacing the record. The read path recomputes the digest and checks source identity and the bounded evidence shape. No engine or production files are modified.

**Limitations:** Hashes detect incidental or partial tampering, but an attacker able to rewrite both the records and their identifiers can forge a new record. Neither workflow identity nor runner integrity is signed or independently attested. The exported `persistLedgerRecord` helper validates the structure of supplied reports; only the `capture` CLI generates and verifies the actual reports. GitHub-hosted runners use ephemeral storage; the example workflow uploads an artifact retained for 30 days, which is **not** a durable self-hosted service or backup. Atomic hard-link publication requires a filesystem supporting hard links. There is no remote replication, authentication, scheduling, repair, deployment permission, physical QPU execution, or all-repository certification; unregistered sources remain `NOT_AUDITED`.

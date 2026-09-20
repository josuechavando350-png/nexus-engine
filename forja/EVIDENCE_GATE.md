# FORJA cross-report consistency gate

Run from an exact, clean Git checkout with Node 24:

```sh
export FORJA_SOURCE_SHA="$(git rev-parse HEAD)"
node forja/inventory.mjs > /tmp/forja-inventory.json
node forja/audit.mjs > /tmp/forja-audit.json
node forja/contract-probe.mjs > /tmp/forja-contract.json
node forja/evidence-gate.mjs /tmp/forja-inventory.json /tmp/forja-audit.json /tmp/forja-contract.json
```

The dedicated GitHub Actions workflow runs all three real tools on **one exact commit** in a clean checkout, and emits four evidence JSON files outside the repository. The gate rejects absent reports, mixed source revisions, unsuccessful reports, inconsistent registered-source counts, incomplete declared-link coverage and a missing bounded GAUSS-to-classical-Quantum receipt. It returns 0 only for `CONSISTENT`, 1 for findings and 2 for invalid input or an execution error. Adversarial tests cover these failure modes.

`CONSISTENT` is **not** authentication, a signed attestation, complete coverage, production approval, formal verification or permission to deploy. The gate does not independently rehash all repository bytes, and the JSON files could be forged. Source files outside the five-node registry remain **NOT_AUDITED**. No engine is modified and no repair or deployment occurs.

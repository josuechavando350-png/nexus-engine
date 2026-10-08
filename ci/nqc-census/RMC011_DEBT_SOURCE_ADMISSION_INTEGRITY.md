# RMC-011 — Debt-family real-source promotion integrity

This is **a terminal-admission correctness repair, not a D11 capital certification**. The original two debt families (`COLLATERALIZED_BORROWING`, `PERSISTENT_DEBT`) remain unresolved in the unchanged source-universe lock. There are still zero NQC-approved external gas providers.

## Original defect

In `verify-rmc011-debt-family-promotion.py`, when both debt rows had status `AUTHENTICATED_REAL_SOURCE`, the code returned `AUTHENTICATED_REAL_SOURCE_PATH` without checking `terminally_resolved`, the canonical implementation path or even a `resolution_evidence` object. A minimal forged pair of status strings could therefore obtain a positive helper-level promotion result. The upstream universal gate was stricter, but this reusable helper was fail-open if called independently.

## Correction

- Validate schema 2, unique family identities, the D11 non-closeout flag, and atomicity of the two debt-family outcomes.
- For the real-source route, demand `terminally_resolved=true`, exact canonical implementation path, correct per-family `AUTHENTICATED_REAL_SOURCE` evidence kind, producing workflow and repository, positive integer run/artifact IDs, SHA-1 head identity, nonzero SHA-256 ZIP and member hashes, exact per-family member path, unique file hashes, and common GitHub run/artifact transport for both families.
- Hard-reject all-zero hashes in the preexisting rejection route too.
- A successful *syntactic* wiring report is called `AUTHENTICATED_REAL_SOURCE_REFERENCES_DECLARED` and explicitly says `independent_artifact_authentication_complete=false` and `d11_terminal_closed=false`. Only the separate production workflow can authenticate actual GitHub Actions bytes and source provenance.
- Preserve the existing status of all 13 families in the canonical source-universe; this patch only rejects false promotion.

## Adversarial coverage

The original six tests plus 21 new tests cover missing witnesses, bare statuses, boolean IDs, wrong repository/workflow, missing canonical path, mismatched terminal flags, corrupted/duplicated/zero hashes, mismatched artifact transports, mixed outcomes, duplicate family identities, source schema, and attempts to self-close D11. Synthetic test witnesses **are not real capital**.

## Reproduction

From the exact feature head, run:

    python3 ci/nqc-census/test_verify_rmc011_debt_family_promotion.py -v
    python3 ci/nqc-census/verify-rmc011-debt-family-promotion.py
    python3 ci/nqc-census/verify-rmc011-capital-source-universe.py

The specialized GitHub Actions workflow also checks the pinned Git blob identity of the unchanged canonical RMC-011 capital universe, provider registry, and final-Census authority lock. It must remain **blocked**: 13 unresolved families, 0 authorized external providers, and no terminal Census closeout. No RPC requests, accounts, payments, wallet signing, or live trades.

## Outstanding material blockers

Authenticated 13-family capital discovery/resolution and *actual* nonrecourse native-gas underwriting are still required before D11 can close. D12 full actionability, D13 executable economics, D14 eight genuine stage pins, D15 temporal completeness, D16 conservative economics and D17 independent final adjudication remain separate. A negative terminal Census is allowed only when scope completeness and source authorities actually support it.

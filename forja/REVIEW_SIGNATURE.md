# FORJA detached review signatures

`forja/review-signature.mjs` implements a narrowly scoped, **read-only review-signature verifier** for content-addressed evidence records. The operator, not FORJA or GitHub Actions, creates and safeguards a private **Ed25519** key. The operator's independently configured public key is the trust anchor; the signature covers the exact ledger record ID, source commit, Git tree, action `REVIEW_MERGE`, UTC issuance/expiry (maximum 24 hours) and a 128-bit nonce. The verifier refuses a different public key, expired signature, mismatched commit/tree, modified fields, non-Ed25519 keys and any action including `DEPLOY_PRODUCTION`.

To use on a clean checkout with Node 24, first generate and **securely retain** a private signing key outside the repository, with owner-only filesystem permissions, and configure the corresponding trusted public key outside the checkout. The following commands do not generate or store an operator key for you:

```sh
node forja/review-signature.mjs sign-review /absolute/ledger sha256:<record-id> /absolute/operator-private.pem /absolute/review.json
node forja/review-signature.mjs verify-review /absolute/ledger sha256:<record-id> /absolute/review.json /absolute/trusted-public.pem
```

The signing CLI requires an explicit invocation and refuses a private key accessible to group or other users. It creates a new 0600 envelope file without overwriting any existing file. The verification CLI checks the ledger record's local hash and the current clean Git HEAD/tree, and returns `SIGNATURE_MATCH_REVIEW_ONLY` if the independently supplied public key verifies the detached signature. No private key, signature, or public key is committed. CI generates **ephemeral fixture keys only** to exercise cryptography and adverse cases; CI signatures are not operator approvals.

**Important boundaries:** This is not connected to the repository's GitHub reviewer identity, branch protection, production deployment system, or a one-time replay registry. It authenticates possession of the configured private key, not the truth of evidence or the authority of an arbitrary public key. Operator key enrollment/rotation, revocation, secure host storage and protected branch rules must be configured separately. It does **not** merge PRs, deploy, authorize self-repair, or provide production approval. The local evidence ledger itself is not a signed attestation unless a separately trusted operator reviews and signs its specific record.

# NEXUS signing decision

Status: DECISION REQUIRED BEFORE IMPLEMENTATION.

## Option A — Sigstore/cosign keyless (recommended for current scale)

For a one-person studio with small-client deployments, prefer identity-based signing through GitHub Actions OIDC. Cosign creates an ephemeral key, Fulcio binds it to the workflow identity with a short-lived certificate, and the signing event is recorded in Rekor. There is no long-lived private signing key for the studio to store, back up, rotate, leak or lose.

Operational requirements:
- GitHub Actions workflow receives `id-token: write` only in the dedicated signing job.
- Verification pins the expected repository/workflow identity and OIDC issuer.
- The detached Sigstore bundle travels with the exact Quality Passport bytes.
- Verification uses the Sigstore trust root and transparency inclusion material.

Trade-offs:
- Lowest key-management burden and strongest public auditability for our scale.
- Depends on the Sigstore/Fulcio/Rekor/TUF trust ecosystem and on stable workflow identity policy.
- Transparency metadata is intentionally public.
- Offline verification requires retaining the bundle and required trust material/tooling.

## Option B — non-exportable KMS/HSM key + GitHub OIDC

The signing job authenticates to the cloud KMS/HSM via GitHub OIDC. The private key is generated and remains non-exportable. CI receives permission to invoke `sign`, never to read/export key material. Public keys and key IDs are distributed to verifiers; old public keys remain available for historical verification after rotation.

Trade-offs:
- Strong private trust-domain control, explicit revocation/rotation policy and less public signing metadata.
- More operator burden: cloud account, IAM policy, KMS cost, key lifecycle, disaster recovery and provider coupling.
- Losing the private key does not invalidate already-issued signatures when old public keys are retained, but it prevents future signing with that identity. Compromise requires revocation and incident handling.

## Recommendation

Use **Sigstore/cosign keyless** for NEXUS at the current scale. It removes the highest-risk operational task for a one-person studio: custody of a long-lived release key. Revisit KMS/HSM only if customers require a private PKI/trust domain, offline signing, contractual key custody, or cloud-managed compliance controls.

No production signing command is enabled until the owner explicitly selects the model.

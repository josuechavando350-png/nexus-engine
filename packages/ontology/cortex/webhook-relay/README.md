# CORTEX #11 — Low-Latency Webhook Relay with Consent Guardrails

CORTEX #11 provides a durable outbound webhook relay for already-approved event contracts. It defaults to `KILLED`, requires explicit consent semantics, accepts only explicitly hashed user identifiers, and quarantines uncertain delivery outcomes instead of replaying them automatically.

## Production configuration

The runtime requires:

- `NEXUS_CORTEX_11_DATABASE` — absolute SQLite path shared by the durable relay ledger and durable control ledger.
- `NEXUS_CORTEX_11_ENDPOINT` — fixed HTTPS destination URL without embedded credentials.
- `NEXUS_CORTEX_11_BEARER_TOKEN_FILE` — absolute path to the outbound bearer-token file.
- `NEXUS_CORTEX_11_SIGNING_SECRET_FILE` — absolute path to the HMAC signing-secret file, at least 32 characters.
- distinct `NEXUS_CORTEX_11_INGEST_TOKEN` and `NEXUS_CORTEX_11_CONTROL_TOKEN` for the local production server.
- optional `NEXUS_CORTEX_11_TIMEOUT_MS`, `NEXUS_CORTEX_11_HOST`, and `NEXUS_CORTEX_11_PORT`.

The outbound bearer and signing files are reread for every dispatch. An external secret/credential agent can therefore rotate those files without requiring a CORTEX restart. No production credential or customer identifier belongs in the repository.

## Mode semantics

`KILLED` rejects ingestion before durable preparation. `OBSERVE_ONLY` validates the exact event and consent contract but persists nothing and sends nothing; only digests and coarse metadata are returned. `ACTIVE` performs durable preparation, rechecks the durable mode immediately before the outbound side effect, signs the canonical body with HMAC-SHA-256, and sends it to the fixed HTTPS destination.

A deterministic remote 4xx response is a rejected request and remains `PENDING` for operator correction. Transport uncertainty, 5xx responses, or a success response without a valid receipt become `AMBIGUOUS`; such events are never automatically replayed. Safety rollback can cancel only a `PENDING` event.

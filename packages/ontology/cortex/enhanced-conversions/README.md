# CORTEX #10 — Enhanced Conversions & Data Manager Pipeline

This module is a production boundary for consent-aware conversion ingestion. It is fail-closed by default and does not contain production credentials or customer identifiers.

## Production activation

The runtime starts in `KILLED` because the durable control record does not exist until an authorized operator changes it. Production wiring requires:

- `NEXUS_CORTEX_10_DATABASE` — absolute SQLite path.
- `NEXUS_CORTEX_10_TENANT_ID`, `NEXUS_CORTEX_10_ORGANIZATION_ID`, optional `NEXUS_CORTEX_10_BRAND_ID`.
- `NEXUS_CORTEX_10_OPERATING_ACCOUNT_ID`, `NEXUS_CORTEX_10_CONVERSION_ACTION_ID`, optional `NEXUS_CORTEX_10_LOGIN_ACCOUNT_ID`.
- `NEXUS_CORTEX_10_ACCESS_TOKEN_FILE` — absolute path to a bounded regular file containing the current Google OAuth access token. The file is reread for every dispatch so an external credential agent can rotate tokens without restarting CORTEX.
- distinct `NEXUS_CORTEX_10_INGEST_TOKEN` and `NEXUS_CORTEX_10_CONTROL_TOKEN`.
- optional `NEXUS_CORTEX_10_DATA_MANAGER_TIMEOUT_MS`, `NEXUS_CORTEX_10_HOST`, `NEXUS_CORTEX_10_PORT`.

No access token, Google Ads account ID, conversion action ID, raw email, or raw phone number is committed to the repository.

## Runtime behavior

`KILLED` rejects event ingestion before durable preparation. `OBSERVE_ONLY` validates the exact input contract and returns only digests and coarse metadata; it performs no durable outbox mutation and no Google Data Manager request. `ACTIVE` prepares a durable hashed outbox record, rechecks control immediately before the external side effect, and then calls the Google Data Manager REST ingestion boundary.

Transport timeout or an otherwise uncertain remote outcome becomes `AMBIGUOUS`; that transaction is not automatically replayed. Only a `PREPARED` transaction can be cancelled by rollback.

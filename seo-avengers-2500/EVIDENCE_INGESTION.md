# SEO Avengers 2500 — Read-only Evidence Ingestion

This layer is intentionally out of band from every client request path. It does not crawl a website, call Google, write to a client project, enqueue work, run SEO modules, publish results, or mutate the tenant control plane.

Its only job is to accept an already-published, tenant-isolated evidence snapshot from a trusted upstream collector and expose validated datasets to a future sidecar worker.

## Authorization comes first

Evidence is never read for an unauthorized tenant.

`readTenantEvidenceSnapshot()` first reads the tenant control plane. Missing, disabled, killed, malformed, stale or corrupt control state returns `OFF`. Only a tenant with an integrity-valid current generation and `enabled=true`, `kill_switch=false` may proceed to evidence ingestion.

After all evidence bytes are read and verified, the control plane is read again. If authorization changed or the generation moved while the snapshot was being read, the result is not released as `READY`.

This does not replace the future worker rule: the worker must still recheck the captured tenant generation immediately before execution and immediately before publishing a result.

## Filesystem layout

The evidence root is separate from the writable control authority:

```text
<evidence-root>/tenants/<site-id>/manifest.json
<evidence-root>/tenants/<site-id>/search_performance_records.json
<evidence-root>/tenants/<site-id>/content_documents.json
...
```

The reader never creates or modifies these files.

The evidence root, `tenants/` directory and tenant directory must be real canonical directories. Symlinked directory paths are rejected. Manifest and dataset files must be regular canonical files. Unexpected files, directories or symlinks inside the tenant snapshot fail closed.

The future collector must publish snapshots into this root without giving the SEO Avengers worker or client-serving processes write permission to the collector's source data.

## Manifest contract

`manifest.json` has exactly these fields:

```json
{
  "schema_version": 1,
  "site_id": "tenant-id",
  "control_generation": 7,
  "datasets": [
    {
      "key": "search_performance_records",
      "file": "search_performance_records.json",
      "sha256": "sha256:<64 lowercase hex>"
    }
  ]
}
```

`control_generation` must equal the currently authorized control-plane generation. This prevents evidence captured under an older enable/kill state from silently becoming current after a later control mutation.

Each descriptor is unique by dataset key. Its filename is fixed to `<dataset-key>.json`; arbitrary relative paths and nested paths are not accepted. Every declared dataset file must exist, every byte digest must match the manifest, and no undeclared file may be present.

Dataset payloads are JSON arrays because the 2500 suite consumes record collections. The ingestion layer verifies only the transport/integrity envelope; module-specific semantic validation remains in the deterministic SEO Avengers runtime. Empty arrays are valid transport and allow downstream modules to produce `INSUFFICIENT_DATA` instead of invented observations.

## Allowed existing dataset contracts

The reader accepts only the evidence contracts already declared by the 2500 suite:

- `search_performance_records`
- `content_documents`
- `local_business_records`
- `content_decay_records`
- `revenue_funnel_records`
- `revenue_attribution_records`
- `keyword_coverage_records`
- `traffic_window_records`
- `traffic_series_records`
- `upstream_evidence`
- `search_intent_records`
- `canonicalization_records`
- `persistence_state_records`
- `edge_gateway_records`
- `cwv_edge_records`
- `policy_audit_records`
- `semantic_text_records`

Unknown dataset names fail closed. This ingestion PR does not invent a new provider dataset or manufacture missing evidence.

## Result states

- `OFF`: tenant control authority does not permit ingestion.
- `INSUFFICIENT_DATA`: authorized tenant has no published evidence snapshot yet. This is absence, not corruption.
- `BLOCKED`: evidence root, manifest, tenant binding, control generation, file set, symlink policy, JSON transport or SHA-256 integrity is invalid/unreadable.
- `READY`: the snapshot is transport-valid, tenant-bound, generation-bound and digest-valid. `READY` does not mean that every SEO module has enough evidence or that any ranking/indexation/business outcome is guaranteed.

## Trust boundary

The SHA-256 file digests prove that bytes match the trusted manifest supplied by the collector. They are not a signature against an attacker who can rewrite the entire evidence root and recompute the manifest.

The operational boundary therefore requires:

- client/request-serving processes: no write access to `controlRoot` or `evidenceRoot`;
- future worker: no write access to `controlRoot` and read-only access to published evidence;
- future collector: evidence publication authority only, never control-plane authority;
- control-plane writer: control authority only, not a source of fabricated SEO evidence.

Cross-tenant directory reuse is forbidden. A manifest whose `site_id` differs from the requested tenant is rejected.

## Current scope

This layer still does not connect SEO Avengers to CANO or Nexus Bot Studio. There is no collector, scheduler, queue, daemon, worker or automatic action plane in this PR. A later PR will build the sidecar worker against this read-only boundary and the tenant authorization contract.

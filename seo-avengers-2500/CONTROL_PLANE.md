# SEO Avengers 2500 — Tenant Control Plane Contract

This control plane is intentionally separate from the Nexus site request path.

It does **not** deploy SEO Avengers to any tenant, does not crawl a site, does not enqueue work, does not modify HTML, and does not connect to CANO or Nexus Bot Studio. It only defines the authority that future collectors/workers must consult.

## Default state

Activation is deny-by-default.

- Missing tenant state: OFF.
- Disabled tenant: OFF.
- Emergency kill switch active: OFF.
- Malformed or tampered state history: OFF.
- Missing, stale, malformed, or tampered high-water mark: OFF.
- Interrupted high-water update marker: OFF.
- Unreadable control root: OFF.
- Invalid tenant id: OFF.
- Only an integrity-valid latest generation whose durable high-water mark matches it and has `enabled=true` and `kill_switch=false` is ON.

There is no source-controlled tenant that ships ON.

## Append-only tenant journal

Each tenant has an isolated append-only history:

```text
<control-root>/tenants/<site-id>/00000000000000000001.json
<control-root>/tenants/<site-id>/00000000000000000002.json
...
<control-root>/tenants/<site-id>/.hwm.json
```

Every generation record binds:

- tenant id;
- generation;
- enabled state;
- emergency kill-switch state;
- previous record hash;
- its own SHA-256 state hash.

The reader verifies the complete chain. A generation gap, cross-tenant record, malformed JSON, hash mismatch, or previous-hash mismatch fails closed.

The `.hwm.json` high-water mark binds the highest accepted generation to that generation's `state_hash`. The reader requires the high-water mark whenever a tenant journal exists. A missing journal with an existing high-water mark, a missing high-water mark with an existing journal, or any disagreement between the high-water mark and the journal tail fails closed. This prevents deleting only the latest generation from turning an older but internally valid chain into the current authorized state.

Writes use create-exclusive generation files. Two writers cannot both successfully claim the same next generation. Mutations require the caller's expected generation so a stale administrative action cannot silently overwrite newer state.

## Crash durability

The control root itself must be pre-provisioned as a real directory by the operator. The control plane creates the `tenants/` directory and each tenant directory with restrictive permissions when required.

For every committed control mutation the writer follows this order:

1. create the next generation with create-exclusive semantics;
2. write and `fsync` that generation file;
3. `fsync` the tenant directory so the new directory entry is durable;
4. write the next high-water mark to a create-exclusive temporary file and `fsync` it;
5. atomically rename that temporary file over `.hwm.json`;
6. `fsync` the tenant directory again so the high-water-mark rename is durable.

The parent directory is also synchronized when `tenants/` or a tenant directory is created for the first time.

If the process or machine fails between the generation write and high-water-mark commit, the safe outcome is a mismatch or interrupted-update marker and therefore authoritative OFF. The implementation must never treat an incomplete control mutation as ON.

## Job generation binding

A future collector/worker must capture the current tenant generation when work is accepted.

Immediately before executing a job **and again before publishing its result**, the worker must call the authorization guard with that captured generation.

Any later control-plane mutation increments the generation. Therefore queued or in-flight work created under an older generation becomes stale and must not be executed or published.

This is the mechanism that makes a per-tenant emergency kill switch meaningful without changing or redeploying the customer's website.

## Emergency semantics

`enabled` and `kill_switch` are independent.

Turning `enabled=true` never clears an active kill switch. The operator must explicitly clear the kill switch. This prevents a routine enable action from accidentally bypassing an emergency stop.

## Trust boundary

`controlRoot` is security-sensitive authority storage.

Only the trusted control-plane writer is allowed to modify it. Future collectors, workers, client sites, CANO, Nexus Bot Studio, and request-serving processes must not receive write permission to this directory. They may consume authorization decisions through a narrower interface or read-only projection, but they must not share the writer's filesystem authority.

The implementation rejects invalid tenant ids and obvious non-directory/symlink replacements at the control directory boundaries it inspects, but filesystem integrity ultimately depends on the operator protecting the control root and its ancestors from untrusted writers. A process with unrestricted write access to the same authority store is inside the trust boundary and can corrupt or replace local state.

The SHA-256 journal chain and high-water-mark hash are **integrity/corruption evidence, not authentication or a digital signature**. They detect accidental corruption, partial writes, unexpected history edits that are not consistently recomputed, and tail truncation when the durable high-water mark remains authoritative. They do not defend against a malicious writer that can rewrite the journal and high-water mark consistently. Resisting a malicious privileged writer would require an independent trust domain such as an external append-only anchor, HMAC/signature key unavailable to that writer, KMS/HSM-backed signing, or WORM storage.

## Current scope

This PR intentionally contains no:

- Nexus pipeline wiring;
- outbox/queue worker;
- collector;
- database;
- HTTP admin server;
- UI button;
- Vercel/Cloudflare integration;
- CANO activation;
- Nexus Bot Studio activation.

The included CLI is only a local/operator interface to the same control authority. A later authenticated admin UI can wrap this authority without changing its deny-by-default semantics.

## Required future integration rule

SEO Avengers availability must never be a dependency of site availability.

If the control plane, collector, worker, or SEO Avengers runtime is down, the customer site must continue serving traffic normally.

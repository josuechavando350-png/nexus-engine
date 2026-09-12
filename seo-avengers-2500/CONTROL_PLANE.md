# SEO Avengers 2500 — Tenant Control Plane Contract

This control plane is intentionally separate from the Nexus site request path.

It does **not** deploy SEO Avengers to any tenant, does not crawl a site, does not enqueue work, does not modify HTML, and does not connect to CANO or Nexus Bot Studio. It only defines the authority that future collectors/workers must consult.

## Default state

Activation is deny-by-default.

- Missing tenant state: OFF.
- Disabled tenant: OFF.
- Emergency kill switch active: OFF.
- Malformed or tampered state history: OFF.
- Unreadable control root: OFF.
- Invalid tenant id: OFF.
- Only an integrity-valid latest generation with `enabled=true` and `kill_switch=false` is ON.

There is no source-controlled tenant that ships ON.

## Append-only tenant journal

Each tenant has an isolated append-only history:

```text
<control-root>/tenants/<site-id>/00000000000000000001.json
<control-root>/tenants/<site-id>/00000000000000000002.json
...
```

Every record binds:

- tenant id;
- generation;
- enabled state;
- emergency kill-switch state;
- previous record hash;
- its own SHA-256 state hash.

The reader verifies the complete chain. A generation gap, cross-tenant record, malformed JSON, hash mismatch, or previous-hash mismatch fails closed.

Writes use create-exclusive generation files. Two writers cannot both successfully claim the same next generation. Mutations require the caller's expected generation so a stale administrative action cannot silently overwrite newer state.

## Job generation binding

A future collector/worker must capture the current tenant generation when work is accepted.

Immediately before executing a job **and again before publishing its result**, the worker must call the authorization guard with that captured generation.

Any later control-plane mutation increments the generation. Therefore queued or in-flight work created under an older generation becomes stale and must not be executed or published.

This is the mechanism that makes a per-tenant emergency kill switch meaningful without changing or redeploying the customer's website.

## Emergency semantics

`enabled` and `kill_switch` are independent.

Turning `enabled=true` never clears an active kill switch. The operator must explicitly clear the kill switch. This prevents a routine enable action from accidentally bypassing an emergency stop.

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

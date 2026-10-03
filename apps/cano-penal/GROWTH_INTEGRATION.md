# CANO growth integration

This preview separates browser interaction measurement from business-outcome attribution.

## Browser layer

`NexusBehavioralSignals` records consent-gated page views, scroll depth, CTA clicks, form starts/submits/errors and micro-interactions. Strategic CTAs carry stable `data-nexus-signal` identifiers. No raw case narrative is sent through this layer.

## Business outcome layer

`POST /api/nexus/growth` is server-to-server only and fails closed unless all of these are configured:

- `NEXUS_CANO_GROWTH_WRITE_TOKEN`
- `NEXUS_GROWTH_ATTRIBUTION_ENDPOINT`
- `NEXUS_GROWTH_ATTRIBUTION_TOKEN`

Accepted stages are `CONTACT`, `QUALIFIED_LEAD`, `CONSULTATION`, and `SIGNED_CLIENT`.

The endpoint accepts only pseudonymous journey hashes and bounded attribution fields. Revenue is accepted only on `SIGNED_CLIENT`. It rejects raw identity fields by schema omission and forwards only the canonical allow-list.

## Required external evidence before activation

Status remains **UNKNOWN / NOT CERTIFIED** until a real CRM or controlled operator workflow can produce:
- a stable pseudonymous journey identifier;
- observed stage transitions;
- signed-client events;
- revenue in minor currency units when legally/operationally appropriate;
- attribution completeness measurements.

Google Business Profile review sync is also **NOT CERTIFIED** until OAuth/account/location credentials are supplied and a live read succeeds. NEXUS already contains the local-presence provider boundary; this preview does not invent that connection.

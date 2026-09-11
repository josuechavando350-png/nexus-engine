# SEO AVENGERS 200 — Multi-tenant operations

## Invariant

Activation is **deny-by-default**. A Nexus project is enabled only when its own `package.json.nexus.CONFIG_SEO_AVENGERS_200` is the boolean `true`. An external project is enabled only when its own record in `apps/seo-avengers-reverse-proxy/external-clients.json` contains the boolean `true`.

No tenant is pre-enabled in source control. `deploy-capability.sh <site_id>` is the only supported activation path.

Runtime failure is separately **fail-open to the site's native/origin response**. Those two statements are not contradictory: activation fails closed; an already-enabled optional transform that times out/errors fails open so it cannot take the site down.

## Native Nexus tenant

Enable and deploy one tenant:

```bash
export NEXUS_ENGINE_ROOT=/absolute/path/to/nexus-engine
export SEO_AVENGERS_KV_ID=<cloudflare-kv-id>
export CLOUDFLARE_ACCOUNT_ID=<account-id> # optional if Wrangler already resolves the account
export NEXUS_SEO_EDGE_PUBLISH_TOKEN=<long-random-secret>

./scripts/deploy-capability.sh nexus-bot-studio
```

The script modifies only `apps/nexus-bot-studio/package.json` in the Nexus repository, compiles `seo-avengers-edge` for `wasm32-unknown-unknown`, deploys the shared Rust transformer, generates a site-specific Cloudflare gateway configuration, and deploys only that tenant route. It does not set another client's flag.

If a native app lacks `nexus.canonicalOrigin`, provide it once:

```bash
NEXUS_CANONICAL_ORIGIN=https://example.com ./scripts/deploy-capability.sh example-client
```

Disable one native tenant:

```bash
export NEXUS_ENGINE_ROOT=/absolute/path/to/nexus-engine
./scripts/disable-capability.sh example-client
```

The disabled generated Worker config contains no route, no KV binding and no transformer service binding.

## External WordPress / Shopify / third-party tenant

Register and deploy in one command:

```bash
export SEO_AVENGERS_KV_ID=<cloudflare-kv-id>
export NEXUS_SEO_EDGE_PUBLISH_TOKEN=<long-random-secret>
./scripts/add-external-client.sh despacho-acme https://acme.com https://origin.acme-host.com true
```

The script atomically updates `apps/seo-avengers-reverse-proxy/external-clients.json`, then regenerates Cloudflare Routes from **enabled records only** and deploys the shared reverse proxy. The daily per-client configuration has only four fields:

```json
{
  "client_id": "despacho-acme",
  "incoming_domain": "https://acme.com",
  "target_origin": "https://origin.acme-host.com",
  "CONFIG_SEO_AVENGERS_200": true
}
```

For convenience, `incoming_domain` supplied as `://acme.com` or `acme.com` is normalized by the add script to `https://acme.com`. `target_origin` must be the real HTTPS origin endpoint for that client's site; a provider homepage such as `https://wpengine.com` is only an illustration and is not a usable WordPress origin by itself.

Disable and remove the external Cloudflare Route:

```bash
./scripts/disable-capability.sh despacho-acme
```

Or update the record explicitly:

```bash
./scripts/add-external-client.sh despacho-acme https://acme.com https://origin.acme-host.com false
```

## Cloudflare one-time prerequisites

External tenants use **Workers Routes**, not Custom Domains. The incoming hostname must already belong to a Cloudflare zone in the deployment account and have a proxied DNS record pointing at the client's real application origin. This is what makes the defensive `fetch(request)` bypass go directly to the DNS origin when a tenant is not enabled.

One KV namespace is shared by active tenants, while keys are isolated as:

```text
seo_vectors:<site_id>:<pathname>
```

The Rust transformer is shared through `SEO_AVENGERS_TRANSFORMER` Service Binding. Tenant identity does not come from the transformer environment; the JSON-LD graph comes only from the `site_id`-scoped semantic snapshot.

## Edge deadline rules

Origin/network work and HTML body materialization are outside the optional SEO deadline. Only the KV lookup plus Rust Service Binding transform are raced against fallback:

```text
origin response + body materialization
  -> start optional SEO timer
  -> read route vector + call Rust Service Binding + receive transformed HTML
  -> canonical/hash/header assembly after a successful transform
```

The production-hardened native Nexus gateway uses a **100 ms** optional edge deadline. The external reverse proxy retains the source-spec **4 ms** optional edge deadline. Neither figure is an end-to-end network SLA. When the transform loses its race, the untouched native/origin response is returned.

The 100 ms native budget was selected from production evidence: the shared Rust transformer completed the verified Nexus Bot Studio `/automation` transform in 26 ms wall time, while a 50 ms aggregate KV + Service Binding budget still produced fail-open behavior. The 100 ms budget then produced the expected `x-nexus-seo-avengers: 200-applied` response marker.

## Dry runs

No Cloudflare mutation:

```bash
DRY_RUN=1 ./scripts/deploy-capability.sh nexus-bot-studio
DRY_RUN=1 ./scripts/disable-capability.sh nexus-bot-studio
DRY_RUN=1 ./scripts/deploy-external-proxy.sh
```

Compile without deploying:

```bash
DEPLOY_CLOUDFLARE=0 ./scripts/deploy-capability.sh nexus-bot-studio
```

## Verification

```bash
./scripts/verify.sh
```

Full backend mirror additionally requires the Python package dependencies, including Google Cloud Natural Language:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e './packages/Semantic-Python-NLP[embeddings]'
./scripts/local-mirror-e2e.sh
```

import assert from "node:assert/strict";
import proxy from "../apps/seo-avengers-reverse-proxy/src/index.ts";
import externalClients from "../apps/seo-avengers-reverse-proxy/external-clients.json" with { type: "json" };

// Production registry ships disabled. The test process explicitly enables its fixture
// before the Worker lazily builds the host index.
externalClients[0].CONFIG_SEO_AVENGERS_200 = true;

const html = '<html><head></head><body><img src="/hero.jpg"></body></html>';
const vector = JSON.stringify({
  suite: "SEO_AVENGERS_200",
  module_count: 200,
  site_id: "cliente-ejemplo-wordpress",
  route: "/",
  version: 1,
  sections: { hero: { json_ld: { "@type": "WebPage", name: "Ejemplo" }, output_hash: `sha256:${"a".repeat(64)}` } },
  output_hash: `sha256:${"b".repeat(64)}`,
});
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function unknownTenantBypassesWithoutSeo() {
  const previous = globalThis.fetch;
  let originCalls = 0;
  let kvReads = 0;
  let transformerCalls = 0;
  globalThis.fetch = async (request) => {
    originCalls++;
    assert.equal(new URL(request.url).hostname, "unknown.example");
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await proxy.fetch(new Request("https://unknown.example/"), {
      SEO_VECTORS: { async get() { kvReads++; return vector; }, async put() {} },
      SEO_AVENGERS_TRANSFORMER: { async fetch() { transformerCalls++; return new Response("bad"); } },
    }, ctx);
    assert.equal(await response.text(), html);
    assert.equal(originCalls, 1);
    assert.equal(kvReads, 0);
    assert.equal(transformerCalls, 0);
  } finally { globalThis.fetch = previous; }
}

async function activeTenantUsesTargetAndTransformer() {
  const previous = globalThis.fetch;
  let fetchedHost = "";
  let transformerCalls = 0;
  globalThis.fetch = async (request) => {
    fetchedHost = new URL(request.url).hostname;
    return new Response(html, { headers: { "content-type": "text/html", "x-origin": "external" } });
  };
  try {
    const response = await proxy.fetch(new Request("https://abogadomexico.com/"), {
      SEO_VECTORS: { async get() { return vector; }, async put() {} },
      SEO_AVENGERS_TRANSFORMER: { async fetch() { transformerCalls++; return new Response("<html>external transformed</html>"); } },
    }, ctx);
    assert.equal(fetchedHost, "wpengine.com");
    assert.equal(transformerCalls, 1);
    assert.equal(await response.text(), "<html>external transformed</html>");
    assert.equal(response.headers.get("x-nexus-seo-avengers"), "200-applied");
    assert.equal(response.headers.get("x-nexus-seo-tenant"), "cliente-ejemplo-wordpress");
  } finally { globalThis.fetch = previous; }
}

async function slowOriginBodyDoesNotConsumeSeoBudget() {
  const previous = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(encoder.encode(html));
        controller.close();
      }, 20);
    },
  }), { headers: { "content-type": "text/html", "x-origin": "external" } });
  try {
    const response = await proxy.fetch(new Request("https://abogadomexico.com/"), {
      SEO_VECTORS: { async get() { return vector; }, async put() {} },
      SEO_AVENGERS_TRANSFORMER: { async fetch() { return new Response("<html>slow-origin transformed</html>"); } },
    }, ctx);
    assert.equal(await response.text(), "<html>slow-origin transformed</html>");
    assert.equal(response.headers.get("x-nexus-seo-avengers"), "200-applied");
  } finally { globalThis.fetch = previous; }
}

async function activeTenantTimeoutReturnsOrigin() {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { headers: { "content-type": "text/html", "x-origin": "external" } });
  try {
    const response = await proxy.fetch(new Request("https://abogadomexico.com/"), {
      SEO_VECTORS: { async get() { return vector; }, async put() {} },
      SEO_AVENGERS_TRANSFORMER: { async fetch(_url, init) { return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("late")), 30);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      }); } },
    }, ctx);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get("x-origin"), "external");
    assert.equal(response.headers.get("x-nexus-seo-avengers"), null);
  } finally { globalThis.fetch = previous; }
}

await unknownTenantBypassesWithoutSeo();
await activeTenantUsesTargetAndTransformer();
await slowOriginBodyDoesNotConsumeSeoBudget();
await activeTenantTimeoutReturnsOrigin();
console.log("external reverse proxy lazy-bypass/fail-open/body-budget tests: PASS");

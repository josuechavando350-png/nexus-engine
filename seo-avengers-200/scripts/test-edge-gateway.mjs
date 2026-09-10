import assert from "node:assert/strict";
import gateway from "../apps/edge-cloudflare-gateway/src/index.ts";

function native(body = "<html><head></head><body><img src=\"/x.jpg\"></body></html>") {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-origin": "nexus" } });
}

async function runCase({ flag, vector = '{"suite":"SEO_AVENGERS_200","module_count":200,"site_id":"nexus-bot-studio","route":"/","version":1,"sections":{},"output_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', transformer, expectedBody, expectedApplied, expectSeoReads }) {
  const previous = globalThis.fetch;
  let vectorReads = 0;
  let transformerCalls = 0;
  globalThis.fetch = async () => native();
  try {
    const env = {
      ...(flag === undefined ? {} : { CONFIG_SEO_AVENGERS_200: flag }),
      NEXUS_ORIGIN_URL: "https://origin.example",
      NEXUS_SITE_ID: "nexus-bot-studio",
      SEO_VECTORS: {
        async get() { vectorReads++; return vector; },
        async put() { throw new Error("unexpected KV write"); },
      },
      SEO_AVENGERS_TRANSFORMER: {
        async fetch(...args) { transformerCalls++; return transformer(...args); },
      },
    };
    const response = await gateway.fetch(new Request("https://nexusbotstudio.com/"), env);
    assert.equal(await response.text(), expectedBody);
    assert.equal(response.headers.get("x-origin"), "nexus");
    assert.equal(response.headers.get("x-nexus-seo-avengers") === "200-applied", expectedApplied);
    assert.equal(vectorReads > 0 || transformerCalls > 0, expectSeoReads);
    if (!expectSeoReads) {
      assert.equal(vectorReads, 0, "disabled gateway must not read SEO KV");
      assert.equal(transformerCalls, 0, "disabled gateway must not call transformer binding");
    }
  } finally {
    globalThis.fetch = previous;
  }
}

const original = await native().text();
await runCase({ flag: undefined, transformer: async () => { throw new Error("must not run"); }, expectedBody: original, expectedApplied: false, expectSeoReads: false });
await runCase({ flag: "false", transformer: async () => { throw new Error("must not run"); }, expectedBody: original, expectedApplied: false, expectSeoReads: false });
await runCase({ flag: "TRUE", transformer: async () => { throw new Error("must not run"); }, expectedBody: original, expectedApplied: false, expectSeoReads: false });
await runCase({ flag: "true", transformer: async () => { throw new Error("boom"); }, expectedBody: original, expectedApplied: false, expectSeoReads: true });
await runCase({
  flag: "true",
  transformer: async (_url, init) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("too late")), 25);
    init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  }),
  expectedBody: original,
  expectedApplied: false,
  expectSeoReads: true,
});
await runCase({
  flag: "true",
  transformer: async () => new Response("<html>transformed</html>"),
  expectedBody: "<html>transformed</html>",
  expectedApplied: true,
  expectSeoReads: true,
});
console.log("native edge gateway deny-by-default/fail-open tests: PASS");

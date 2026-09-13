import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractSameTenantRoutes, runNexusBotStudioCanary, visibleTextFromHtml } from "../canary/nexusbotstudio-canary.mjs";
import { setTenantEnabled, setTenantKillSwitch } from "../control-plane/tenant-control.mjs";

async function setup(t, { enabled = true } = {}) {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-canary-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "avengers-evidence-canary-"));
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  t.after(async () => {
    await rm(controlRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });
  const state = await setTenantEnabled({
    controlRoot,
    siteId: "nexus-bot-studio",
    enabled,
    expectedGeneration: 0,
  });
  return { controlRoot, evidenceRoot, generation: state.generation };
}

function successfulExecution() {
  const evidenceHash = `sha256:${"a".repeat(64)}`;
  const receipts = {};
  for (let number = 1001; number <= 2500; number += 1) {
    const module = `M${number}`;
    receipts[module] = {
      module,
      policy_status: "SAFE_WHITE_HAT",
      action_mode: "OBSERVE_ONLY",
      execution_status: "SUCCESS",
      finding_status: "NO_FINDING",
      evidence_hash: evidenceHash,
      output: {},
    };
  }
  receipts.M2500.output = { release_safe: true, suite: "SEO_AVENGERS_2500" };
  return {
    schema_version: 1,
    receipt_count: 1500,
    first_module: "M1001",
    last_module: "M2500",
    execution_hash: `sha256:${"b".repeat(64)}`,
    terminal_evidence_hash: evidenceHash,
    receipts,
  };
}

function response(body, contentType = "text/html; charset=utf-8", status = 200) {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function responseAt(body, finalUrl, contentType = "text/html; charset=utf-8", status = 200) {
  const base = response(body, contentType, status);
  return {
    ok: base.ok,
    status: base.status,
    headers: base.headers,
    url: finalUrl,
    arrayBuffer: () => base.arrayBuffer(),
  };
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

test("sitemap parser accepts only exact NexusBotStudio HTTPS hosts", () => {
  const routes = extractSameTenantRoutes(`<?xml version="1.0"?><urlset>
    <url><loc>https://nexusbotstudio.com/automation</loc></url>
    <url><loc>https://www.nexusbotstudio.com/agentes</loc></url>
    <url><loc>https://evil.example/copy</loc></url>
    <url><loc>http://nexusbotstudio.com/insecure</loc></url>
    <url><loc>https://nexusbotstudio.com/query?x=1</loc></url>
  </urlset>`);
  assert.deepEqual(routes, ["/", "/agentes", "/automation"]);
});

test("visible text extraction excludes scripts styles and markup", () => {
  const text = visibleTextFromHtml("<html><style>.x{}</style><script>secret()</script><body><h1>Nexus &amp; Bots</h1><p>Automatización real</p></body></html>");
  assert.equal(text, "Nexus & Bots Automatización real");
});

test("disabled NexusBotStudio tenant performs zero network requests", async (t) => {
  const ctx = await setup(t, { enabled: false });
  let calls = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not run");
    },
    executeSuite: async () => successfulExecution(),
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "DISABLED");
});

test("authorized canary collects only same-tenant public pages and releases sidecar result", async (t) => {
  const ctx = await setup(t);
  const calls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith("/sitemap.xml")) {
      return response(`<?xml version="1.0"?><urlset>
        <url><loc>https://nexusbotstudio.com/automation</loc></url>
        <url><loc>https://outside.example/never</loc></url>
      </urlset>`, "application/xml");
    }
    if (value.endsWith("/automation")) return response("<main><h1>Automatización con agentes</h1><p>Nexus Bot Studio</p></main>");
    return response("<main><h1>Nexus Bot Studio</h1><p>Agentes de inteligencia artificial</p></main>");
  };
  let executions = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl,
    executeSuite: async () => {
      executions += 1;
      return successfulExecution();
    },
  });
  assert.equal(executions, 1);
  assert.equal(result.status, "RELEASED");
  assert.equal(result.siteId, "nexus-bot-studio");
  assert.equal(result.canary.discoveredRoutes, 2);
  assert.equal(result.canary.collectedDocuments, 2);
  assert.equal(calls.some((item) => item.includes("outside.example")), false);
});

test("allowed root-to-www redirect is followed manually", async (t) => {
  const ctx = await setup(t);
  const calls = [];
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith("/sitemap.xml")) return response("<urlset></urlset>", "application/xml");
      if (value === "https://nexusbotstudio.com/") return redirectResponse("https://www.nexusbotstudio.com/");
      if (value === "https://www.nexusbotstudio.com/") return response("<main>Nexus Bot Studio</main>");
      throw new Error(`unexpected URL ${value}`);
    },
    executeSuite: async () => successfulExecution(),
  });
  assert.equal(result.status, "RELEASED");
  assert.deepEqual(calls, [
    "https://nexusbotstudio.com/sitemap.xml",
    "https://nexusbotstudio.com/",
    "https://www.nexusbotstudio.com/",
  ]);
});

test("cross-tenant redirect is rejected before target fetch", async (t) => {
  const ctx = await setup(t);
  const calls = [];
  let executions = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith("/sitemap.xml")) return response("<urlset></urlset>", "application/xml");
      if (value === "https://nexusbotstudio.com/") return redirectResponse("http://169.254.169.254/latest/meta-data/");
      throw new Error("redirect target must never be fetched");
    },
    executeSuite: async () => {
      executions += 1;
      return successfulExecution();
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "CANARY_CONTENT_EVIDENCE_EMPTY");
  assert.deepEqual(calls, [
    "https://nexusbotstudio.com/sitemap.xml",
    "https://nexusbotstudio.com/",
  ]);
});

test("conflicting redirects to one final document fail closed", async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.endsWith("/sitemap.xml")) {
        return response("<urlset><url><loc>https://nexusbotstudio.com/a</loc></url><url><loc>https://nexusbotstudio.com/b</loc></url></urlset>", "application/xml");
      }
      if (value.endsWith("/a")) return responseAt("<main>alpha</main>", "https://www.nexusbotstudio.com/same");
      if (value.endsWith("/b")) return responseAt("<main>beta</main>", "https://www.nexusbotstudio.com/same");
      return response("<main>root</main>");
    },
    executeSuite: async () => {
      executions += 1;
      return successfulExecution();
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "CONFLICTING_FINAL_DOCUMENT");
});

test("kill switch activated after sitemap discovery aborts before page fetch and publication", async (t) => {
  const ctx = await setup(t);
  let calls = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).endsWith("/sitemap.xml")) {
        await setTenantKillSwitch({
          controlRoot: ctx.controlRoot,
          siteId: "nexus-bot-studio",
          active: true,
          expectedGeneration: 1,
        });
        return response("<urlset><url><loc>https://nexusbotstudio.com/automation</loc></url></urlset>", "application/xml");
      }
      throw new Error("page fetch must be suppressed");
    },
    executeSuite: async () => {
      throw new Error("suite must be suppressed");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "KILL_SWITCH_ACTIVE");
  assert.equal(result.controlGeneration, 2);
});

test("evidence publication failure returns structured BLOCKED result", async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/sitemap.xml")) return response("<urlset></urlset>", "application/xml");
      await rm(ctx.evidenceRoot, { recursive: true, force: true });
      return response("<main>Nexus Bot Studio</main>");
    },
    executeSuite: async () => {
      executions += 1;
      return successfulExecution();
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_PUBLICATION_FAILED");
  assert.equal(result.collectedDocuments, 1);
});

test("no usable HTML evidence returns INSUFFICIENT_DATA without suite execution", async (t) => {
  const ctx = await setup(t);
  let executions = 0;
  const result = await runNexusBotStudioCanary({
    ...ctx,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/sitemap.xml")) return response("<urlset></urlset>", "application/xml");
      return response("not html", "application/json");
    },
    executeSuite: async () => {
      executions += 1;
      return successfulExecution();
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "CANARY_CONTENT_EVIDENCE_EMPTY");
});

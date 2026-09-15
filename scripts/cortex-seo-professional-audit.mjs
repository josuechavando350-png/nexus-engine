#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FirstPartyFetchSeoAuditAdapter, SeoProfessionalAuditRuntime } from "../packages/ontology/dist/cortex/seo-profesional/audit-runtime/index.js";
import { PlaywrightSeoAuditBrowserAdapter } from "../packages/capture/dist/capture/seo-audit-playwright-adapter.js";

function fail(message) {
  process.stderr.write(`SEO Profesional audit runtime: ${message}\n`);
  process.exitCode = 1;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.env.NEXUS_SEO_AUDIT_ENABLED !== "1") {
  fail("disabled. Set NEXUS_SEO_AUDIT_ENABLED=1 only for an explicitly authorized audit run.");
} else {
  const configPath = arg("--config");
  if (!configPath) {
    fail("missing --config <file.json>.");
  } else {
    try {
      const payload = JSON.parse(readFileSync(resolve(configPath), "utf8"));
      if (!payload || typeof payload !== "object" || !payload.config || typeof payload.config !== "object" || !Array.isArray(payload.startUrls) || !payload.activation) {
        throw new Error("config file must contain config, startUrls, and activation objects");
      }
      const { network_proxies: networkProxies, ...runtimeConfig } = payload.config;
      if (networkProxies !== undefined && !Array.isArray(networkProxies)) {
        throw new Error("config.network_proxies must be an array of ordered proxy endpoint URLs");
      }
      const http = new FirstPartyFetchSeoAuditAdapter(runtimeConfig.canonicalOrigin);
      const browser = new PlaywrightSeoAuditBrowserAdapter(undefined, { networkProxies });
      const runtime = new SeoProfessionalAuditRuntime({ config: runtimeConfig, http, browser });
      const expiresAtMs = Number.isFinite(payload.activation.expiresInMs) ? Date.now() + Number(payload.activation.expiresInMs) : undefined;
      runtime.activate({ requestedBy: payload.activation.requestedBy, reason: payload.activation.reason, expiresAtMs });
      const report = await runtime.run({ startUrls: payload.startUrls, uxScenarios: payload.uxScenarios });
      const serialized = `${JSON.stringify(report, null, 2)}\n`;
      const out = arg("--out");
      if (out) writeFileSync(resolve(out), serialized, "utf8");
      process.stdout.write(serialized);
      runtime.deactivate();
    } catch (error) {
      fail(error instanceof Error ? error.message : "unknown failure");
    }
  }
}

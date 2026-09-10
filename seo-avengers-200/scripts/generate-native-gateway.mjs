#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [siteId, engineRootArg = ""] = process.argv.slice(2);
if (!siteId) throw new Error("usage: generate-native-gateway.mjs <site_id> [nexus-engine-root]");
if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(siteId)) throw new Error("invalid site_id");

const manifestPath = process.env.NEXUS_TENANT_MANIFEST
  ? resolve(process.env.NEXUS_TENANT_MANIFEST)
  : resolve(engineRootArg || process.cwd(), "apps", siteId, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const nexus = manifest?.nexus ?? {};
const enabled = nexus.CONFIG_SEO_AVENGERS_200 === true;
const configuredSiteId = typeof nexus.siteId === "string" && nexus.siteId.trim() ? nexus.siteId.trim() : siteId;
if (configuredSiteId !== siteId) throw new Error(`manifest siteId mismatch: expected ${siteId}, got ${configuredSiteId}`);
const canonicalRaw = String(nexus.canonicalOrigin ?? "").trim();
if (!canonicalRaw) throw new Error(`${siteId} nexus.canonicalOrigin is required`);
const canonical = new URL(canonicalRaw);
if (canonical.protocol !== "https:" || canonical.pathname !== "/" || canonical.search || canonical.hash) {
  throw new Error("canonicalOrigin must be an HTTPS origin");
}

const incomingDomains = Array.isArray(nexus.incomingDomains) && nexus.incomingDomains.length
  ? nexus.incomingDomains.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
  : [canonical.host.toLowerCase()];
const routes = enabled ? [...new Set(incomingDomains)].map((host) => `https://${host}/*`) : [];

const config = {
  $schema: "./node_modules/wrangler/config-schema.json",
  name: `seo-avengers-gateway-${siteId}`,
  main: "src/index.ts",
  compatibility_date: "2026-09-09",
  workers_dev: false,
  preview_urls: false,
  ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { account_id: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
  routes,
  vars: {
    CONFIG_SEO_AVENGERS_200: enabled ? "true" : "false",
    NEXUS_SITE_ID: siteId,
  },
  ...(enabled ? {
    kv_namespaces: [{
      binding: "SEO_VECTORS",
      id: (() => {
        const id = String(process.env.SEO_AVENGERS_KV_ID ?? "").trim();
        if (!id) throw new Error("SEO_AVENGERS_KV_ID is required for an enabled native tenant");
        return id;
      })(),
      ...(process.env.SEO_AVENGERS_KV_PREVIEW_ID ? { preview_id: process.env.SEO_AVENGERS_KV_PREVIEW_ID } : {}),
    }],
    services: [{ binding: "SEO_AVENGERS_TRANSFORMER", service: "seo-avengers-transformer" }],
  } : {}),
  observability: { enabled: true },
};
const output = resolve(root, "apps/edge-cloudflare-gateway", `wrangler.generated.${siteId}.jsonc`);
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(output);

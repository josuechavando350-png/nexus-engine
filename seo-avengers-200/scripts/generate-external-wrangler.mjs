#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientsPath = resolve(root, "apps/seo-avengers-reverse-proxy/external-clients.json");
const outputPath = resolve(root, "apps/seo-avengers-reverse-proxy/wrangler.generated.jsonc");

function normalizeOrigin(value, label) {
  let candidate = String(value ?? "").trim();
  if (candidate.startsWith("://")) candidate = `https${candidate}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${label} must be an origin only`);
  return url.origin;
}

const clients = JSON.parse(await readFile(clientsPath, "utf8"));
if (!Array.isArray(clients)) throw new Error("external-clients.json must be an array");
const seenIds = new Set();
const seenHosts = new Set();
const routes = [];
for (const client of clients) {
  const id = String(client?.client_id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || seenIds.has(id)) throw new Error(`invalid/duplicate client_id ${id}`);
  seenIds.add(id);
  const incoming = normalizeOrigin(client.incoming_domain, `incoming_domain for ${id}`);
  normalizeOrigin(client.target_origin, `target_origin for ${id}`);
  const url = new URL(incoming);
  if (seenHosts.has(url.host)) throw new Error(`duplicate incoming domain ${url.host}`);
  seenHosts.add(url.host);
  if (client.CONFIG_SEO_AVENGERS_200 === true) routes.push(`${url.protocol}//${url.host}/*`);
}

const active = routes.length > 0;
const config = {
  $schema: "./node_modules/wrangler/config-schema.json",
  name: "seo-avengers-reverse-proxy",
  main: "src/index.ts",
  compatibility_date: "2026-09-09",
  workers_dev: false,
  preview_urls: false,
  ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { account_id: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
  routes,
  ...(active ? {
    kv_namespaces: [{
      binding: "SEO_VECTORS",
      id: (() => {
        const id = String(process.env.SEO_AVENGERS_KV_ID ?? "").trim();
        if (!id) throw new Error("SEO_AVENGERS_KV_ID is required when at least one external tenant is enabled");
        return id;
      })(),
      ...(process.env.SEO_AVENGERS_KV_PREVIEW_ID ? { preview_id: process.env.SEO_AVENGERS_KV_PREVIEW_ID } : {}),
    }],
    services: [{ binding: "SEO_AVENGERS_TRANSFORMER", service: "seo-avengers-transformer" }],
  } : {}),
  observability: { enabled: true },
};
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`generated ${outputPath} with ${routes.length} enabled external route(s); active=${active}`);

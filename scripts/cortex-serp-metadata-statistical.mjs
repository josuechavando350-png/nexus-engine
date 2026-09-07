#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { createGoogleOAuthRefreshTokenProvider } from "../packages/ontology/dist/cortex/bidding-supervisor/google-ads-rest.js";
import { HttpPageInventoryProvider } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/http-page-inventory-provider.js";
import { JsonFileMetadataPublisher } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/json-file-metadata-publisher.js";
import { SearchConsoleRestClient } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/search-console-rest.js";
import { createSerpProductionRuntime, parseSerpProductionConfig } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/production-runtime.js";
import { StatisticalSerpRollbackSupervisor } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/statistical-rollback.js";
import { loadStatisticalRollbackPolicy } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/statistical-rollback-config.js";

process.umask(0o077);
const MAX_CONFIG_BYTES = 1024 * 1024;
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function productionConfig(path) { if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_SERP_CONFIG must be an absolute path"); const stat = statSync(path); if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) throw new Error(`SERP config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`); return parseSerpProductionConfig(JSON.parse(readFileSync(path, "utf8"))); }
function durablePath(name) { const value = required(name); if (value === ":memory:" || !isAbsolute(value)) throw new Error(`${name} must be an absolute durable path`); return value; }
function port(value) { const parsed = Number(value ?? "8792"); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535"); return parsed; }
function interval(value) { const parsed = Number(value ?? "3600000"); if (!Number.isSafeInteger(parsed) || parsed < 300_000 || parsed > 86_400_000) throw new Error("NEXUS_CORTEX_SERP_STATISTICAL_ROLLBACK_INTERVAL_MS must be 300000..86400000"); return parsed; }

if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const stateDb = durablePath("NEXUS_CORTEX_STATE_DB");
const manifestPath = durablePath("NEXUS_CORTEX_SERP_MANIFEST");
const config = productionConfig(required("NEXUS_CORTEX_SERP_CONFIG"));
const statisticalPolicy = loadStatisticalRollbackPolicy(required("NEXUS_CORTEX_SERP_STATISTICAL_ROLLBACK_CONFIG"));
const runToken = required("NEXUS_CORTEX_SERP_RUN_TOKEN");
const controlToken = required("NEXUS_CORTEX_SERP_CONTROL_TOKEN");
const metadataToken = required("NEXUS_CORTEX_SERP_METADATA_TOKEN");
const inventoryToken = required("NEXUS_CORTEX_SERP_INVENTORY_TOKEN");
if (new Set([runToken, controlToken, metadataToken, inventoryToken]).size !== 4) throw new Error("SERP run, control, metadata and inventory credentials must be distinct");
const accessTokenProvider = createGoogleOAuthRefreshTokenProvider({
  clientId: required("GOOGLE_SEARCH_CONSOLE_CLIENT_ID"),
  clientSecret: required("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET"),
  refreshToken: required("GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN"),
});
const inventoryProvider = new HttpPageInventoryProvider({ endpoint: required("NEXUS_CORTEX_SERP_INVENTORY_ENDPOINT"), bearerToken: inventoryToken });
const performance = new SearchConsoleRestClient({ accessTokenProvider });
const publisher = new JsonFileMetadataPublisher({ manifestPath });
const store = new SqliteOntologyTransactionStore(stateDb, {
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-serp-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});
const runtime = createSerpProductionRuntime({
  transactions: store,
  config,
  inventory: inventoryProvider,
  performance,
  publisher,
  runToken,
  controlToken,
  metadataToken,
  onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-serp-metadata", ...event })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-serp-metadata", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});

const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const listenPort = port(process.env.PORT);
const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
const rollbackUrl = `http://${localHost}:${listenPort}/v1/serp/rollback`;
const rollback = async (pageId, runId) => {
  const response = await fetch(rollbackUrl, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pageId, runId }),
  });
  if (!response.ok) throw new Error(`local governed SERP rollback returned HTTP ${response.status}`);
  return response.json();
};
const statistical = new StatisticalSerpRollbackSupervisor({
  transactions: store,
  scope: config.scope,
  siteUrl: config.siteUrl,
  targets: config.pages,
  performance,
  policy: statisticalPolicy,
  rollback,
  onDecision: (decision) => process.stdout.write(`${JSON.stringify({ component: "cortex-serp-statistical-rollback", pageId: decision.pageId, status: decision.status, reason: decision.reason, adjustedCtrDrop: decision.adjustedCtrDrop, relativeAdjustedCtrDrop: decision.relativeAdjustedCtrDrop, zScore: decision.zScore, averagePositionDelta: decision.averagePositionDelta })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-serp-statistical-rollback", operation: "TELEMETRY", status: "FAILED", code: error instanceof Error ? error.name : "UNEXPECTED" })}\n`),
});

let statisticalInFlight = false;
const statisticalIntervalMs = interval(process.env.NEXUS_CORTEX_SERP_STATISTICAL_ROLLBACK_INTERVAL_MS);
function runStatisticalRollback() {
  if (statisticalInFlight) return;
  statisticalInFlight = true;
  void statistical.evaluateAll(true)
    .catch((error) => process.stderr.write(`${JSON.stringify({ component: "cortex-serp-statistical-rollback", operation: "EVALUATE", status: "FAILED", code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNEXPECTED" })}\n`))
    .finally(() => { statisticalInFlight = false; });
}
const statisticalTimer = setInterval(runStatisticalRollback, statisticalIntervalMs);
statisticalTimer.unref();
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statisticalTimer);
  process.stdout.write(`${JSON.stringify({ component: "cortex-serp-metadata", operation: "SHUTDOWN", signal })}\n`);
  try { await runtime.close(); } finally { store.close(); }
}
process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
runtime.server.listen(listenPort, host, () => {
  process.stdout.write(`${JSON.stringify({ component: "cortex-serp-metadata", operation: "LISTEN", host, port: listenPort, pages: config.pages.length, statisticalRollback: true })}\n`);
  runtime.start(true);
  runStatisticalRollback();
});

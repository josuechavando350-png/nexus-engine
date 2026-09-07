#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { createGoogleOAuthRefreshTokenProvider } from "../packages/ontology/dist/cortex/bidding-supervisor/google-ads-rest.js";
import { GoogleAdsCreativeRestClient } from "../packages/ontology/dist/cortex/creative-sync/google-ads-creative-rest.js";
import { HttpCreativeDesiredStateProvider } from "../packages/ontology/dist/cortex/creative-sync/http-desired-state-provider.js";
import { createCreativeProductionRuntime, parseCreativeProductionConfig } from "../packages/ontology/dist/cortex/creative-sync/production-runtime.js";
import { HttpInventoryCreativeProvider, InventoryAwareCreativeDesiredStateProvider } from "../packages/ontology/dist/cortex/creative-sync/inventory-intelligence.js";
import { loadInventoryCreativePolicy } from "../packages/ontology/dist/cortex/creative-sync/inventory-config.js";

process.umask(0o077);
const MAX_CONFIG_BYTES = 1024 * 1024;
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function loadCreative(path) { if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_CREATIVE_CONFIG must be an absolute path"); const stat = statSync(path); if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) throw new Error(`creative config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`); return parseCreativeProductionConfig(JSON.parse(readFileSync(path, "utf8"))); }
function port(value) { const parsed = Number(value ?? "8791"); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535"); return parsed; }

const stateDb = required("NEXUS_CORTEX_STATE_DB");
if (stateDb === ":memory:" || !isAbsolute(stateDb)) throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const productionConfig = loadCreative(required("NEXUS_CORTEX_CREATIVE_CONFIG"));
const inventoryPolicy = loadInventoryCreativePolicy(required("NEXUS_CORTEX_INVENTORY_CREATIVE_CONFIG"));
const desiredToken = required("NEXUS_CORTEX_CREATIVE_DESIRED_TOKEN");
const inventoryToken = required("NEXUS_CORTEX_INVENTORY_TOKEN");
const runToken = required("NEXUS_CORTEX_CREATIVE_RUN_TOKEN");
const controlToken = required("NEXUS_CORTEX_CREATIVE_CONTROL_TOKEN");
if (new Set([desiredToken, inventoryToken, runToken, controlToken]).size !== 4) throw new Error("desired-state, inventory, run and control credentials must be distinct");
const accessTokenProvider = createGoogleOAuthRefreshTokenProvider({ clientId: required("GOOGLE_ADS_CLIENT_ID"), clientSecret: required("GOOGLE_ADS_CLIENT_SECRET"), refreshToken: required("GOOGLE_ADS_REFRESH_TOKEN") });
const googleAds = new GoogleAdsCreativeRestClient({ developerToken: required("GOOGLE_ADS_DEVELOPER_TOKEN"), ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() ? { loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.trim() } : {}), accessTokenProvider });
const desiredBase = new HttpCreativeDesiredStateProvider({ endpoint: required("NEXUS_CORTEX_CREATIVE_DESIRED_ENDPOINT"), bearerToken: desiredToken });
const inventory = new HttpInventoryCreativeProvider({ endpoint: required("NEXUS_CORTEX_INVENTORY_ENDPOINT"), bearerToken: inventoryToken });
const desiredState = new InventoryAwareCreativeDesiredStateProvider({ desiredState: desiredBase, inventory, policy: inventoryPolicy });
const store = new SqliteOntologyTransactionStore(stateDb, { onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-creative-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`) });
const runtime = createCreativeProductionRuntime({
  transactions: store,
  config: productionConfig,
  googleAds,
  desiredState,
  runToken,
  controlToken,
  onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-creative-inventory-sync", ...event })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-creative-inventory-sync", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});
const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const listenPort = port(process.env.PORT);
let shuttingDown = false;
async function shutdown(signal) { if (shuttingDown) return; shuttingDown = true; process.stdout.write(`${JSON.stringify({ component: "cortex-creative-inventory-sync", operation: "SHUTDOWN", signal })}\n`); try { await runtime.close(); } finally { store.close(); } }
process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
runtime.server.listen(listenPort, host, () => { process.stdout.write(`${JSON.stringify({ component: "cortex-creative-inventory-sync", operation: "LISTEN", host, port: listenPort, customers: productionConfig.customers.length, inventoryAware: true })}\n`); runtime.start(true); });

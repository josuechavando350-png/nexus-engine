#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { GoogleAdsRestClient, createGoogleOAuthRefreshTokenProvider } from "../packages/ontology/dist/cortex/bidding-supervisor/google-ads-rest.js";
import { HttpBusinessProfitabilityProvider } from "../packages/ontology/dist/cortex/bidding-supervisor/http-profitability-provider.js";
import { createBiddingProductionRuntime, loadBiddingProductionConfig } from "../packages/ontology/dist/cortex/bidding-supervisor/production-runtime.js";

process.umask(0o077);
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function port(value) { const parsed = Number(value ?? "8788"); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535"); return parsed; }

const stateDbPath = required("NEXUS_CORTEX_STATE_DB");
if (stateDbPath === ":memory:" || !isAbsolute(stateDbPath)) throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const configPath = required("NEXUS_CORTEX_BIDDING_CONFIG");
if (!isAbsolute(configPath)) throw new Error("NEXUS_CORTEX_BIDDING_CONFIG must be an absolute path");
const apiToken = required("NEXUS_CORTEX_API_TOKEN");
const config = loadBiddingProductionConfig(configPath);
const accessTokenProvider = createGoogleOAuthRefreshTokenProvider({
  clientId: required("GOOGLE_ADS_CLIENT_ID"),
  clientSecret: required("GOOGLE_ADS_CLIENT_SECRET"),
  refreshToken: required("GOOGLE_ADS_REFRESH_TOKEN"),
});
const googleAds = new GoogleAdsRestClient({
  developerToken: required("GOOGLE_ADS_DEVELOPER_TOKEN"),
  ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() ? { loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.trim() } : {}),
  accessTokenProvider,
});
const profitability = new HttpBusinessProfitabilityProvider({
  endpoint: required("NEXUS_PROFITABILITY_ENDPOINT"),
  bearerToken: required("NEXUS_PROFITABILITY_TOKEN"),
});
const store = new SqliteOntologyTransactionStore(stateDbPath, {
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-ontology-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});
const runtime = createBiddingProductionRuntime({
  transactions: store,
  config,
  googleAds,
  profitability,
  apiToken,
  onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-bidding-supervisor", ...event })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-bidding-supervisor", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});

const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const listenPort = port(process.env.PORT);
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ component: "cortex-bidding-supervisor", operation: "SHUTDOWN", signal })}\n`);
  try { await runtime.close(); } finally { store.close(); }
}
process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
runtime.server.listen(listenPort, host, () => {
  process.stdout.write(`${JSON.stringify({ component: "cortex-bidding-supervisor", operation: "LISTEN", host, port: listenPort, campaignCount: config.campaigns.length, intervalMs: config.intervalMs })}\n`);
  runtime.start(true);
});

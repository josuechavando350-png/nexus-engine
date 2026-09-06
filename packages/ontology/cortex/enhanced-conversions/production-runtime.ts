import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { OntologyScope } from "@nexus/ontology";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { GoogleDataManagerRestClient, type DataManagerDestination } from "./data-manager-rest";
import { DurableEnhancedConversionsPipeline } from "./index";
import { EnhancedConversionProductionServer } from "./production-server";
import { DurableEnhancedConversionControl } from "./runtime-control";

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const NUMERIC_ID = /^\d{5,20}$/u;
const MAX_TOKEN_FILE_BYTES = 16 * 1024;

export interface EnhancedConversionProductionRuntime {
  readonly store: SqliteOntologyTransactionStore;
  readonly control: DurableEnhancedConversionControl;
  readonly engine: DurableEnhancedConversionsPipeline;
  readonly server: EnhancedConversionProductionServer;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

function numericId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_ID.test(normalized)) throw new Error(`${label} is malformed`);
  return normalized;
}

function scopeFromEnv(): OntologyScope {
  const tenantId = identifier(requiredEnv("NEXUS_CORTEX_10_TENANT_ID"), "NEXUS_CORTEX_10_TENANT_ID");
  const organizationId = identifier(requiredEnv("NEXUS_CORTEX_10_ORGANIZATION_ID"), "NEXUS_CORTEX_10_ORGANIZATION_ID");
  const brand = process.env.NEXUS_CORTEX_10_BRAND_ID?.trim();
  if (brand !== undefined && brand !== "" && !IDENTIFIER.test(brand)) throw new Error("NEXUS_CORTEX_10_BRAND_ID is malformed");
  return Object.freeze({ tenantId, organizationId, ...(brand ? { brandId: brand } : {}) });
}

function destinationFromEnv(): DataManagerDestination {
  const operatingAccountId = numericId(requiredEnv("NEXUS_CORTEX_10_OPERATING_ACCOUNT_ID"), "NEXUS_CORTEX_10_OPERATING_ACCOUNT_ID");
  const conversionActionId = numericId(requiredEnv("NEXUS_CORTEX_10_CONVERSION_ACTION_ID"), "NEXUS_CORTEX_10_CONVERSION_ACTION_ID");
  const login = process.env.NEXUS_CORTEX_10_LOGIN_ACCOUNT_ID?.trim();
  return Object.freeze({
    operatingAccountId,
    conversionActionId,
    ...(login ? { loginAccountId: numericId(login, "NEXUS_CORTEX_10_LOGIN_ACCOUNT_ID") } : {}),
  });
}

function accessTokenProviderFromFile(path: string): () => Promise<string> {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_10_ACCESS_TOKEN_FILE must be an absolute path");
  return async () => {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 16 || stat.size > MAX_TOKEN_FILE_BYTES) throw new Error("CORTEX #10 access-token file is not a bounded regular file");
    const value = readFileSync(path, "utf8").trim();
    if (value.length < 16 || value.length > 8192 || /[\r\n]/u.test(value)) throw new Error("CORTEX #10 access-token file contains an invalid token");
    return value;
  };
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`);
  return value;
}

export function createEnhancedConversionProductionRuntimeFromEnv(): EnhancedConversionProductionRuntime {
  const databasePath = requiredEnv("NEXUS_CORTEX_10_DATABASE");
  if (!isAbsolute(databasePath)) throw new Error("NEXUS_CORTEX_10_DATABASE must be an absolute path");
  const accessTokenFile = requiredEnv("NEXUS_CORTEX_10_ACCESS_TOKEN_FILE");
  const scope = scopeFromEnv();
  const destination = destinationFromEnv();
  const store = new SqliteOntologyTransactionStore(databasePath);
  const control = new DurableEnhancedConversionControl(store, scope);
  const gateway = new GoogleDataManagerRestClient({
    accessTokenProvider: accessTokenProviderFromFile(accessTokenFile),
    timeoutMs: integerEnv("NEXUS_CORTEX_10_DATA_MANAGER_TIMEOUT_MS", 15_000, 1_000, 120_000),
  });
  const engine = new DurableEnhancedConversionsPipeline(store, scope, destination, gateway, () => control.read().mode);
  const server = new EnhancedConversionProductionServer({
    engine,
    control,
    ingestToken: requiredEnv("NEXUS_CORTEX_10_INGEST_TOKEN"),
    controlToken: requiredEnv("NEXUS_CORTEX_10_CONTROL_TOKEN"),
    host: process.env.NEXUS_CORTEX_10_HOST?.trim() || "127.0.0.1",
    port: integerEnv("NEXUS_CORTEX_10_PORT", 8080, 1, 65_535),
  });
  let closed = false;
  return Object.freeze({
    store,
    control,
    engine,
    server,
    start: () => server.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      store.close();
    },
  });
}

export async function runEnhancedConversionProductionRuntimeFromEnv(): Promise<void> {
  const runtime = createEnhancedConversionProductionRuntimeFromEnv();
  await runtime.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runEnhancedConversionProductionRuntimeFromEnv().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-10-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

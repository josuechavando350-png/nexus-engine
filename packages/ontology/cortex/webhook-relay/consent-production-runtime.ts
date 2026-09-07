import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DurableWebhookRelay } from "./index";
import { loadConsentRelayProductionConfig } from "./consent-relay-config";
import { ConsentGuardedWebhookRelay, ConsentRegistryFailoverGateway, DurableConsentRegistry, type ConsentChannel, type RelayFailoverRoute } from "./consent-registry";
import { ConsentWebhookRelayProductionServer } from "./consent-production-server";
import { SqliteWebhookRelayControl } from "./runtime-control";

const MAX_SECRET_FILE_BYTES = 16 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`);
  return value;
}

function readSecretFile(path: string, label: string, minLength: number): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < minLength || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must be a bounded regular file`);
  const value = readFileSync(path, "utf8").trim();
  if (value.length < minLength || value.length > 8192 || /[\r\n]/u.test(value)) throw new Error(`${label} contains an invalid secret`);
  return value;
}

export interface ConsentWebhookRelayProductionRuntime {
  readonly control: SqliteWebhookRelayControl;
  readonly registry: DurableConsentRegistry;
  readonly relay: ConsentGuardedWebhookRelay;
  readonly server: ConsentWebhookRelayProductionServer;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createConsentWebhookRelayProductionRuntimeFromEnv(): ConsentWebhookRelayProductionRuntime {
  if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
  const databasePath = requiredEnv("NEXUS_CORTEX_11_DATABASE");
  if (databasePath === ":memory:" || !isAbsolute(databasePath)) throw new Error("NEXUS_CORTEX_11_DATABASE must be an absolute path on a durable mounted volume");
  const config = loadConsentRelayProductionConfig(requiredEnv("NEXUS_CORTEX_31_CONFIG"));
  const ingestToken = requiredEnv("NEXUS_CORTEX_11_INGEST_TOKEN");
  const controlToken = requiredEnv("NEXUS_CORTEX_11_CONTROL_TOKEN");
  const consentToken = requiredEnv("NEXUS_CORTEX_31_CONSENT_TOKEN");
  if (new Set([ingestToken, controlToken, consentToken]).size !== 3) throw new Error("ingest, control and consent credentials must be distinct");

  const routes = {} as Record<ConsentChannel, readonly RelayFailoverRoute[]>;
  for (const channel of ["WHATSAPP", "SMS", "OTHER"] as const) {
    routes[channel] = Object.freeze(config.routes[channel].map((entry, index) => {
      readSecretFile(entry.bearerTokenFile, `NEXUS_CORTEX_31_${channel}_${index}_BEARER_TOKEN_FILE`, 1);
      readSecretFile(entry.signingSecretFile, `NEXUS_CORTEX_31_${channel}_${index}_SIGNING_SECRET_FILE`, 32);
      return Object.freeze({
        endpoint: new URL(entry.endpoint),
        bearerToken: () => readSecretFile(entry.bearerTokenFile, `NEXUS_CORTEX_31_${channel}_${index}_BEARER_TOKEN_FILE`, 1),
        signingSecret: () => readSecretFile(entry.signingSecretFile, `NEXUS_CORTEX_31_${channel}_${index}_SIGNING_SECRET_FILE`, 32),
      });
    }));
  }

  const control = new SqliteWebhookRelayControl(databasePath);
  const registry = new DurableConsentRegistry(databasePath);
  const gateway = new ConsentRegistryFailoverGateway({
    registry,
    routes: Object.freeze(routes),
    timeoutMs: integerEnv("NEXUS_CORTEX_11_TIMEOUT_MS", 2_000, 100, 30_000),
    onOperationalEvent: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-31-relay", ...event })}\n`),
  });
  const base = new DurableWebhookRelay(databasePath, gateway, () => control.read().mode);
  const relay = new ConsentGuardedWebhookRelay(base, registry);
  const server = new ConsentWebhookRelayProductionServer({
    relay,
    registry,
    control,
    ingestToken,
    controlToken,
    consentToken,
    host: process.env.NEXUS_CORTEX_11_HOST?.trim() || "127.0.0.1",
    port: integerEnv("NEXUS_CORTEX_11_PORT", 8081, 1, 65_535),
  });
  let closed = false;
  return Object.freeze({
    control,
    registry,
    relay,
    server,
    start: () => server.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      base.close();
      registry.close();
      control.close();
    },
  });
}

export async function runConsentWebhookRelayProductionRuntimeFromEnv(): Promise<void> {
  const runtime = createConsentWebhookRelayProductionRuntimeFromEnv();
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
  runConsentWebhookRelayProductionRuntimeFromEnv().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-31-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

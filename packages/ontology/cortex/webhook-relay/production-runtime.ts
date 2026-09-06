import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DurableWebhookRelay, FetchWebhookRelayGateway, type RelayGateway, type RelayInput, type RelayReceipt } from "./index";
import { WebhookRelayProductionServer } from "./production-server";
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

class RotatingWebhookGateway implements RelayGateway {
  constructor(
    private readonly endpoint: URL,
    private readonly bearerTokenFile: string,
    private readonly signingSecretFile: string,
    private readonly timeoutMs: number,
  ) {}

  async send(event: RelayInput, digest: `sha256:${string}`): Promise<RelayReceipt> {
    const bearerToken = readSecretFile(this.bearerTokenFile, "NEXUS_CORTEX_11_BEARER_TOKEN_FILE", 1);
    const signingSecret = readSecretFile(this.signingSecretFile, "NEXUS_CORTEX_11_SIGNING_SECRET_FILE", 32);
    return new FetchWebhookRelayGateway(this.endpoint, bearerToken, signingSecret, this.timeoutMs).send(event, digest);
  }
}

export interface WebhookRelayProductionRuntime {
  readonly control: SqliteWebhookRelayControl;
  readonly relay: DurableWebhookRelay;
  readonly server: WebhookRelayProductionServer;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createWebhookRelayProductionRuntimeFromEnv(): WebhookRelayProductionRuntime {
  const databasePath = requiredEnv("NEXUS_CORTEX_11_DATABASE");
  if (!isAbsolute(databasePath)) throw new Error("NEXUS_CORTEX_11_DATABASE must be an absolute path");
  const endpoint = new URL(requiredEnv("NEXUS_CORTEX_11_ENDPOINT"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("NEXUS_CORTEX_11_ENDPOINT must be an HTTPS URL without credentials or fragment");
  const bearerTokenFile = requiredEnv("NEXUS_CORTEX_11_BEARER_TOKEN_FILE");
  const signingSecretFile = requiredEnv("NEXUS_CORTEX_11_SIGNING_SECRET_FILE");
  readSecretFile(bearerTokenFile, "NEXUS_CORTEX_11_BEARER_TOKEN_FILE", 1);
  readSecretFile(signingSecretFile, "NEXUS_CORTEX_11_SIGNING_SECRET_FILE", 32);

  const control = new SqliteWebhookRelayControl(databasePath);
  const gateway = new RotatingWebhookGateway(endpoint, bearerTokenFile, signingSecretFile, integerEnv("NEXUS_CORTEX_11_TIMEOUT_MS", 2_000, 100, 30_000));
  const relay = new DurableWebhookRelay(databasePath, gateway, () => control.read().mode);
  const server = new WebhookRelayProductionServer({
    relay,
    control,
    ingestToken: requiredEnv("NEXUS_CORTEX_11_INGEST_TOKEN"),
    controlToken: requiredEnv("NEXUS_CORTEX_11_CONTROL_TOKEN"),
    host: process.env.NEXUS_CORTEX_11_HOST?.trim() || "127.0.0.1",
    port: integerEnv("NEXUS_CORTEX_11_PORT", 8081, 1, 65_535),
  });
  let closed = false;
  return Object.freeze({
    control,
    relay,
    server,
    start: () => server.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      relay.close();
      control.close();
    },
  });
}

export async function runWebhookRelayProductionRuntimeFromEnv(): Promise<void> {
  const runtime = createWebhookRelayProductionRuntimeFromEnv();
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
  runWebhookRelayProductionRuntimeFromEnv().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-11-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

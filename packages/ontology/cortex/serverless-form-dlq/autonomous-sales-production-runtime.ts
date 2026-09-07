import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Cortex20Error,
  FetchLeadDestination,
  HttpDurableEventWriter,
  ServerlessFormIngress,
} from "./index.js";
import {
  AutonomousSalesLeadDestination,
  SqliteSalesAutomationAudit,
  createAutonomousSalesPolicy,
  type AutonomousSalesPolicy,
} from "./autonomous-sales.js";
import {
  HttpB2bEnrichmentProvider,
  HttpCapabilityGateProvider,
  HttpChannelDispatcher,
  HttpConsentRegistryProvider,
  HttpHumanHandoffDestination,
  LoopbackLocalSalesAssistant,
} from "./autonomous-sales-adapters.js";
import { startCortex20Server } from "./production-server.js";
import {
  Cortex20ProductionWorker,
  Cortex20WorkerError,
  HttpCortex17FormEventClient,
} from "./production-worker.js";
import { SqliteCortex20Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 8192;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function absolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function secretFile(env: NodeJS.ProcessEnv, name: string): string {
  const path = absolutePath(env, name);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${name} must reference a bounded regular secret file`);
  }
  const value = readFileSync(path, "utf8");
  if (
    Buffer.byteLength(value, "utf8") !== stat.size ||
    value.length < 32 ||
    value.length > MAX_SECRET_FILE_BYTES ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(`${name} contains invalid secret material`);
  }
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is invalid`);
  return value;
}

function httpsEndpoint(env: NodeJS.ProcessEnv, name: string): URL {
  const url = new URL(required(env, name));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(`${name} must be a credential-free HTTPS endpoint`);
  }
  return url;
}

function loopbackLlmEndpoint(env: NodeJS.ProcessEnv): URL {
  const url = new URL(required(env, "NEXUS_CORTEX_40_LOCAL_LLM_ENDPOINT"));
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.hash || url.search) {
    throw new Error("NEXUS_CORTEX_40_LOCAL_LLM_ENDPOINT must be a loopback-only HTTP endpoint");
  }
  return url;
}

function eventOrigin(env: NodeJS.ProcessEnv): URL {
  const url = new URL(required(env, "NEXUS_CORTEX_20_EVENT_ORIGIN"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") {
    throw new Error("NEXUS_CORTEX_20_EVENT_ORIGIN must be a credential-free HTTPS origin");
  }
  return url;
}

function policyFromEnv(env: NodeJS.ProcessEnv): AutonomousSalesPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(env, "NEXUS_CORTEX_40_POLICY_JSON")) as unknown;
  } catch (error) {
    throw new Error("NEXUS_CORTEX_40_POLICY_JSON must contain valid JSON", { cause: error });
  }
  return createAutonomousSalesPolicy(parsed as AutonomousSalesPolicy);
}

export interface Cortex40ProductionRuntime {
  close(): Promise<void>;
}

export function startCortex40ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex40ProductionRuntime {
  if (env.NEXUS_CORTEX_20_PERSISTENCE_ACK !== "durable-volume") {
    throw new Error("NEXUS_CORTEX_20_PERSISTENCE_ACK must equal durable-volume");
  }
  if (env.NEXUS_CORTEX_40_PERSISTENCE_ACK !== "durable-volume") {
    throw new Error("NEXUS_CORTEX_40_PERSISTENCE_ACK must equal durable-volume");
  }

  const databasePath = absolutePath(env, "NEXUS_CORTEX_20_DATABASE");
  const ingestToken = secretFile(env, "NEXUS_CORTEX_20_INGEST_TOKEN_FILE");
  const eventWriteToken = secretFile(env, "NEXUS_CORTEX_20_EVENT_WRITE_TOKEN_FILE");
  const eventReadToken = secretFile(env, "NEXUS_CORTEX_20_EVENT_READ_TOKEN_FILE");
  const primaryDestinationToken = secretFile(env, "NEXUS_CORTEX_20_DESTINATION_TOKEN_FILE");
  const encryptionKey = secretFile(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_FILE");
  const contactHashSecret = secretFile(env, "NEXUS_CORTEX_40_CONTACT_HASH_SECRET_FILE");
  const consentToken = secretFile(env, "NEXUS_CORTEX_40_CONSENT_TOKEN_FILE");
  const capabilityToken = secretFile(env, "NEXUS_CORTEX_40_CAPABILITY_TOKEN_FILE");
  const llmToken = secretFile(env, "NEXUS_CORTEX_40_LOCAL_LLM_TOKEN_FILE");
  const channelToken = secretFile(env, "NEXUS_CORTEX_40_CHANNEL_TOKEN_FILE");
  const handoffToken = secretFile(env, "NEXUS_CORTEX_40_HANDOFF_TOKEN_FILE");

  const policy = policyFromEnv(env);
  const enrichmentRequired = policy.forms.some((form) => form.enrichmentEnabled);
  const enrichmentToken = enrichmentRequired
    ? secretFile(env, "NEXUS_CORTEX_40_ENRICHMENT_TOKEN_FILE")
    : null;

  const allSecrets = [
    ingestToken,
    eventWriteToken,
    eventReadToken,
    primaryDestinationToken,
    encryptionKey,
    contactHashSecret,
    consentToken,
    capabilityToken,
    llmToken,
    channelToken,
    handoffToken,
    ...(enrichmentToken ? [enrichmentToken] : []),
  ];
  if (new Set(allSecrets).size !== allSecrets.length) {
    throw new Error("CORTEX #20/#40 production credentials must be distinct");
  }

  const keyId = required(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_ID");
  const consumerId = required(env, "NEXUS_CORTEX_20_CONSUMER_ID");
  if (!ID.test(keyId) || !ID.test(consumerId)) throw new Error("CORTEX #20 keyId/consumerId is invalid");

  const origin = eventOrigin(env);
  const control = new SqliteCortex20Control(databasePath);
  const assertWorkerMutationActive = () => {
    if (control.read().mode !== "ACTIVE") {
      throw new Cortex20WorkerError("KILLED", "CORTEX #20/#40 killed at final event mutation boundary");
    }
  };
  const assertIngressMutationActive = () => {
    if (control.read().mode !== "ACTIVE") {
      throw new Cortex20Error("QUEUE_FAILURE", "durable append disabled at final ingress boundary");
    }
  };

  const eventTimeout = integerEnv(env, "NEXUS_CORTEX_20_EVENT_TIMEOUT_MS", 5000, 100, 60_000);
  const eventWriter = new HttpDurableEventWriter(
    new URL("/v1/events", origin),
    eventWriteToken,
    Math.min(eventTimeout, 30_000),
    assertIngressMutationActive,
  );
  const ingress = new ServerlessFormIngress(eventWriter, encryptionKey, keyId);
  const eventClient = new HttpCortex17FormEventClient(
    origin,
    eventReadToken,
    eventWriteToken,
    eventTimeout,
    assertWorkerMutationActive,
  );

  const primaryDestination = new FetchLeadDestination(
    httpsEndpoint(env, "NEXUS_CORTEX_20_DESTINATION_ENDPOINT"),
    primaryDestinationToken,
    integerEnv(env, "NEXUS_CORTEX_20_DESTINATION_TIMEOUT_MS", 10_000, 100, 30_000),
  );

  let enrichment: HttpB2bEnrichmentProvider | null = null;
  if (enrichmentRequired) {
    const providerId = required(env, "NEXUS_CORTEX_40_ENRICHMENT_PROVIDER_ID");
    if (!ID.test(providerId)) throw new Error("NEXUS_CORTEX_40_ENRICHMENT_PROVIDER_ID is invalid");
    enrichment = new HttpB2bEnrichmentProvider({
      providerId,
      endpoint: httpsEndpoint(env, "NEXUS_CORTEX_40_ENRICHMENT_ENDPOINT"),
      bearerToken: enrichmentToken!,
      timeoutMs: integerEnv(env, "NEXUS_CORTEX_40_REMOTE_TIMEOUT_MS", 10_000, 1000, 120_000),
    });
    for (const form of policy.forms) {
      if (form.enrichmentEnabled && !form.allowedEnrichmentProviderIds.includes(providerId)) {
        throw new Error("CORTEX #40 configured enrichment provider is not allowed by every enrichment-enabled form policy");
      }
    }
  }

  const remoteTimeout = integerEnv(env, "NEXUS_CORTEX_40_REMOTE_TIMEOUT_MS", 10_000, 1000, 120_000);
  const consentRegistry = new HttpConsentRegistryProvider({
    endpoint: httpsEndpoint(env, "NEXUS_CORTEX_40_CONSENT_ENDPOINT"),
    bearerToken: consentToken,
    timeoutMs: remoteTimeout,
  });
  const capabilityGate = new HttpCapabilityGateProvider({
    endpoint: httpsEndpoint(env, "NEXUS_CORTEX_40_CAPABILITY_ENDPOINT"),
    bearerToken: capabilityToken,
    timeoutMs: remoteTimeout,
  });
  const assistant = new LoopbackLocalSalesAssistant({
    endpoint: loopbackLlmEndpoint(env),
    bearerToken: llmToken,
    timeoutMs: integerEnv(env, "NEXUS_CORTEX_40_LLM_TIMEOUT_MS", 20_000, 1000, 120_000),
  });
  const channelDispatcher = new HttpChannelDispatcher({
    endpoint: httpsEndpoint(env, "NEXUS_CORTEX_40_CHANNEL_ENDPOINT"),
    bearerToken: channelToken,
    timeoutMs: remoteTimeout,
  });
  const humanHandoff = new HttpHumanHandoffDestination({
    endpoint: httpsEndpoint(env, "NEXUS_CORTEX_40_HANDOFF_ENDPOINT"),
    bearerToken: handoffToken,
    timeoutMs: remoteTimeout,
  });

  const audit = new SqliteSalesAutomationAudit(databasePath);
  const destination = new AutonomousSalesLeadDestination(policy, audit, {
    primaryDestination,
    enrichment,
    consentRegistry,
    capabilityGate,
    assistant,
    channelDispatcher,
    humanHandoff,
    contactHashSecret,
    readMode: () => control.read().mode,
  });

  const worker = new Cortex20ProductionWorker({
    databasePath,
    eventClient,
    destination,
    encryptionKeyBase64: encryptionKey,
    encryptionKeyId: keyId,
    consumerId,
    maxAttempts: integerEnv(env, "NEXUS_CORTEX_20_MAX_ATTEMPTS", 5, 1, 20),
    baseRetryDelayMs: integerEnv(env, "NEXUS_CORTEX_20_RETRY_BASE_MS", 1000, 100, 60_000),
    readMode: () => control.read().mode,
  });

  let server: ReturnType<typeof startCortex20Server>;
  try {
    server = startCortex20Server({
      ingress,
      ingestToken,
      port: integerEnv(env, "NEXUS_CORTEX_20_PORT", 8820, 1, 65_535),
      host: "127.0.0.1",
      readMode: () => control.read().mode,
    });
  } catch (error) {
    worker.close();
    audit.close();
    control.close();
    throw error;
  }

  const intervalMs = integerEnv(env, "NEXUS_CORTEX_20_WORKER_INTERVAL_MS", 2000, 500, 3_600_000);
  let running = false;
  let closed = false;
  const timer = setInterval(() => {
    if (running || closed) return;
    try {
      if (control.read().mode !== "ACTIVE") return;
    } catch {
      return;
    }
    running = true;
    void worker.runOnce(50)
      .then((result) => {
        if (result.processed || result.delivered || result.dlq) {
          console.info(JSON.stringify({
            component: "cortex-40-sales-worker",
            processed: result.processed,
            delivered: result.delivered,
            dlq: result.dlq,
            deferred: result.deferred,
            offset: result.offset,
          }));
        }
      })
      .catch((error) => {
        console.error(JSON.stringify({ component: "cortex-40-sales-worker", error: error instanceof Error ? error.name : "UNKNOWN" }));
      })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();

  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        await server.close();
      } finally {
        worker.close();
        audit.close();
        control.close();
      }
    },
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const runtime = startCortex40ProductionRuntime();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-40-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

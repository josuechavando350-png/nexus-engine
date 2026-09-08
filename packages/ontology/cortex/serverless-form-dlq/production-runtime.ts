import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Cortex20Error, FetchLeadDestination, HttpDurableEventWriter, ServerlessFormIngress, type LeadDestination } from "./index.js";
import { KillGuardedLeadDestination } from "./production-destination.js";
import { startCortex20Server } from "./production-server.js";
import { Cortex20ProductionWorker, Cortex20WorkerError, HttpCortex17FormEventClient } from "./production-worker.js";
import { SqliteCortex20Control } from "./runtime-control.js";
import { FetchWebhookRelayGateway } from "../webhook-relay/index.js";
import { PymeConsentAwareLeadDestination, type PymeLeadRelayChannel } from "../pyme/consent-aware-relay.js";
import { SqlitePymeConsentRegistry } from "../pyme/consent-registry.js";
import { loadPymeProductionProfile } from "../pyme/production-profile.js";

const MAX_SECRET_FILE_BYTES = 8_192;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const CONSUMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]; if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`); return value;
}
function absolute(value: string, label: string): string { if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be an absolute path`); return value; }
function secretFile(path: string, label: string): string {
  absolute(path, label); const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must reference a bounded regular secret file with at least 32 bytes`);
  const value = readFileSync(path, "utf8"); if (Buffer.byteLength(value) !== stat.size || value.length < 32 || /[\r\n\0]/u.test(value)) throw new Error(`${label} contains invalid secret material`); return value;
}
function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name] ?? String(fallback); if (!/^\d+$/u.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is invalid`); return value;
}
function eventOrigin(env: NodeJS.ProcessEnv): URL {
  const url = new URL(required(env, "NEXUS_CORTEX_20_EVENT_ORIGIN"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") throw new Error("NEXUS_CORTEX_20_EVENT_ORIGIN must be a credential-free HTTPS origin");
  return url;
}
function destinationEndpoint(env: NodeJS.ProcessEnv): URL {
  const url = new URL(required(env, "NEXUS_CORTEX_20_DESTINATION_ENDPOINT"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("NEXUS_CORTEX_20_DESTINATION_ENDPOINT must be a credential-free HTTPS endpoint");
  return url;
}
function pymeChannel(env: NodeJS.ProcessEnv): PymeLeadRelayChannel {
  const value = required(env, "NEXUS_CORTEX_PYME_RELAY_CHANNEL").trim();
  if (!(value === "WEBHOOK" || value === "WHATSAPP" || value === "SMS")) throw new Error("NEXUS_CORTEX_PYME_RELAY_CHANNEL must be WEBHOOK, WHATSAPP or SMS");
  return value;
}
function pymeSubjectKind(env: NodeJS.ProcessEnv): "EMAIL" | "PHONE" | "OPAQUE" {
  const value = required(env, "NEXUS_CORTEX_PYME_RELAY_SUBJECT_KIND").trim();
  if (!(value === "EMAIL" || value === "PHONE" || value === "OPAQUE")) throw new Error("NEXUS_CORTEX_PYME_RELAY_SUBJECT_KIND is invalid");
  return value;
}
function pymeAllowedFields(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = required(env, "NEXUS_CORTEX_PYME_RELAY_ALLOWED_FIELDS");
  const fields = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (fields.length < 1 || fields.length > 64 || fields.some((entry) => !FIELD.test(entry)) || new Set(fields).size !== fields.length) throw new Error("NEXUS_CORTEX_PYME_RELAY_ALLOWED_FIELDS must contain 1..64 unique field names");
  return Object.freeze(fields);
}

export interface Cortex20ProductionRuntime { close(): Promise<void>; }
export function startCortex20ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex20ProductionRuntime {
  if (env.NEXUS_CORTEX_20_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_20_PERSISTENCE_ACK must equal durable-volume; ephemeral control/retry storage is refused");
  const profile = loadPymeProductionProfile(env);
  const databasePath = absolute(required(env, "NEXUS_CORTEX_20_DATABASE"), "NEXUS_CORTEX_20_DATABASE");
  const ingestToken = secretFile(required(env, "NEXUS_CORTEX_20_INGEST_TOKEN_FILE"), "NEXUS_CORTEX_20_INGEST_TOKEN_FILE");
  const eventWriteToken = secretFile(required(env, "NEXUS_CORTEX_20_EVENT_WRITE_TOKEN_FILE"), "NEXUS_CORTEX_20_EVENT_WRITE_TOKEN_FILE");
  const eventReadToken = secretFile(required(env, "NEXUS_CORTEX_20_EVENT_READ_TOKEN_FILE"), "NEXUS_CORTEX_20_EVENT_READ_TOKEN_FILE");
  const destinationToken = secretFile(required(env, "NEXUS_CORTEX_20_DESTINATION_TOKEN_FILE"), "NEXUS_CORTEX_20_DESTINATION_TOKEN_FILE");
  const encryptionKey = secretFile(required(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_FILE"), "NEXUS_CORTEX_20_ENCRYPTION_KEY_FILE");
  const coreSecrets = [ingestToken, eventWriteToken, eventReadToken, destinationToken, encryptionKey];
  if (new Set(coreSecrets).size !== coreSecrets.length) throw new Error("CORTEX #20 ingress/event/destination/encryption secrets must be distinct");
  const keyId = required(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_ID"); if (!KEY_ID.test(keyId)) throw new Error("NEXUS_CORTEX_20_ENCRYPTION_KEY_ID is invalid");
  const consumerId = required(env, "NEXUS_CORTEX_20_CONSUMER_ID"); if (!CONSUMER_ID.test(consumerId)) throw new Error("NEXUS_CORTEX_20_CONSUMER_ID is invalid");
  const origin = eventOrigin(env);
  const control = new SqliteCortex20Control(databasePath);
  const assertWorkerMutationActive = () => {
    if (control.read().mode !== "ACTIVE") throw new Cortex20WorkerError("KILLED", "CORTEX #20 killed at final event mutation boundary");
  };
  const assertIngressMutationActive = () => {
    if (control.read().mode !== "ACTIVE") throw new Cortex20Error("QUEUE_FAILURE", "durable append disabled by CORTEX #20 control at final POST boundary");
  };
  const eventWriter = new HttpDurableEventWriter(
    new URL("/v1/events", origin),
    eventWriteToken,
    integerEnv(env, "NEXUS_CORTEX_20_EVENT_TIMEOUT_MS", 5_000, 100, 30_000),
    assertIngressMutationActive,
  );
  const ingress = new ServerlessFormIngress(eventWriter, encryptionKey, keyId);
  const eventClient = new HttpCortex17FormEventClient(origin, eventReadToken, eventWriteToken, integerEnv(env, "NEXUS_CORTEX_20_EVENT_TIMEOUT_MS", 5_000, 100, 60_000), assertWorkerMutationActive);

  let pymeDestination: PymeConsentAwareLeadDestination | null = null;
  let pymeRegistry: SqlitePymeConsentRegistry | null = null;
  let rawDestination: LeadDestination;
  if (profile) {
    const privacyDatabase = absolute(required(env, "NEXUS_CORTEX_PYME_PRIVACY_DATABASE"), "NEXUS_CORTEX_PYME_PRIVACY_DATABASE");
    const signingSecret = secretFile(required(env, "NEXUS_CORTEX_PYME_WEBHOOK_SIGNING_SECRET_FILE"), "NEXUS_CORTEX_PYME_WEBHOOK_SIGNING_SECRET_FILE");
    if (coreSecrets.includes(signingSecret)) throw new Error("PyME webhook signing secret must be distinct from CORTEX #20 credentials");
    pymeRegistry = new SqlitePymeConsentRegistry(privacyDatabase);
    const gateway = new FetchWebhookRelayGateway(destinationEndpoint(env), destinationToken, signingSecret, integerEnv(env, "NEXUS_CORTEX_20_DESTINATION_TIMEOUT_MS", 10_000, 100, 30_000));
    pymeDestination = new PymeConsentAwareLeadDestination({
      databasePath: privacyDatabase,
      registry: pymeRegistry,
      gateway,
      channel: pymeChannel(env),
      purpose: required(env, "NEXUS_CORTEX_PYME_RELAY_PURPOSE").trim(),
      subjectField: required(env, "NEXUS_CORTEX_PYME_RELAY_SUBJECT_FIELD").trim(),
      subjectKind: pymeSubjectKind(env),
      allowedFields: pymeAllowedFields(env),
      modeProvider: () => control.read().mode,
      idempotencyContract: "EVENT_ID_IDEMPOTENT",
    });
    rawDestination = pymeDestination;
  } else {
    rawDestination = new FetchLeadDestination(destinationEndpoint(env), destinationToken, integerEnv(env, "NEXUS_CORTEX_20_DESTINATION_TIMEOUT_MS", 10_000, 100, 30_000));
  }
  const destination = new KillGuardedLeadDestination(rawDestination, () => control.read().mode);
  const worker = new Cortex20ProductionWorker({
    databasePath,
    eventClient,
    destination,
    encryptionKeyBase64: encryptionKey,
    encryptionKeyId: keyId,
    consumerId,
    maxAttempts: integerEnv(env, "NEXUS_CORTEX_20_MAX_ATTEMPTS", 5, 1, 20),
    baseRetryDelayMs: integerEnv(env, "NEXUS_CORTEX_20_RETRY_BASE_MS", 1_000, 100, 60_000),
    readMode: () => control.read().mode,
  });
  let server: ReturnType<typeof startCortex20Server>;
  try { server = startCortex20Server({ ingress, ingestToken, port: integerEnv(env, "NEXUS_CORTEX_20_PORT", 8820, 1, 65_535), host: "127.0.0.1", readMode: () => control.read().mode }); }
  catch (error) { worker.close(); pymeDestination?.close(); pymeRegistry?.close(); control.close(); throw error; }

  const workerIntervalMs = integerEnv(env, "NEXUS_CORTEX_20_WORKER_INTERVAL_MS", 2_000, 500, 3_600_000);
  let running = false; let closed = false;
  const timer = setInterval(() => {
    if (running || closed) return;
    let current: ReturnType<SqliteCortex20Control["read"]>;
    try { current = control.read(); } catch { return; }
    if (current.mode !== "ACTIVE") return;
    running = true;
    void worker.runOnce(50)
      .then((result) => { if (result.processed || result.dlq || result.delivered) console.info(JSON.stringify({ component: profile ? "cortex-pyme-20-31-worker" : "cortex-20-worker", processed: result.processed, delivered: result.delivered, dlq: result.dlq, deferred: result.deferred, offset: result.offset })); })
      .catch((error) => console.error(JSON.stringify({ component: profile ? "cortex-pyme-20-31-worker" : "cortex-20-worker", error: error instanceof Error ? error.name : "UNKNOWN" })))
      .finally(() => { running = false; });
  }, workerIntervalMs);
  timer.unref();

  return { async close() { if (closed) return; closed = true; clearInterval(timer); try { await server.close(); } finally { worker.close(); pymeDestination?.close(); pymeRegistry?.close(); control.close(); } } };
}

async function main(): Promise<void> {
  process.umask(0o077); const runtime = startCortex20ProductionRuntime(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(JSON.stringify({ component: "cortex-20-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
}

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRiskPolicy } from "./index.js";
import { createCompositeRiskPolicy, type CompositeRiskPolicy, type CompositeRiskSecrets } from "./composite-risk.js";
import { startCortex34CompositeRiskProxy } from "./composite-production-server.js";
import { SqliteRiskGateControl } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 4096;

export interface Cortex34ProductionConfig {
  readonly databasePath: string;
  readonly networkSecret: string;
  readonly compositePolicy: CompositeRiskPolicy;
  readonly compositeSecrets: CompositeRiskSecrets;
  readonly upstreamOrigin: string;
  readonly trustedProxyAddresses: readonly string[];
  readonly port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function absolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function readSecretPath(path: string, label: string): string {
  if (!isAbsolute(path) || /[\r\n\0]/u.test(path)) throw new Error(`${label} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must reference a regular secret file containing 32-4096 bytes`);
  const secret = readFileSync(path, "utf8");
  if (Buffer.byteLength(secret, "utf8") !== stat.size || secret.length < 32 || secret.length > MAX_SECRET_FILE_BYTES || /[\r\n\0]/u.test(secret)) throw new Error(`${label} secret contents are invalid`);
  return secret;
}

function readSecretFile(env: NodeJS.ProcessEnv, name: string): string {
  return readSecretPath(absolutePath(env, name), name);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8784;
  if (!/^\d+$/u.test(value)) throw new Error("NEXUS_CORTEX_34_PORT is invalid");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("NEXUS_CORTEX_34_PORT is invalid");
  return port;
}

function parseTrustedProxies(value: string | undefined): readonly string[] {
  if (value === undefined || value === "") return Object.freeze([]);
  if (/\s/u.test(value)) throw new Error("NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES must be a comma-separated list without whitespace");
  const values = value.split(",");
  if (values.some((entry) => entry.length === 0) || values.length > 32 || new Set(values).size !== values.length) throw new Error("NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES is invalid");
  return Object.freeze(values);
}

function parseJson(env: NodeJS.ProcessEnv, name: string): unknown {
  try { return JSON.parse(required(env, name)) as unknown; }
  catch (error) { throw new Error(`${name} must be valid JSON`, { cause: error }); }
}

function loadProviderSecrets(env: NodeJS.ProcessEnv, policy: CompositeRiskPolicy): Readonly<Record<string, string>> {
  const raw = parseJson(env, "NEXUS_CORTEX_34_PROVIDER_SECRET_FILES_JSON");
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("NEXUS_CORTEX_34_PROVIDER_SECRET_FILES_JSON must be a plain object");
  const paths = raw as Record<string, unknown>;
  const expected = [...policy.providers.map((provider) => provider.providerId)].sort();
  if (Object.keys(paths).sort().join(",") !== expected.join(",")) throw new Error("CORTEX #34 provider-secret file mapping must match policy providers exactly");
  const resolvedPaths = new Set<string>();
  const secrets: Record<string, string> = {};
  const secretValues = new Set<string>();
  for (const providerId of expected) {
    const path = paths[providerId];
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`CORTEX #34 secret path for ${providerId} must be absolute`);
    const resolved = resolve(path);
    if (resolvedPaths.has(resolved)) throw new Error("CORTEX #34 providers must use distinct secret files");
    resolvedPaths.add(resolved);
    const secret = readSecretPath(path, `CORTEX #34 provider ${providerId}`);
    if (secretValues.has(secret)) throw new Error("CORTEX #34 providers must use distinct secret values");
    secretValues.add(secret);
    secrets[providerId] = secret;
  }
  return Object.freeze(secrets);
}

export function loadCortex34ProductionConfig(env: NodeJS.ProcessEnv = process.env): Cortex34ProductionConfig {
  if (env.NEXUS_CORTEX_14_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_14_PERSISTENCE_ACK must equal durable-volume; ephemeral control storage is refused");
  const databasePath = absolutePath(env, "NEXUS_CORTEX_14_DATABASE");
  const networkSecret = readSecretFile(env, "NEXUS_CORTEX_14_NETWORK_KEY_SECRET_FILE");
  const networkContextSecret = readSecretFile(env, "NEXUS_CORTEX_34_NETWORK_CONTEXT_SECRET_FILE");
  if (networkSecret === networkContextSecret) throw new Error("CORTEX #34 network-key and network-context secrets must be distinct");

  const rawPolicy = parseJson(env, "NEXUS_CORTEX_34_POLICY_JSON") as CompositeRiskPolicy;
  const compositePolicy = createCompositeRiskPolicy(rawPolicy);
  parseRiskPolicy(compositePolicy.baseEnvelopePolicy);
  const providerSecrets = loadProviderSecrets(env, compositePolicy);
  if (Object.values(providerSecrets).includes(networkSecret) || Object.values(providerSecrets).includes(networkContextSecret)) throw new Error("CORTEX #34 provider, network-key, and network-context secrets must be distinct");

  const upstream = new URL(required(env, "NEXUS_CORTEX_14_UPSTREAM_ORIGIN"));
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("NEXUS_CORTEX_14_UPSTREAM_ORIGIN must be a credential-free HTTPS origin");

  return Object.freeze({
    databasePath,
    networkSecret,
    compositePolicy,
    compositeSecrets: Object.freeze({ providerSecrets, networkContextSecret }),
    upstreamOrigin: upstream.toString(),
    trustedProxyAddresses: parseTrustedProxies(env.NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES),
    port: parsePort(env.NEXUS_CORTEX_34_PORT),
  });
}

export function startCortex34ProductionRuntime(env: NodeJS.ProcessEnv = process.env): { close(): Promise<void> } {
  const config = loadCortex34ProductionConfig(env);
  const control = new SqliteRiskGateControl(config.databasePath);
  let server: ReturnType<typeof startCortex34CompositeRiskProxy>;
  try {
    server = startCortex34CompositeRiskProxy({
      networkSecret: config.networkSecret,
      compositePolicy: config.compositePolicy,
      compositeSecrets: config.compositeSecrets,
      upstreamOrigin: config.upstreamOrigin,
      trustedProxyAddresses: config.trustedProxyAddresses,
      port: config.port,
      host: "127.0.0.1",
      readMode: () => control.read().mode,
    });
  } catch (error) {
    control.close();
    throw error;
  }
  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try { await server.close(); }
      finally { control.close(); }
    },
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const runtime = startCortex34ProductionRuntime();
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await runtime.close(); };
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-34-composite-risk-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

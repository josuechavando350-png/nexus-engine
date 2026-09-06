import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRiskPolicy, type RiskPolicy } from "./index";
import { startCortex14RiskProxy } from "./production-server";
import { SqliteRiskGateControl } from "./runtime-control";

export interface Cortex14ProductionConfig {
  readonly databasePath: string;
  readonly signingSecret: string;
  readonly networkSecret: string;
  readonly policy: RiskPolicy;
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

function readSecretFile(env: NodeJS.ProcessEnv, name: string): string {
  const path = absolutePath(env, name);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > 4096) throw new Error(`${name} must reference a regular secret file containing 32-4096 bytes`);
  const secret = readFileSync(path, "utf8");
  if (Buffer.byteLength(secret, "utf8") !== stat.size || secret.length < 32 || secret.length > 4096 || /[\r\n\0]/u.test(secret)) {
    throw new Error(`${name} secret contents are invalid`);
  }
  return secret;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8784;
  if (!/^\d+$/u.test(value)) throw new Error("NEXUS_CORTEX_14_PORT is invalid");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("NEXUS_CORTEX_14_PORT is invalid");
  return port;
}

function parseTrustedProxies(value: string | undefined): readonly string[] {
  if (value === undefined || value === "") return Object.freeze([]);
  if (/\s/u.test(value)) throw new Error("NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES must be a comma-separated list without whitespace");
  const values = value.split(",");
  if (values.some((entry) => entry.length === 0) || values.length > 32 || new Set(values).size !== values.length) throw new Error("NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES is invalid");
  return Object.freeze(values);
}

export function loadCortex14ProductionConfig(env: NodeJS.ProcessEnv = process.env): Cortex14ProductionConfig {
  const databasePath = absolutePath(env, "NEXUS_CORTEX_14_DATABASE");
  const signingSecret = readSecretFile(env, "NEXUS_CORTEX_14_SIGNING_SECRET_FILE");
  const networkSecret = readSecretFile(env, "NEXUS_CORTEX_14_NETWORK_KEY_SECRET_FILE");
  if (signingSecret === networkSecret) throw new Error("CORTEX #14 signing and network-key secrets must be distinct");

  let parsedPolicy: unknown;
  try { parsedPolicy = JSON.parse(required(env, "NEXUS_CORTEX_14_POLICY_JSON")) as unknown; }
  catch (error) { throw new Error("NEXUS_CORTEX_14_POLICY_JSON must be valid JSON", { cause: error }); }
  const policy = parseRiskPolicy(parsedPolicy);

  const upstream = new URL(required(env, "NEXUS_CORTEX_14_UPSTREAM_ORIGIN"));
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("NEXUS_CORTEX_14_UPSTREAM_ORIGIN must be a credential-free HTTPS origin");
  }

  return Object.freeze({
    databasePath,
    signingSecret,
    networkSecret,
    policy,
    upstreamOrigin: upstream.toString(),
    trustedProxyAddresses: parseTrustedProxies(env.NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES),
    port: parsePort(env.NEXUS_CORTEX_14_PORT),
  });
}

export function startCortex14ProductionRuntime(env: NodeJS.ProcessEnv = process.env): { close(): Promise<void> } {
  const config = loadCortex14ProductionConfig(env);
  const control = new SqliteRiskGateControl(config.databasePath);
  let server: ReturnType<typeof startCortex14RiskProxy>;
  try {
    server = startCortex14RiskProxy({
      signingSecret: config.signingSecret,
      networkSecret: config.networkSecret,
      policy: config.policy,
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
  const runtime = startCortex14ProductionRuntime();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.close();
  };
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-14-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}

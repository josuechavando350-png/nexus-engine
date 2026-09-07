import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Cortex11Error } from "./index";
import type { ConsentChannel } from "./consent-registry";

const MAX_BYTES = 256 * 1024;

export interface ConsentRelayRouteConfig {
  readonly endpoint: string;
  readonly bearerTokenFile: string;
  readonly signingSecretFile: string;
}

export interface ConsentRelayProductionConfig {
  readonly version: 1;
  readonly routes: Readonly<Record<ConsentChannel, readonly ConsentRelayRouteConfig[]>>;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex11Error("INVALID_INPUT", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function route(value: unknown, label: string): ConsentRelayRouteConfig {
  const raw = plain(value, label);
  if (Object.keys(raw).sort().join(",") !== "bearerTokenFile,endpoint,signingSecretFile") throw new Cortex11Error("INVALID_INPUT", `${label} has unknown or missing fields`);
  if (typeof raw.endpoint !== "string") throw new Cortex11Error("INVALID_INPUT", `${label}.endpoint must be a string`);
  let endpoint: URL;
  try { endpoint = new URL(raw.endpoint); } catch { throw new Cortex11Error("INVALID_INPUT", `${label}.endpoint is invalid`); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Cortex11Error("INVALID_INPUT", `${label}.endpoint must be clean HTTPS`);
  for (const key of ["bearerTokenFile", "signingSecretFile"] as const) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key] as string)) throw new Cortex11Error("INVALID_INPUT", `${label}.${key} must be an absolute path`);
  }
  return Object.freeze({ endpoint: endpoint.toString(), bearerTokenFile: raw.bearerTokenFile as string, signingSecretFile: raw.signingSecretFile as string });
}

export function parseConsentRelayProductionConfig(value: unknown): ConsentRelayProductionConfig {
  const raw = plain(value, "consent relay config");
  if (Object.keys(raw).sort().join(",") !== "routes,version" || raw.version !== 1) throw new Cortex11Error("INVALID_INPUT", "consent relay config contract/version is invalid");
  const routesRaw = plain(raw.routes, "consent relay routes");
  if (Object.keys(routesRaw).sort().join(",") !== "OTHER,SMS,WHATSAPP") throw new Cortex11Error("INVALID_INPUT", "consent relay routes must define WHATSAPP, SMS and OTHER exactly");
  const routes = {} as Record<ConsentChannel, readonly ConsentRelayRouteConfig[]>;
  for (const channel of ["WHATSAPP", "SMS", "OTHER"] as const) {
    const list = routesRaw[channel];
    if (!Array.isArray(list) || list.length < 1 || list.length > 4) throw new Cortex11Error("INVALID_INPUT", `${channel} routes must contain 1..4 entries`);
    routes[channel] = Object.freeze(list.map((entry, index) => route(entry, `${channel}[${index}]`)));
  }
  return Object.freeze({ version: 1, routes: Object.freeze(routes) });
}

export function loadConsentRelayProductionConfig(path: string): ConsentRelayProductionConfig {
  if (!isAbsolute(path)) throw new Cortex11Error("INVALID_INPUT", "NEXUS_CORTEX_31_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new Cortex11Error("INVALID_INPUT", `consent relay config must be a regular file of 1..${MAX_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new Cortex11Error("INVALID_INPUT", "consent relay config contains malformed JSON"); }
  return parseConsentRelayProductionConfig(value);
}

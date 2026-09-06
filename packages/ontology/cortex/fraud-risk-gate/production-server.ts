import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  Cortex14Error,
  computeRiskNetworkKeyHash,
  evaluateSignedRiskEnvelopeForNetwork,
  parseRiskPolicy,
  type RiskPolicy,
} from "./index.js";
import type { RiskGateMode } from "./runtime-control.js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 8_192;
const MAX_UPSTREAM_RESPONSE_BYTES = 2_097_152;
const MAX_CONNECTION_HEADER_BYTES = 2_048;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface Cortex14RiskProxyConfig {
  readonly signingSecret: string;
  readonly networkSecret: string;
  readonly policy: RiskPolicy;
  readonly upstreamOrigin: URL | string;
  readonly trustedProxyAddresses?: readonly string[];
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => RiskGateMode;
}

function validateSecret(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function normalizeRemoteAddress(value: string | undefined): string {
  if (!value || value.length > 128 || /[\r\n\0]/u.test(value)) throw new Cortex14Error("INVALID_INPUT", "request remote address is unavailable or malformed");
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
}

export function parseTrustedProxyAddresses(values: readonly string[] | undefined): ReadonlySet<string> {
  if (!values?.length) return new Set();
  if (values.length > 32) throw new Error("CORTEX #14 trusted proxy list is too large");
  const entries = values.map((entry) => normalizeRemoteAddress(entry.trim()));
  if (new Set(entries).size !== entries.length) throw new Error("CORTEX #14 trusted proxy list contains duplicates");
  return new Set(entries);
}

function secureEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function trustedProxyNetworkKey(request: IncomingMessage, networkSecret: string, trustedProxies: ReadonlySet<string>): string {
  const remote = normalizeRemoteAddress(request.socket.remoteAddress);
  if (!trustedProxies.has(remote)) return remote;

  const asserted = request.headers["x-nexus-client-network-key"];
  const signature = request.headers["x-nexus-client-network-signature"];
  if (typeof asserted !== "string" || asserted.length < 1 || asserted.length > 256 || /[\r\n\0]/u.test(asserted)) throw new Cortex14Error("NETWORK_MISMATCH", "trusted proxy client network assertion is missing or malformed");
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(signature)) throw new Cortex14Error("NETWORK_MISMATCH", "trusted proxy network assertion signature is missing or malformed");
  const expected = `sha256=${createHmac("sha256", networkSecret).update(`client-network\0${asserted}`, "utf8").digest("hex")}`;
  if (!secureEqualText(signature, expected)) throw new Cortex14Error("NETWORK_MISMATCH", "trusted proxy network assertion signature mismatch");
  return asserted;
}

function decodeEnvelope(header: string | string[] | undefined): unknown {
  if (typeof header !== "string" || header.length < 8 || header.length > MAX_ENVELOPE_BYTES * 2 || !BASE64URL.test(header)) {
    throw new Cortex14Error("INVALID_INPUT", "risk envelope header is missing, oversized, or malformed");
  }
  const decoded = Buffer.from(header, "base64url");
  if (decoded.length > MAX_ENVELOPE_BYTES || decoded.toString("base64url") !== header) {
    throw new Cortex14Error("INVALID_INPUT", "risk envelope encoding is not canonical base64url");
  }
  try {
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new Cortex14Error("INVALID_INPUT", "risk envelope JSON is malformed");
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex14Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Cortex14Error("INVALID_INPUT", "request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBoundedUpstreamBody(response: Response, maxBytes = MAX_UPSTREAM_RESPONSE_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error("CORTEX_14_UPSTREAM_RESPONSE_LIMIT_INVALID");
  const declared = response.headers.get("content-length");
  if (declared !== null && (/^\d+$/u.test(declared) ? Number(declared) > maxBytes : true)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("CORTEX_14_UPSTREAM_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("CORTEX_14_UPSTREAM_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(encoded);
}

function connectionHopByHopNames(value: string | string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const values = Array.isArray(value) ? value : [value];
  if (values.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0) > MAX_CONNECTION_HEADER_BYTES) {
    throw new Cortex14Error("INVALID_INPUT", "Connection header is oversized");
  }
  const names = new Set<string>();
  for (const raw of values) {
    for (const item of raw.split(",")) {
      const token = item.trim();
      if (!token || !HTTP_TOKEN.test(token)) throw new Cortex14Error("INVALID_INPUT", "Connection header contains an invalid hop-by-hop token");
      names.add(token.toLowerCase());
    }
  }
  return names;
}

function upstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "x-nexus-risk-envelope",
    "x-nexus-client-network-key",
    "x-nexus-client-network-signature",
  ]);
  for (const name of connectionHopByHopNames(request.headers.connection)) blocked.add(name);
  for (const [name, value] of Object.entries(request.headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

export function fixedUpstreamTarget(upstream: URL, requestUrl: string | undefined): URL {
  const raw = requestUrl ?? "/";
  if (!raw.startsWith("/") || /[\r\n\0#]/u.test(raw)) throw new Cortex14Error("INVALID_INPUT", "request target must use origin-form syntax");
  const queryAt = raw.indexOf("?");
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const search = queryAt === -1 ? "" : raw.slice(queryAt);
  if (pathname.length < 1 || pathname.length > 8_192 || search.length > 8_192) throw new Cortex14Error("INVALID_INPUT", "request target is oversized");
  const target = new URL(upstream);
  target.pathname = pathname;
  target.search = search;
  target.hash = "";
  return target;
}

function failClosedMode(readMode: () => RiskGateMode): RiskGateMode {
  try {
    const value = readMode();
    return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED";
  } catch {
    return "KILLED";
  }
}

export function startCortex14RiskProxy(config: Cortex14RiskProxyConfig): { close(): Promise<void> } {
  const signingSecret = validateSecret(config.signingSecret, "CORTEX #14 signing secret");
  const networkSecret = validateSecret(config.networkSecret, "CORTEX #14 network-key secret");
  if (secureEqualText(signingSecret, networkSecret)) throw new Error("CORTEX #14 signing and network-key secrets must be distinct");
  const configuredPolicy = parseRiskPolicy(config.policy);
  const upstream = new URL(config.upstreamOrigin);
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("CORTEX #14 upstream must be a credential-free HTTPS origin");
  const trustedProxies = parseTrustedProxyAddresses(config.trustedProxyAddresses);
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error("CORTEX #14 port is invalid");
  if (config.host !== undefined && config.host !== "127.0.0.1") throw new Error("CORTEX #14 host must be 127.0.0.1");
  if (typeof config.readMode !== "function") throw new Error("CORTEX #14 durable control reader is required");
  const host = config.host ?? "127.0.0.1";

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        const healthMode = failClosedMode(config.readMode);
        return json(response, healthMode === "KILLED" ? 503 : 200, { mode: healthMode });
      }
      if (!request.method || !ALLOWED_METHODS.has(request.method)) return json(response, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: [...ALLOWED_METHODS].join(", ") });
      if (failClosedMode(config.readMode) === "KILLED") return json(response, 503, { error: "KILLED" });

      const networkKey = trustedProxyNetworkKey(request, networkSecret, trustedProxies);
      const expectedNetworkKeyHash = computeRiskNetworkKeyHash(networkKey, networkSecret);
      const decision = evaluateSignedRiskEnvelopeForNetwork(
        decodeEnvelope(request.headers["x-nexus-risk-envelope"]),
        signingSecret,
        configuredPolicy,
        expectedNetworkKeyHash,
      );

      const enforcementMode = failClosedMode(config.readMode);
      if (enforcementMode === "KILLED") return json(response, 503, { error: "KILLED" });
      console.info(JSON.stringify({ component: "cortex-14-risk-gate", mode: enforcementMode, action: decision.action }));
      if (enforcementMode === "ACTIVE" && decision.action === "DENY") return json(response, 403, { error: "RISK_DENIED" });
      if (enforcementMode === "ACTIVE" && decision.action === "CHALLENGE") return json(response, 429, { error: "RISK_CHALLENGE" }, { "x-nexus-challenge-required": "1" });

      const target = fixedUpstreamTarget(upstream, request.url);
      const body = await readBody(request);
      const upstreamBody: ArrayBuffer | undefined = body === undefined ? undefined : Uint8Array.from(body).buffer as ArrayBuffer;
      if (failClosedMode(config.readMode) === "KILLED") return json(response, 503, { error: "KILLED" });
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders(request),
        body: upstreamBody,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const responseBody = request.method === "HEAD" ? Buffer.alloc(0) : await readBoundedUpstreamBody(upstreamResponse);
      const responseHeaders: Record<string, string> = {
        "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-store",
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(responseBody.length),
        "x-nexus-risk-action": decision.action,
      };
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(request.method === "HEAD" ? undefined : responseBody);
    } catch (error) {
      if (error instanceof Cortex14Error) {
        const status = error.code === "INVALID_SIGNATURE" || error.code === "NETWORK_MISMATCH" ? 403 : 400;
        return json(response, status, { error: error.code });
      }
      console.error(JSON.stringify({ component: "cortex-14-risk-gate", error: "INTERNAL" }));
      json(response, 502, { error: "UPSTREAM_FAILURE" });
    }
  });
  server.listen(config.port, host);
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

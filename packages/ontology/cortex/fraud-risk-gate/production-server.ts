import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  Cortex14Error,
  computeRiskNetworkKeyHash,
  evaluateSignedRiskEnvelopeForNetwork,
  type RiskPolicy,
} from "./index";

const MAX_BODY_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 8_192;
const MAX_UPSTREAM_RESPONSE_BYTES = 2_097_152;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
type Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

function mode(): Mode {
  const raw = process.env.NEXUS_CORTEX_14_MODE;
  return raw === "ACTIVE" || raw === "OBSERVE_ONLY" ? raw : "KILLED";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function policy(): RiskPolicy {
  const parsed = JSON.parse(required("NEXUS_CORTEX_14_POLICY_JSON")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("NEXUS_CORTEX_14_POLICY_JSON is invalid");
  return parsed as RiskPolicy;
}

export function normalizeRemoteAddress(value: string | undefined): string {
  if (!value || value.length > 128 || /[\r\n\0]/u.test(value)) throw new Cortex14Error("INVALID_INPUT", "request remote address is unavailable or malformed");
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
}

function parseTrustedProxies(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) return new Set();
  const entries = value.split(",").map((entry) => normalizeRemoteAddress(entry.trim()));
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length || entries.length > 32) throw new Error("NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES is invalid");
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
  if (typeof header !== "string" || header.length < 8 || header.length > MAX_ENVELOPE_BYTES * 2) throw new Cortex14Error("INVALID_INPUT", "risk envelope header is missing or oversized");
  const decoded = Buffer.from(header, "base64url");
  if (decoded.length > MAX_ENVELOPE_BYTES) throw new Cortex14Error("INVALID_INPUT", "risk envelope is oversized");
  return JSON.parse(decoded.toString("utf8")) as unknown;
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

function upstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const blocked = new Set([
    "connection",
    "host",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "x-nexus-risk-envelope",
    "x-nexus-client-network-key",
    "x-nexus-client-network-signature",
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

export function fixedUpstreamTarget(upstream: URL, requestUrl: string | undefined): URL {
  const incoming = new URL(requestUrl ?? "/", "http://proxy.invalid");
  const target = new URL(upstream);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = "";
  return target;
}

export function startCortex14RiskProxy(): { close(): Promise<void> } {
  const signingSecret = required("NEXUS_CORTEX_14_SIGNING_SECRET");
  const networkSecret = required("NEXUS_CORTEX_14_NETWORK_KEY_SECRET");
  if (signingSecret.length < 32) throw new Error("NEXUS_CORTEX_14_SIGNING_SECRET must contain at least 32 characters");
  if (networkSecret.length < 32) throw new Error("NEXUS_CORTEX_14_NETWORK_KEY_SECRET must contain at least 32 characters");
  if (secureEqualText(signingSecret, networkSecret)) throw new Error("CORTEX #14 signing and network-key secrets must be distinct");
  const configuredPolicy = policy();
  const upstream = new URL(required("NEXUS_CORTEX_14_UPSTREAM_ORIGIN"));
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("NEXUS_CORTEX_14_UPSTREAM_ORIGIN must be a credential-free HTTPS origin");
  const trustedProxies = parseTrustedProxies(process.env.NEXUS_CORTEX_14_TRUSTED_PROXY_ADDRESSES);
  const port = Number(process.env.NEXUS_CORTEX_14_PORT ?? "8784");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("NEXUS_CORTEX_14_PORT is invalid");

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return json(response, mode() === "KILLED" ? 503 : 200, { mode: mode() });
      if (!request.method || !ALLOWED_METHODS.has(request.method)) return json(response, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: [...ALLOWED_METHODS].join(", ") });
      const initialMode = mode();
      if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });

      const networkKey = trustedProxyNetworkKey(request, networkSecret, trustedProxies);
      const expectedNetworkKeyHash = computeRiskNetworkKeyHash(networkKey, networkSecret);
      const decision = evaluateSignedRiskEnvelopeForNetwork(
        decodeEnvelope(request.headers["x-nexus-risk-envelope"]),
        signingSecret,
        configuredPolicy,
        expectedNetworkKeyHash,
      );

      const finalMode = mode();
      if (finalMode === "KILLED") return json(response, 503, { error: "KILLED" });
      console.info(JSON.stringify({ component: "cortex-14-risk-gate", mode: finalMode, action: decision.action, assessmentId: decision.assessmentId, providerId: decision.providerId, riskScore: decision.riskScore }));
      if (finalMode === "ACTIVE" && decision.action === "DENY") return json(response, 403, { error: "RISK_DENIED", assessmentId: decision.assessmentId });
      if (finalMode === "ACTIVE" && decision.action === "CHALLENGE") return json(response, 429, { error: "RISK_CHALLENGE", assessmentId: decision.assessmentId }, { "x-nexus-challenge-required": "1" });

      const target = fixedUpstreamTarget(upstream, request.url);
      const body = await readBody(request);
      if (mode() === "KILLED") return json(response, 503, { error: "KILLED" });
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders(request),
        body,
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
  server.listen(port, "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startCortex14RiskProxy();

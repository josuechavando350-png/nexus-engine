import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { computeRiskNetworkKeyHash, Cortex14Error } from "./index.js";
import { evaluateCompositeRisk, CompositeRiskError, type CompositeRiskPolicy, type CompositeRiskSecrets } from "./composite-risk.js";
import type { RiskGateMode } from "./runtime-control.js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_COMPOSITE_ENVELOPE_BYTES = 64 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 2_097_152;
const MAX_CONNECTION_HEADER_BYTES = 2_048;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface Cortex34CompositeRiskProxyConfig {
  readonly networkSecret: string;
  readonly compositePolicy: CompositeRiskPolicy;
  readonly compositeSecrets: CompositeRiskSecrets;
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

function secureEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (!value || value.length > 128 || /[\r\n\0]/u.test(value)) throw new Cortex14Error("INVALID_INPUT", "request remote address is unavailable or malformed");
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function trustedProxySet(values: readonly string[] | undefined): ReadonlySet<string> {
  if (!values?.length) return new Set();
  if (values.length > 32) throw new Error("CORTEX #34 trusted proxy list is too large");
  const entries = values.map((entry) => normalizeRemoteAddress(entry.trim()));
  if (new Set(entries).size !== entries.length) throw new Error("CORTEX #34 trusted proxy list contains duplicates");
  return new Set(entries);
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

function decodeCompositeEnvelope(header: string | string[] | undefined): unknown {
  if (typeof header !== "string" || header.length < 8 || header.length > MAX_COMPOSITE_ENVELOPE_BYTES * 2 || !BASE64URL.test(header)) throw new CompositeRiskError("INVALID_INPUT", "composite risk envelope header is missing, oversized, or malformed");
  const decoded = Buffer.from(header, "base64url");
  if (decoded.length > MAX_COMPOSITE_ENVELOPE_BYTES || decoded.toString("base64url") !== header) throw new CompositeRiskError("INVALID_INPUT", "composite risk envelope encoding is not canonical base64url");
  try { return JSON.parse(decoded.toString("utf8")) as unknown; }
  catch { throw new CompositeRiskError("INVALID_INPUT", "composite risk envelope JSON is malformed"); }
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
    if (total > MAX_BODY_BYTES) { request.destroy(); throw new Cortex14Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function boundedUpstreamBody(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_UPSTREAM_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("CORTEX_34_UPSTREAM_RESPONSE_TOO_LARGE");
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
      if (total > MAX_UPSTREAM_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("CORTEX_34_UPSTREAM_RESPONSE_TOO_LARGE"); }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(encoded);
}

function connectionHopByHopNames(value: string | string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const values = Array.isArray(value) ? value : [value];
  if (values.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0) > MAX_CONNECTION_HEADER_BYTES) throw new Cortex14Error("INVALID_INPUT", "Connection header is oversized");
  const names = new Set<string>();
  for (const raw of values) for (const item of raw.split(",")) {
    const token = item.trim();
    if (!token || !HTTP_TOKEN.test(token)) throw new Cortex14Error("INVALID_INPUT", "Connection header contains an invalid hop-by-hop token");
    names.add(token.toLowerCase());
  }
  return names;
}

function upstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const blocked = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-nexus-risk-envelope", "x-nexus-composite-risk", "x-nexus-client-network-key", "x-nexus-client-network-signature"]);
  for (const name of connectionHopByHopNames(request.headers.connection)) blocked.add(name);
  for (const [name, value] of Object.entries(request.headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item); else headers.set(name, value);
  }
  return headers;
}

function fixedUpstreamTarget(upstream: URL, requestUrl: string | undefined): URL {
  const raw = requestUrl ?? "/";
  if (!raw.startsWith("/") || /[\r\n\0#]/u.test(raw)) throw new Cortex14Error("INVALID_INPUT", "request target must use origin-form syntax");
  const queryAt = raw.indexOf("?");
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const search = queryAt === -1 ? "" : raw.slice(queryAt);
  if (pathname.length < 1 || pathname.length > 8192 || search.length > 8192) throw new Cortex14Error("INVALID_INPUT", "request target is oversized");
  const target = new URL(upstream); target.pathname = pathname; target.search = search; target.hash = ""; return target;
}

function failClosedMode(readMode: () => RiskGateMode): RiskGateMode {
  try { const value = readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; }
  catch { return "KILLED"; }
}

export function startCortex34CompositeRiskProxy(config: Cortex34CompositeRiskProxyConfig): { close(): Promise<void> } {
  const networkSecret = validateSecret(config.networkSecret, "CORTEX #34 network-key secret");
  validateSecret(config.compositeSecrets.networkContextSecret, "CORTEX #34 network-context secret");
  if (secureEqualText(networkSecret, config.compositeSecrets.networkContextSecret)) throw new Error("CORTEX #34 network-key and network-context secrets must be distinct");
  const upstream = new URL(config.upstreamOrigin);
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("CORTEX #34 upstream must be a credential-free HTTPS origin");
  const trustedProxies = trustedProxySet(config.trustedProxyAddresses);
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("CORTEX #34 port is invalid");
  const host = config.host ?? "127.0.0.1";

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        const mode = failClosedMode(config.readMode);
        return json(response, mode === "KILLED" ? 503 : 200, { mode });
      }
      if (!request.method || !ALLOWED_METHODS.has(request.method)) return json(response, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: [...ALLOWED_METHODS].join(", ") });
      if (failClosedMode(config.readMode) === "KILLED") return json(response, 503, { error: "KILLED" });

      const networkKey = trustedProxyNetworkKey(request, networkSecret, trustedProxies);
      const expectedNetworkKeyHash = computeRiskNetworkKeyHash(networkKey, networkSecret);
      const decision = evaluateCompositeRisk(decodeCompositeEnvelope(request.headers["x-nexus-composite-risk"]) as never, config.compositePolicy, config.compositeSecrets, expectedNetworkKeyHash);

      const enforcementMode = failClosedMode(config.readMode);
      if (enforcementMode === "KILLED") return json(response, 503, { error: "KILLED" });
      console.info(JSON.stringify({ component: "cortex-34-composite-risk", mode: enforcementMode, action: decision.action, score: decision.compositeScore, families: decision.presentFamilies.length, networkClass: decision.networkClass }));
      if (enforcementMode === "ACTIVE" && decision.action === "DENY") return json(response, 403, { error: "RISK_DENIED" });
      if (enforcementMode === "ACTIVE" && decision.action === "CHALLENGE") return json(response, 429, { error: "RISK_CHALLENGE" }, { "x-nexus-challenge-required": "1" });

      const target = fixedUpstreamTarget(upstream, request.url);
      const body = await readBody(request);
      if (failClosedMode(config.readMode) === "KILLED") return json(response, 503, { error: "KILLED" });
      const upstreamResponse = await fetch(target, { method: request.method, headers: upstreamHeaders(request), body: body === undefined ? undefined : Uint8Array.from(body).buffer as ArrayBuffer, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const responseBody = request.method === "HEAD" ? Buffer.alloc(0) : await boundedUpstreamBody(upstreamResponse);
      response.writeHead(upstreamResponse.status, { "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-store", "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream", "content-length": String(responseBody.length), "x-nexus-risk-action": decision.action, "x-nexus-risk-score": String(decision.compositeScore) });
      response.end(request.method === "HEAD" ? undefined : responseBody);
    } catch (error) {
      if (error instanceof CompositeRiskError) return json(response, error.code === "INTEGRITY_FAILURE" ? 403 : 400, { error: error.code });
      if (error instanceof Cortex14Error) return json(response, error.code === "INVALID_SIGNATURE" || error.code === "NETWORK_MISMATCH" ? 403 : 400, { error: error.code });
      console.error(JSON.stringify({ component: "cortex-34-composite-risk", error: "INTERNAL" }));
      return json(response, 502, { error: "UPSTREAM_FAILURE" });
    }
  });
  server.listen(config.port, host);
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

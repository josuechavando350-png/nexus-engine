import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Cortex19Error, SqliteCouponIssuer, type CouponPolicy } from "./index.js";
import type { Cortex19Mode } from "./runtime-control.js";

const MAX_BODY_BYTES = 262_144;
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

export interface Cortex19ServerConfig {
  readonly issuer: SqliteCouponIssuer;
  readonly apiToken: string;
  readonly policy: CouponPolicy;
  readonly allowedModelDigests: ReadonlyMap<string, string>;
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => Cortex19Mode;
}

function secureText(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b); }
function authorized(request: IncomingMessage, expected: string): boolean { const header = request.headers.authorization; return typeof header === "string" && header.startsWith("Bearer ") && secureEqual(header.slice(7), expected); }
function mode(readMode: () => Cortex19Mode): Cortex19Mode { try { const value = readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; } catch { return "KILLED"; } }

function target(request: IncomingMessage): URL {
  const raw = request.url ?? "/";
  if (!REQUEST_TARGET.test(raw) || raw.includes("#")) throw new Cortex19Error("INVALID_INPUT", "request target must use bounded origin-form syntax");
  return new URL(raw, "http://127.0.0.1");
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex19Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex19Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > MAX_BODY_BYTES) { request.destroy(); throw new Cortex19Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Cortex19Error("INVALID_INPUT", "request body must contain valid JSON"); }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(encoded);
}
function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof Cortex19Error) {
    const status = error.code === "CONFLICT" ? 409 : error.code === "KILLED" ? 503 : error.code === "INTEGRITY_FAILURE" ? 500 : 400;
    return send(response, status, { error: error.code });
  }
  console.error(JSON.stringify({ component: "cortex-19-server", error: "INTERNAL" }));
  send(response, 500, { error: "INTERNAL" });
}

function requestPayload(value: unknown): { request: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19Error("INVALID_INPUT", "coupon API body must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "request" || !raw.request || typeof raw.request !== "object" || Array.isArray(raw.request)) throw new Cortex19Error("INVALID_INPUT", "coupon API body contract is invalid");
  return { request: raw.request as Record<string, unknown> };
}
function assertAllowedModel(request: Record<string, unknown>, allowed: ReadonlyMap<string, string>): void {
  const evidence = request.probabilityEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Cortex19Error("INVALID_INPUT", "probability evidence is required");
  const raw = evidence as Record<string, unknown>;
  if (typeof raw.modelId !== "string" || !MODEL_ID.test(raw.modelId) || typeof raw.modelDigest !== "string" || !SHA256.test(raw.modelDigest)) throw new Cortex19Error("INVALID_INPUT", "probability model provenance is malformed");
  const expected = allowed.get(raw.modelId);
  if (!expected || !secureEqual(expected, raw.modelDigest)) throw new Cortex19Error("INVALID_INPUT", "probability model provenance is not approved by production policy");
}

export function startCortex19Server(config: Cortex19ServerConfig): { close(): Promise<void> } {
  const apiToken = secureText(config.apiToken, "CORTEX #19 API token");
  if (!config.issuer || typeof config.readMode !== "function" || !config.policy || !(config.allowedModelDigests instanceof Map) || config.allowedModelDigests.size < 1 || config.allowedModelDigests.size > 64) throw new Error("CORTEX #19 server configuration is invalid");
  for (const [modelId, digest] of config.allowedModelDigests) if (!MODEL_ID.test(modelId) || !SHA256.test(digest)) throw new Error("CORTEX #19 allowed model configuration is invalid");
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535 || (config.host !== undefined && config.host !== "127.0.0.1")) throw new Error("CORTEX #19 server port/host is invalid");

  const server = createServer(async (request, response) => {
    try {
      const url = target(request);
      if (request.method === "GET" && url.pathname === "/healthz") { const current = mode(config.readMode); return send(response, current === "KILLED" ? 503 : 200, { mode: current }); }
      if (request.method === "POST" && url.pathname === "/v1/coupons/issue") {
        if (!authorized(request, apiToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const current = mode(config.readMode); if (current === "KILLED") return send(response, 503, { error: "KILLED" });
        const payload = requestPayload(await readJson(request));
        assertAllowedModel(payload.request, config.allowedModelDigests);
        const result = config.issuer.issue(payload.request, config.policy);
        console.info(JSON.stringify({ component: "cortex-19-coupon", mode: current, action: result.action, reason: result.reason, discountBps: result.discountBps, hasCode: result.code !== null }));
        return send(response, 200, { mode: current, result });
      }
      return send(response, 404, { error: "NOT_FOUND" });
    } catch (error) { errorResponse(response, error); }
  });
  server.listen(config.port, config.host ?? "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

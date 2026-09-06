import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Cortex14Error, evaluateSignedRiskEnvelope, type RiskPolicy } from "./index";

const MAX_BODY_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 8_192;
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

function decodeEnvelope(header: string | string[] | undefined): unknown {
  if (typeof header !== "string" || header.length < 8 || header.length > MAX_ENVELOPE_BYTES * 2) throw new Cortex14Error("INVALID_INPUT", "risk envelope header is missing or oversized");
  const decoded = Buffer.from(header, "base64url");
  if (decoded.length > MAX_ENVELOPE_BYTES) throw new Cortex14Error("INVALID_INPUT", "risk envelope is oversized");
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
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

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(encoded);
}

function upstreamHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const blocked = new Set(["connection", "host", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "x-nexus-risk-envelope"]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

export function startCortex14RiskProxy(): { close(): Promise<void> } {
  const signingSecret = required("NEXUS_CORTEX_14_SIGNING_SECRET");
  if (signingSecret.length < 32) throw new Error("NEXUS_CORTEX_14_SIGNING_SECRET must contain at least 32 characters");
  const configuredPolicy = policy();
  const upstream = new URL(required("NEXUS_CORTEX_14_UPSTREAM_ORIGIN"));
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("NEXUS_CORTEX_14_UPSTREAM_ORIGIN must be an HTTPS origin");
  const port = Number(process.env.NEXUS_CORTEX_14_PORT ?? "8784");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("NEXUS_CORTEX_14_PORT is invalid");

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return json(response, mode() === "KILLED" ? 503 : 200, { mode: mode() });
      const initialMode = mode();
      if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });
      const decision = evaluateSignedRiskEnvelope(decodeEnvelope(request.headers["x-nexus-risk-envelope"]), signingSecret, configuredPolicy);

      // Re-read control at the enforcement boundary. OBSERVE_ONLY records the
      // verified decision but intentionally does not block traffic.
      const finalMode = mode();
      if (finalMode === "KILLED") return json(response, 503, { error: "KILLED" });
      console.info(JSON.stringify({ component: "cortex-14-risk-gate", mode: finalMode, action: decision.action, assessmentId: decision.assessmentId, providerId: decision.providerId, riskScore: decision.riskScore }));
      if (finalMode === "ACTIVE" && decision.action === "DENY") return json(response, 403, { error: "RISK_DENIED", assessmentId: decision.assessmentId });
      if (finalMode === "ACTIVE" && decision.action === "CHALLENGE") return json(response, 429, { error: "RISK_CHALLENGE", assessmentId: decision.assessmentId }, { "x-nexus-challenge-required": "1" });

      const incomingUrl = new URL(request.url ?? "/", "http://proxy.local");
      const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, upstream);
      const body = await readBody(request);
      if (mode() === "KILLED") return json(response, 503, { error: "KILLED" });
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders(request),
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      const responseHeaders: Record<string, string> = {
        "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-store",
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(responseBody.length),
        "x-nexus-risk-action": decision.action,
      };
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(request.method === "HEAD" ? undefined : responseBody);
    } catch (error) {
      if (error instanceof Cortex14Error) return json(response, error.code === "INVALID_SIGNATURE" ? 403 : 400, { error: error.code });
      console.error(JSON.stringify({ component: "cortex-14-risk-gate", error: "INTERNAL" }));
      json(response, 502, { error: "UPSTREAM_FAILURE" });
    }
  });
  server.listen(port, "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startCortex14RiskProxy();

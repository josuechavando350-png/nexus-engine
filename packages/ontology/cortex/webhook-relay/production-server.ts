import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Cortex11Error, DurableWebhookRelay, observeRelayInput, type RelayMode } from "./index";
import { RelayControlError, SqliteWebhookRelayControl } from "./runtime-control";

const JSON_TYPE = "application/json";
const MAX_BODY_BYTES = 64 * 1024;

export interface WebhookRelayProductionServerOptions {
  readonly relay: DurableWebhookRelay;
  readonly control: SqliteWebhookRelayControl;
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
}

function secret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (normalized.length < 24 || normalized.length > 4096) throw new Error(`${label} must contain 24..4096 characters`);
  return createHash("sha256").update(normalized, "utf8").digest();
}

function authorized(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(raw.slice(7), "utf8").digest();
  return supplied.length === expectedDigest.length && timingSafeEqual(supplied, expectedDigest);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.length),
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== JSON_TYPE) throw new Cortex11Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex11Error("INVALID_INPUT", "request body is too large");
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.resume();
      throw new Cortex11Error("INVALID_INPUT", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new Cortex11Error("INVALID_INPUT", "request body is required");
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; }
  catch { throw new Cortex11Error("INVALID_INPUT", "request body contains malformed JSON"); }
}

function pathOf(request: IncomingMessage): string {
  try { return new URL(request.url ?? "/", "http://localhost").pathname; }
  catch { return "/__invalid__"; }
}

function controlInput(value: unknown): { mode: RelayMode; expectedRevision: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new RelayControlError("INVALID_INPUT", "control request must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "expectedRevision,mode") throw new RelayControlError("INVALID_INPUT", "control request contract is invalid");
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED") || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new RelayControlError("INVALID_INPUT", "control request values are invalid");
  return { mode: raw.mode, expectedRevision: raw.expectedRevision as number };
}

function rollbackInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex11Error("INVALID_INPUT", "rollback request must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).join(",") !== "eventId" || typeof raw.eventId !== "string") throw new Cortex11Error("INVALID_INPUT", "rollback request contract is invalid");
  return raw.eventId;
}

export class WebhookRelayProductionServer {
  private server: Server | null = null;
  private readonly ingestDigest: Buffer;
  private readonly controlDigest: Buffer;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: WebhookRelayProductionServerOptions) {
    if (options.ingestToken.trim() === options.controlToken.trim()) throw new Error("ingestToken and controlToken must be distinct credentials");
    this.ingestDigest = secret(options.ingestToken, "ingestToken");
    this.controlDigest = secret(options.controlToken, "controlToken");
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8081;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535) throw new Error("port must be an integer from 0 to 65535");
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("webhook relay server is already running");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 20_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("webhook relay server has no TCP address");
    return Object.freeze({ host: address.address, port: address.port });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = pathOf(request);
      if (request.method === "GET" && path === "/healthz") {
        json(response, 200, { status: "ok", mode: this.options.control.read().mode });
        return;
      }
      if (path === "/v1/webhook-relay/control") {
        if (!authorized(request, this.controlDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
        if (request.method === "GET") return json(response, 200, this.options.control.read());
        if (request.method === "POST") {
          const input = controlInput(await readJson(request));
          return json(response, 200, this.options.control.setMode(input.mode, input.expectedRevision));
        }
        return json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      }
      if (!authorized(request, this.ingestDigest)) return json(response, 401, { error: "UNAUTHORIZED" });

      if (request.method === "POST" && path === "/v1/webhook-relay/events") {
        const initialMode = this.options.control.read().mode;
        if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });
        const input = await readJson(request);
        if (initialMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", observation: observeRelayInput(input) });
        const finalMode = this.options.control.read().mode;
        if (finalMode === "KILLED") return json(response, 503, { error: "KILLED" });
        if (finalMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", observation: observeRelayInput(input) });
        const prepared = this.options.relay.prepare(input);
        try {
          const result = await this.options.relay.dispatch(prepared.eventId);
          return json(response, result.status === "SENT" ? 202 : 200, { status: result.status, digest: result.digest, remoteRequestId: result.remoteRequestId });
        } catch (error) {
          if (error instanceof Cortex11Error && error.code === "AMBIGUOUS_OUTCOME") return json(response, 202, { status: "AMBIGUOUS", digest: prepared.digest });
          throw error;
        }
      }

      if (request.method === "POST" && path === "/v1/webhook-relay/rollback") {
        const eventId = rollbackInput(await readJson(request));
        const result = this.options.relay.rollback(eventId);
        return json(response, 200, { status: result.status, digest: result.digest });
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof Cortex11Error || error instanceof RelayControlError ? error.code : "INTERNAL";
      const status = error instanceof RelayControlError && error.code === "CONFLICT" ? 409
        : error instanceof Cortex11Error && error.code === "CONFLICT" ? 409
          : error instanceof Cortex11Error && error.code === "CONSENT_VIOLATION" ? 403
            : error instanceof Cortex11Error && (error.code === "KILLED" || error.code === "MODE_BLOCKED") ? 503
              : error instanceof Cortex11Error && error.code === "REMOTE_REJECTED" ? 502
                : error instanceof Cortex11Error || error instanceof RelayControlError ? 400 : 500;
      json(response, status, { error: code });
    }
  }
}

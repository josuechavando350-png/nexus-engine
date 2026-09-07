import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Cortex11Error, type RelayMode } from "./index";
import { ConsentGuardedWebhookRelay, DurableConsentRegistry, type ConsentChannel, type ConsentRegistryStatus } from "./consent-registry";
import { RelayControlError, SqliteWebhookRelayControl } from "./runtime-control";

const MAX_BODY_BYTES = 64 * 1024;

export interface ConsentWebhookRelayProductionServerOptions {
  readonly relay: ConsentGuardedWebhookRelay;
  readonly registry: DurableConsentRegistry;
  readonly control: SqliteWebhookRelayControl;
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly consentToken: string;
  readonly host?: string;
  readonly port?: number;
}

function secret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096) throw new Error(`${label} must contain 32..4096 characters`);
  return createHash("sha256").update(normalized, "utf8").digest();
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(raw.slice(7), "utf8").digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex11Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex11Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) { request.resume(); throw new Cortex11Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(bytes);
  }
  if (!total) throw new Cortex11Error("INVALID_INPUT", "request body is required");
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; }
  catch { throw new Cortex11Error("INVALID_INPUT", "request body contains malformed JSON"); }
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex11Error("INVALID_INPUT", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function controlInput(value: unknown): { mode: RelayMode; expectedRevision: number } {
  const raw = plain(value, "control request");
  if (Object.keys(raw).sort().join(",") !== "expectedRevision,mode") throw new RelayControlError("INVALID_INPUT", "control request contract is invalid");
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED") || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new RelayControlError("INVALID_INPUT", "control request values are invalid");
  return { mode: raw.mode, expectedRevision: raw.expectedRevision as number };
}

function rollbackInput(value: unknown): string {
  const raw = plain(value, "rollback request");
  if (Object.keys(raw).join(",") !== "eventId" || typeof raw.eventId !== "string") throw new Cortex11Error("INVALID_INPUT", "rollback request contract is invalid");
  return raw.eventId;
}

function consentInput(value: unknown): { subjectKey: string; channel: ConsentChannel; status: ConsentRegistryStatus; policyId: string; expectedRevision: number; changedAt: string } {
  const raw = plain(value, "consent request");
  if (Object.keys(raw).sort().join(",") !== "changedAt,channel,expectedRevision,policyId,status,subjectKey") throw new Cortex11Error("INVALID_INPUT", "consent request contract is invalid");
  if (typeof raw.subjectKey !== "string" || typeof raw.policyId !== "string" || typeof raw.changedAt !== "string") throw new Cortex11Error("INVALID_INPUT", "consent request strings are invalid");
  if (!(raw.channel === "WHATSAPP" || raw.channel === "SMS" || raw.channel === "OTHER")) throw new Cortex11Error("INVALID_INPUT", "consent channel is invalid");
  if (!(raw.status === "GRANTED" || raw.status === "OPTED_OUT")) throw new Cortex11Error("INVALID_INPUT", "consent status is invalid");
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new Cortex11Error("INVALID_INPUT", "consent expectedRevision is invalid");
  return { subjectKey: raw.subjectKey, channel: raw.channel, status: raw.status, policyId: raw.policyId, expectedRevision: raw.expectedRevision as number, changedAt: raw.changedAt };
}

export class ConsentWebhookRelayProductionServer {
  private server: Server | null = null;
  private readonly ingestDigest: Buffer;
  private readonly controlDigest: Buffer;
  private readonly consentDigest: Buffer;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: ConsentWebhookRelayProductionServerOptions) {
    const raw = [options.ingestToken.trim(), options.controlToken.trim(), options.consentToken.trim()];
    if (new Set(raw).size !== raw.length) throw new Error("ingest, control and consent credentials must be distinct");
    this.ingestDigest = secret(options.ingestToken, "ingestToken");
    this.controlDigest = secret(options.controlToken, "controlToken");
    this.consentDigest = secret(options.consentToken, "consentToken");
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8081;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535) throw new Error("port must be 0..65535");
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("consent webhook relay server is already running");
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
    if (!address || typeof address === "string") throw new Error("consent webhook relay server has no TCP address");
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
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/healthz") return json(response, 200, { status: "ok", mode: this.options.control.read().mode });

      if (path === "/v1/webhook-relay/control") {
        if (!authorized(request, this.controlDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
        if (request.method === "GET") return json(response, 200, this.options.control.read());
        if (request.method === "POST") return json(response, 200, this.options.control.setMode(...Object.values(controlInput(await readJson(request))) as [RelayMode, number]));
        return json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      }

      if (request.method === "POST" && path === "/v1/webhook-relay/consent") {
        if (!authorized(request, this.consentDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
        return json(response, 200, this.options.registry.set(consentInput(await readJson(request))));
      }

      if (!authorized(request, this.ingestDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
      if (request.method === "POST" && path === "/v1/webhook-relay/events") {
        const initialMode = this.options.control.read().mode;
        if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });
        const input = await readJson(request);
        if (initialMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", observation: this.options.relay.observe(input) });
        const finalMode = this.options.control.read().mode;
        if (finalMode === "KILLED") return json(response, 503, { error: "KILLED" });
        if (finalMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", observation: this.options.relay.observe(input) });
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
        const result = this.options.relay.rollback(rollbackInput(await readJson(request)));
        return json(response, 200, { status: result.status, digest: result.digest });
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof Cortex11Error || error instanceof RelayControlError ? error.code : "INTERNAL";
      const status = code === "CONFLICT" ? 409
        : code === "CONSENT_VIOLATION" ? 403
          : code === "KILLED" || code === "MODE_BLOCKED" ? 503
            : code === "REMOTE_REJECTED" ? 502
              : code === "INTERNAL" ? 500 : 400;
      return json(response, status, { error: code });
    }
  }
}

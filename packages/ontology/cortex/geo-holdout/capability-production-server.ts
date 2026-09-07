import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { analyzeGeoHoldout, designGeoHoldout, Cortex12Error, type GeoOutcome } from "./index";
import { CapabilityGatedGeoExperimentRegistry, GeoCapabilityGateError, evaluateGeoCapabilityGate, type GeoCapabilityGateInput } from "./capability-gate";
import { GeoExperimentRegistryError } from "./registry";
import { GeoHoldoutControlError, SqliteGeoHoldoutControl, type GeoHoldoutMode } from "./runtime-control";

const MAX_BODY_BYTES = 256 * 1024;

export interface CapabilityGeoHoldoutProductionServerOptions {
  readonly registry: CapabilityGatedGeoExperimentRegistry;
  readonly control: SqliteGeoHoldoutControl;
  readonly experimentToken: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
}

function secret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (normalized.length < 24 || normalized.length > 4096 || /[\r\n]/u.test(normalized)) throw new Error(`${label} must contain one 24..4096 character secret`);
  return createHash("sha256").update(normalized, "utf8").digest();
}
function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(raw.slice(7), "utf8").digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(encoded.length), "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" });
  response.end(encoded);
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex12Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex12Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += bytes.length; if (total > MAX_BODY_BYTES) { request.resume(); throw new Cortex12Error("INVALID_INPUT", "request body is too large"); } chunks.push(bytes); }
  if (!total) throw new Cortex12Error("INVALID_INPUT", "request body is required");
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; } catch { throw new Cortex12Error("INVALID_INPUT", "request body contains malformed JSON"); }
}
function plain(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex12Error("INVALID_INPUT", "request must be a plain object"); return value as Record<string, unknown>; }
function controlInput(value: unknown): { mode: GeoHoldoutMode; expectedRevision: number } {
  const raw = plain(value);
  if (Object.keys(raw).sort().join(",") !== "expectedRevision,mode" || !(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED") || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new GeoHoldoutControlError("INVALID_INPUT", "control request is invalid");
  return { mode: raw.mode, expectedRevision: raw.expectedRevision as number };
}
function analysisInput(value: unknown): { experimentId: string; outcomes: readonly GeoOutcome[] } {
  const raw = plain(value);
  if (Object.keys(raw).sort().join(",") !== "experimentId,outcomes" || typeof raw.experimentId !== "string" || !Array.isArray(raw.outcomes)) throw new Cortex12Error("INVALID_INPUT", "analysis request is invalid");
  return { experimentId: raw.experimentId, outcomes: raw.outcomes as readonly GeoOutcome[] };
}

export class CapabilityGeoHoldoutProductionServer {
  private server: Server | null = null;
  private readonly experimentDigest: Buffer;
  private readonly controlDigest: Buffer;
  private readonly host: string;
  private readonly port: number;
  constructor(private readonly options: CapabilityGeoHoldoutProductionServerOptions) {
    if (options.experimentToken.trim() === options.controlToken.trim()) throw new Error("experimentToken and controlToken must be distinct credentials");
    this.experimentDigest = secret(options.experimentToken, "experimentToken"); this.controlDigest = secret(options.controlToken, "controlToken");
    this.host = options.host ?? "127.0.0.1"; this.port = options.port ?? 8082;
  }
  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("capability geo server is already running");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.port, this.host, () => { server.off("error", reject); resolve(); }); });
    this.server = server; const address = server.address(); if (!address || typeof address === "string") throw new Error("capability geo server has no TCP address");
    return Object.freeze({ host: address.address, port: address.port });
  }
  async close(): Promise<void> { const server = this.server; this.server = null; if (!server) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/healthz") return json(response, 200, { status: "ok", mode: this.options.control.read().mode });
      if (path === "/v1/geo-holdout/control") {
        if (!authorized(request, this.controlDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
        if (request.method === "GET") return json(response, 200, this.options.control.read());
        if (request.method === "POST") { const input = controlInput(await readJson(request)); return json(response, 200, this.options.control.setMode(input.mode, input.expectedRevision)); }
        return json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      }
      if (!authorized(request, this.experimentDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
      if (request.method === "POST" && path === "/v1/geo-holdout/design") {
        const initialMode = this.options.control.read().mode; if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });
        const input = await readJson(request) as GeoCapabilityGateInput;
        const gate = evaluateGeoCapabilityGate(input); const design = designGeoHoldout(input.design);
        if (initialMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", gate, design });
        const finalMode = this.options.control.read().mode; if (finalMode === "KILLED") return json(response, 503, { error: "KILLED" });
        if (finalMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", gate, design });
        if (gate.status !== "ALLOWED") return json(response, 422, { status: "CAPABILITY_BLOCKED", gate, design });
        const registered = this.options.registry.register(input);
        return json(response, 201, { status: "REGISTERED", gate: registered.gate, design: registered.experiment.design, createdAt: registered.experiment.createdAt });
      }
      if (request.method === "POST" && path === "/v1/geo-holdout/analyze") {
        const initialMode = this.options.control.read().mode; if (initialMode === "KILLED") return json(response, 503, { error: "KILLED" });
        const input = analysisInput(await readJson(request)); const registered = this.options.registry.get(input.experimentId); if (!registered) return json(response, 404, { error: "NOT_FOUND" });
        const analysis = analyzeGeoHoldout({ design: registered.design, outcomes: input.outcomes });
        if (initialMode === "OBSERVE_ONLY") return json(response, 200, { status: "OBSERVED", analysis });
        const finalMode = this.options.control.read().mode; if (finalMode !== "ACTIVE") return finalMode === "KILLED" ? json(response, 503, { error: "KILLED" }) : json(response, 200, { status: "OBSERVED", analysis });
        const record = this.options.registry.analyze(input.experimentId, input.outcomes); return json(response, 200, { status: "ANALYZED", analysis: record.analysis, updatedAt: record.updatedAt });
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof GeoCapabilityGateError || error instanceof Cortex12Error || error instanceof GeoExperimentRegistryError || error instanceof GeoHoldoutControlError ? error.code : "INTERNAL";
      const status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "CAPABILITY_BLOCKED" || code === "DESIGN_REJECTED" ? 422 : code === "MODE_BLOCKED" ? 503 : code === "INTERNAL" ? 500 : 400;
      return json(response, status, { error: code });
    }
  }
}

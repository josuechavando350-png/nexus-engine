import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import {
  BiddingSupervisorError,
  PeriodicGoogleAdsBiddingSupervisor,
  createBiddingSupervisorPolicy,
  type BiddingSupervisorMode,
  type BiddingSupervisorPolicy,
  type BiddingSupervisorResult,
  type BusinessProfitabilityProvider,
  type CreateBiddingSupervisorPolicyInput,
  type GoogleAdsBiddingGateway,
} from "./index";
import { BiddingRuntimeController, BiddingRuntimeControlError } from "./runtime-control";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const NUMERIC_ID = /^\d{5,20}$/u;
const POLICY_KEYS = new Set([
  "policyId", "version", "observationWindowDays", "reportingLagDays", "cooldownMs", "maxBusinessDataAgeMs",
  "minimumCostMicros", "minimumGoogleConversions", "increaseVolumeProfitToSpendRatio", "decreaseRiskProfitToSpendRatio",
  "budgetStepFraction", "targetStepFraction", "bidBoundStepFraction", "minBudgetMicros", "maxBudgetMicros",
  "minTargetCpaMicros", "maxTargetCpaMicros", "minTargetRoas", "maxTargetRoas", "minPortfolioCpcCeilingMicros",
  "maxPortfolioCpcCeilingMicros", "allowSharedBudgets", "managePortfolioBidBounds", "mode", "maxWriteRetries",
]);

export interface BiddingProductionCampaign { readonly customerId: string; readonly campaignId: string }
export interface BiddingProductionConfig {
  readonly version: 1;
  readonly scope: OntologyScope;
  readonly intervalMs: number;
  readonly policy: CreateBiddingSupervisorPolicyInput;
  readonly campaigns: readonly BiddingProductionCampaign[];
}
export interface BiddingRuntimeTelemetryEvent {
  readonly operation: "CYCLE" | "CAMPAIGN" | "ROLLBACK" | "CONTROL_READ" | "CONTROL_WRITE" | "HEALTH";
  readonly status: "OK" | "REJECTED" | "FAILED" | "SKIPPED";
  readonly trigger: "STARTUP" | "SCHEDULED" | "MANUAL" | null;
  readonly customerId: string | null;
  readonly campaignId: string | null;
  readonly reason: string | null;
  readonly mode: BiddingSupervisorMode | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
}
export interface BiddingProductionRuntimeOptions {
  readonly transactions: OntologyTransactionPort;
  readonly config: BiddingProductionConfig;
  readonly googleAds: GoogleAdsBiddingGateway;
  readonly profitability: BusinessProfitabilityProvider;
  readonly apiToken: string;
  readonly now?: () => number;
  readonly onTelemetry?: (event: BiddingRuntimeTelemetryEvent) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}
export interface BiddingProductionRuntime {
  readonly server: Server;
  readonly policy: BiddingSupervisorPolicy;
  runOnce(trigger: "STARTUP" | "SCHEDULED" | "MANUAL"): Promise<readonly BiddingSupervisorResult[]>;
  start(runImmediately?: boolean): void;
  close(): Promise<void>;
}

class HttpRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); this.name = "HttpRequestError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}
function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
  return item.trim();
}
function scopeFrom(value: unknown): OntologyScope {
  const raw = object(value, "scope");
  exactKeys(raw, new Set(["tenantId", "organizationId", "brandId"]), "scope");
  const tenantId = stringField(raw, "tenantId", "scope");
  const organizationId = stringField(raw, "organizationId", "scope");
  const brandId = raw.brandId;
  if (!IDENTIFIER.test(tenantId) || !IDENTIFIER.test(organizationId)) throw new Error("scope identifiers are malformed");
  if (brandId !== undefined && (typeof brandId !== "string" || !IDENTIFIER.test(brandId.trim()))) throw new Error("scope.brandId is malformed");
  return Object.freeze({ tenantId, organizationId, ...(brandId === undefined ? {} : { brandId: brandId.trim() }) });
}
function numericId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_ID.test(normalized)) throw new Error(`${label} is malformed`);
  return normalized;
}
function policyFrom(value: unknown): CreateBiddingSupervisorPolicyInput {
  const raw = object(value, "policy");
  exactKeys(raw, POLICY_KEYS, "policy");
  const input = raw as unknown as CreateBiddingSupervisorPolicyInput;
  createBiddingSupervisorPolicy(input);
  return input;
}

export function parseBiddingProductionConfig(value: unknown): BiddingProductionConfig {
  const raw = object(value, "bidding production config");
  exactKeys(raw, new Set(["version", "scope", "intervalMs", "policy", "campaigns"]), "bidding production config");
  if (raw.version !== 1) throw new Error("bidding production config version must be 1");
  const intervalMs = raw.intervalMs;
  if (!Number.isSafeInteger(intervalMs) || (intervalMs as number) < 300_000 || (intervalMs as number) > 86_400_000) throw new Error("intervalMs must be 300000..86400000");
  const campaignsInput = raw.campaigns;
  if (!Array.isArray(campaignsInput) || campaignsInput.length < 1 || campaignsInput.length > 100) throw new Error("campaigns must contain 1..100 items");
  const campaigns = campaignsInput.map((item, index) => {
    const campaign = object(item, `campaigns[${index}]`);
    exactKeys(campaign, new Set(["customerId", "campaignId"]), `campaigns[${index}]`);
    return Object.freeze({
      customerId: numericId(stringField(campaign, "customerId", `campaigns[${index}]`), `campaigns[${index}].customerId`),
      campaignId: numericId(stringField(campaign, "campaignId", `campaigns[${index}]`), `campaigns[${index}].campaignId`),
    });
  });
  const identities = campaigns.map((item) => `${item.customerId}:${item.campaignId}`);
  if (new Set(identities).size !== identities.length) throw new Error("campaigns must be unique");
  return Object.freeze({ version: 1, scope: scopeFrom(raw.scope), intervalMs: intervalMs as number, policy: policyFrom(raw.policy), campaigns: Object.freeze(campaigns) });
}

export function loadBiddingProductionConfig(path: string): BiddingProductionConfig {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_BIDDING_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) throw new Error(`bidding config must be a regular file of 1..${MAX_CONFIG_BYTES} bytes`);
  return parseBiddingProductionConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function validateToken(value: string): Buffer {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096) throw new Error("NEXUS_CORTEX_API_TOKEN must contain 32..4096 characters");
  return Buffer.from(value, "utf8");
}
function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(raw.slice(7), "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function jsonContentType(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  return typeof raw === "string" && raw.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!jsonContentType(request)) throw new HttpRequestError(415, "content-type must be application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) { request.resume(); throw new HttpRequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`); }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new HttpRequestError(400, "request body is required");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpRequestError(400, "request body contains malformed JSON"); }
  try { return object(parsed, "request body"); }
  catch (error) { throw new HttpRequestError(400, error instanceof Error ? error.message : "request body is invalid"); }
}
function requestExact(value: Record<string, unknown>, allowed: readonly string[]): void {
  try { exactKeys(value, new Set(allowed), "request body"); }
  catch (error) { throw new HttpRequestError(400, error instanceof Error ? error.message : "request body is invalid"); }
}
function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}
function statusFor(error: unknown): number {
  if (error instanceof HttpRequestError) return error.statusCode;
  if (error instanceof BiddingRuntimeControlError) return error.code === "CONFLICT" ? 409 : error.code === "PERSISTENCE_FAILURE" || error.code === "INTEGRITY_FAILURE" ? 503 : 400;
  if (error instanceof BiddingSupervisorError) return error.code === "CONFLICT" ? 409 : error.code === "PERSISTENCE_FAILURE" || error.code === "INTEGRITY_FAILURE" || error.code === "REMOTE_FAILURE" ? 503 : 400;
  return 500;
}
function codeFor(error: unknown): string {
  if (error instanceof BiddingRuntimeControlError || error instanceof BiddingSupervisorError) return error.code;
  if (error instanceof HttpRequestError) return "INVALID_HTTP_REQUEST";
  return "UNEXPECTED";
}
function controlPayload(control: BiddingRuntimeController) {
  return Object.freeze({
    state: control.current(),
    effectiveMode: control.effectiveMode(),
    configuredMode: control.configuredMode,
    currentPolicyDigest: control.policyDigest,
    history: control.history(64),
  });
}

export function createBiddingProductionRuntime(options: BiddingProductionRuntimeOptions): BiddingProductionRuntime {
  const expectedToken = validateToken(options.apiToken);
  const now = options.now ?? Date.now;
  const policy = createBiddingSupervisorPolicy(options.config.policy);
  const control = new BiddingRuntimeController(options.transactions, options.config.scope, policy.digest, policy.mode, now);
  let rollbackWriteAuthorized = false;
  const guardedGoogleAds: GoogleAdsBiddingGateway = Object.freeze({
    getCampaignSnapshot: (customerId, campaignId, startMs, endMs) => options.googleAds.getCampaignSnapshot(customerId, campaignId, startMs, endMs),
    getPortfolioSnapshot: (customerId, resourceName, startMs, endMs) => options.googleAds.getPortfolioSnapshot(customerId, resourceName, startMs, endMs),
    applyMutation: async (customerId, action) => {
      const effectiveMode = control.effectiveMode();
      if (!rollbackWriteAuthorized && effectiveMode !== "ACTIVE") {
        throw new BiddingSupervisorError("POLICY_VIOLATION", `${effectiveMode} blocks forward Google Ads mutation`);
      }
      return options.googleAds.applyMutation(customerId, action);
    },
  });
  const supervisor = new PeriodicGoogleAdsBiddingSupervisor(options.transactions, options.config.scope, policy, guardedGoogleAds, options.profitability, now);
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<readonly BiddingSupervisorResult[]> | null = null;
  let safetyOperationInFlight = false;

  const emit = (event: BiddingRuntimeTelemetryEvent) => {
    try { options.onTelemetry?.(Object.freeze(event)); }
    catch (error) { try { options.onTelemetryError?.(error); } catch { /* telemetry cannot alter bidding semantics */ } }
  };

  const runCycle = async (trigger: "STARTUP" | "SCHEDULED" | "MANUAL"): Promise<readonly BiddingSupervisorResult[]> => {
    if (safetyOperationInFlight) {
      emit({ operation: "CYCLE", status: "SKIPPED", trigger, customerId: null, campaignId: null, reason: "SAFETY_OPERATION_RUNNING", mode: control.effectiveMode(), durationMs: 0, errorCode: "CONFLICT" });
      throw new BiddingSupervisorError("CONFLICT", "a rollback safety operation is running");
    }
    if (inFlight) {
      emit({ operation: "CYCLE", status: "SKIPPED", trigger, customerId: null, campaignId: null, reason: "CYCLE_ALREADY_RUNNING", mode: control.effectiveMode(), durationMs: 0, errorCode: null });
      return inFlight;
    }
    const started = now();
    const promise = (async () => {
      const bucket = Math.floor(now() / options.config.intervalMs);
      const results: BiddingSupervisorResult[] = [];
      let firstError: unknown = null;
      for (const campaign of options.config.campaigns) {
        const campaignStarted = now();
        const mode = control.effectiveMode();
        try {
          const result = await supervisor.supervise({ runId: `periodic-${campaign.campaignId}-${bucket}`, customerId: campaign.customerId, campaignId: campaign.campaignId, mode });
          results.push(result);
          emit({ operation: "CAMPAIGN", status: "OK", trigger, customerId: campaign.customerId, campaignId: campaign.campaignId, reason: result.reason, mode: result.mode, durationMs: Math.max(0, now() - campaignStarted), errorCode: null });
        } catch (error) {
          if (firstError === null) firstError = error;
          emit({ operation: "CAMPAIGN", status: "FAILED", trigger, customerId: campaign.customerId, campaignId: campaign.campaignId, reason: null, mode, durationMs: Math.max(0, now() - campaignStarted), errorCode: codeFor(error) });
        }
      }
      if (firstError !== null) throw firstError;
      return Object.freeze(results);
    })();
    inFlight = promise;
    try {
      const results = await promise;
      emit({ operation: "CYCLE", status: "OK", trigger, customerId: null, campaignId: null, reason: null, mode: control.effectiveMode(), durationMs: Math.max(0, now() - started), errorCode: null });
      return results;
    } catch (error) {
      emit({ operation: "CYCLE", status: "FAILED", trigger, customerId: null, campaignId: null, reason: null, mode: control.effectiveMode(), durationMs: Math.max(0, now() - started), errorCode: codeFor(error) });
      throw error;
    } finally {
      inFlight = null;
    }
  };

  const server = createServer(async (request, response) => {
    const started = now();
    let operation: BiddingRuntimeTelemetryEvent["operation"] = "HEALTH";
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://cortex.invalid");
      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, campaigns: options.config.campaigns.length, running: inFlight !== null, safetyOperationRunning: safetyOperationInFlight });
        emit({ operation, status: "OK", trigger: null, customerId: null, campaignId: null, reason: null, mode: null, durationMs: Math.max(0, now() - started), errorCode: null });
        return;
      }
      if (!authorized(request, expectedToken)) {
        writeJson(response, 401, { error: "UNAUTHORIZED" });
        emit({ operation, status: "REJECTED", trigger: null, customerId: null, campaignId: null, reason: null, mode: null, durationMs: Math.max(0, now() - started), errorCode: "UNAUTHORIZED" });
        return;
      }

      if (url.pathname === "/v1/bidding/control" && method === "GET") {
        operation = "CONTROL_READ";
        const payload = controlPayload(control);
        writeJson(response, 200, payload);
        emit({ operation, status: "OK", trigger: null, customerId: null, campaignId: null, reason: null, mode: payload.effectiveMode, durationMs: Math.max(0, now() - started), errorCode: null });
        return;
      }
      if (url.pathname === "/v1/bidding/control" && method === "POST") {
        operation = "CONTROL_WRITE";
        const body = await readBody(request);
        requestExact(body, ["expectedRevision", "mode", "reason", "changedAt"]);
        if (typeof body.expectedRevision !== "number" || typeof body.mode !== "string" || typeof body.reason !== "string" || (body.changedAt !== undefined && typeof body.changedAt !== "string")) throw new HttpRequestError(400, "control request fields are malformed");
        control.set({ expectedRevision: body.expectedRevision, mode: body.mode as BiddingSupervisorMode, reason: body.reason, ...(body.changedAt === undefined ? {} : { changedAt: body.changedAt }) });
        const payload = controlPayload(control);
        writeJson(response, 200, payload);
        emit({ operation, status: "OK", trigger: null, customerId: null, campaignId: null, reason: null, mode: payload.effectiveMode, durationMs: Math.max(0, now() - started), errorCode: null });
        return;
      }
      if (url.pathname === "/v1/bidding/run" && method === "POST") {
        operation = "CYCLE";
        const results = await runCycle("MANUAL");
        writeJson(response, 200, { results });
        return;
      }
      const rollback = /^\/v1\/bidding\/customers\/(\d{5,20})\/campaigns\/(\d{5,20})\/rollback$/u.exec(url.pathname);
      if (rollback && method === "POST") {
        operation = "ROLLBACK";
        const customerId = rollback[1]!;
        const campaignId = rollback[2]!;
        if (!options.config.campaigns.some((item) => item.customerId === customerId && item.campaignId === campaignId)) throw new HttpRequestError(404, "campaign is not configured");
        if (inFlight !== null || safetyOperationInFlight) throw new BiddingSupervisorError("CONFLICT", "rollback requires an idle production runtime");
        safetyOperationInFlight = true;
        try {
          rollbackWriteAuthorized = true;
          let result: BiddingSupervisorResult;
          try {
            result = await supervisor.rollbackLastMutation({ runId: `rollback-${campaignId}-${now()}`, customerId, campaignId });
          } finally {
            rollbackWriteAuthorized = false;
          }
          writeJson(response, 200, result);
          emit({ operation, status: "OK", trigger: null, customerId, campaignId, reason: result.reason, mode: control.effectiveMode(), durationMs: Math.max(0, now() - started), errorCode: null });
        } finally {
          rollbackWriteAuthorized = false;
          safetyOperationInFlight = false;
        }
        return;
      }
      writeJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const status = statusFor(error);
      if (!response.headersSent && !response.writableEnded) writeJson(response, status, { error: codeFor(error) });
      emit({ operation, status: status >= 500 ? "FAILED" : "REJECTED", trigger: null, customerId: null, campaignId: null, reason: null, mode: control.effectiveMode(), durationMs: Math.max(0, now() - started), errorCode: codeFor(error) });
    }
  });

  return Object.freeze({
    server,
    policy,
    runOnce: runCycle,
    start(runImmediately = true) {
      if (interval !== null) return;
      interval = setInterval(() => { void runCycle("SCHEDULED").catch(() => undefined); }, options.config.intervalMs);
      if (runImmediately) void runCycle("STARTUP").catch(() => undefined);
    },
    close: () => new Promise<void>((resolve, reject) => {
      if (interval !== null) { clearInterval(interval); interval = null; }
      const finish = () => resolve();
      if (!server.listening) {
        if (inFlight) void inFlight.then(finish, finish); else finish();
        return;
      }
      server.close((error) => {
        if (error) { reject(error); return; }
        if (inFlight) void inFlight.then(finish, finish); else finish();
      });
    }),
  });
}
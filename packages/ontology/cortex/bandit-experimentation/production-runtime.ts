import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import {
  CortexBanditError,
  ServerSideContextualBanditEngine,
  createCortexBanditPolicy,
  type CortexBanditArmDefinition,
  type CortexBanditContext,
  type CortexBanditMode,
  type CreateCortexBanditPolicyInput,
} from "./index";
import {
  CortexBanditRuntimeController,
  CortexBanditRuntimeControlError,
  type CortexBanditRuntimeControlState,
} from "./runtime-control";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const POLICY_KEYS = new Set([
  "policyId", "version", "defaultArmId", "minimumObservationsPerArm", "confidenceLevel", "ucbExplorationCoefficient",
  "maxArms", "maxContextFeatures", "allowedContextKeys", "maxRewardDelayMs", "conversionWeight", "economicValueWeight",
  "economicValueNormalizationCap", "maxWriteRetries", "mode",
]);

export interface CortexBanditProductionExperimentConfig {
  readonly experimentId: string;
  readonly policy: CreateCortexBanditPolicyInput;
  readonly arms: readonly CortexBanditArmDefinition[];
}

export interface CortexBanditProductionConfig {
  readonly version: 1;
  readonly scope: OntologyScope;
  readonly experiments: readonly CortexBanditProductionExperimentConfig[];
}

export interface CortexBanditRuntimeTelemetryEvent {
  readonly operation: "SELECT" | "OUTCOME" | "CONTROL_READ" | "CONTROL_WRITE" | "HEALTH";
  readonly status: "OK" | "REJECTED" | "FAILED";
  readonly experimentId: string | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly decisionReason: string | null;
  readonly controlMode: CortexBanditMode | null;
}

export interface CortexBanditHttpRuntimeOptions {
  readonly transactions: OntologyTransactionPort;
  readonly config: CortexBanditProductionConfig;
  readonly apiToken: string;
  readonly now?: () => number;
  readonly onTelemetry?: (event: CortexBanditRuntimeTelemetryEvent) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}

export interface CortexBanditHttpRuntime {
  readonly server: Server;
  close(): Promise<void>;
}

interface RuntimeExperiment {
  readonly engine: ServerSideContextualBanditEngine;
  readonly control: CortexBanditRuntimeController;
}

class HttpRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
  return item;
}

function scopeFrom(value: unknown): OntologyScope {
  const object = plainObject(value, "scope");
  exactKeys(object, new Set(["tenantId", "organizationId", "brandId"]), "scope");
  const tenantId = requiredString(object, "tenantId", "scope").trim();
  const organizationId = requiredString(object, "organizationId", "scope").trim();
  const brand = object.brandId;
  if (!IDENTIFIER.test(tenantId) || !IDENTIFIER.test(organizationId)) throw new Error("scope identifiers are malformed");
  if (brand !== undefined && (typeof brand !== "string" || !IDENTIFIER.test(brand.trim()))) throw new Error("scope.brandId is malformed");
  return Object.freeze({ tenantId, organizationId, ...(brand === undefined ? {} : { brandId: brand.trim() }) });
}

function policyFrom(value: unknown): CreateCortexBanditPolicyInput {
  const object = plainObject(value, "policy");
  exactKeys(object, POLICY_KEYS, "policy");
  return object as unknown as CreateCortexBanditPolicyInput;
}

function finiteJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteJson);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(finiteJson);
}

function armsFrom(value: unknown): readonly CortexBanditArmDefinition[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) throw new Error("arms must contain 2..64 items");
  return Object.freeze(value.map((item, index) => {
    const object = plainObject(item, `arms[${index}]`);
    exactKeys(object, new Set(["armId", "payload", "minTrafficShare", "maxTrafficShare"]), `arms[${index}]`);
    const armId = requiredString(object, "armId", `arms[${index}]`).trim();
    if (!IDENTIFIER.test(armId)) throw new Error(`arms[${index}].armId is malformed`);
    const payload = plainObject(object.payload, `arms[${index}].payload`);
    if (!finiteJson(payload)) throw new Error(`arms[${index}].payload must contain finite JSON data`);
    const minTrafficShare = object.minTrafficShare;
    const maxTrafficShare = object.maxTrafficShare;
    if (typeof minTrafficShare !== "number" || !Number.isFinite(minTrafficShare) || minTrafficShare < 0 || minTrafficShare > 1) throw new Error(`arms[${index}].minTrafficShare must be 0..1`);
    if (typeof maxTrafficShare !== "number" || !Number.isFinite(maxTrafficShare) || maxTrafficShare < 0 || maxTrafficShare > 1) throw new Error(`arms[${index}].maxTrafficShare must be 0..1`);
    if (minTrafficShare > maxTrafficShare) throw new Error(`arms[${index}] minimum traffic exceeds maximum traffic`);
    return Object.freeze({
      armId,
      payload: Object.freeze({ ...payload }) as CortexBanditArmDefinition["payload"],
      minTrafficShare,
      maxTrafficShare,
    });
  }));
}

function validateExperimentEnvelope(policy: ReturnType<typeof createCortexBanditPolicy>, arms: readonly CortexBanditArmDefinition[], index: number): void {
  if (arms.length > policy.maxArms) throw new Error(`experiments[${index}] arm count exceeds policy maxArms`);
  const ids = arms.map((arm) => arm.armId);
  if (new Set(ids).size !== ids.length) throw new Error(`experiments[${index}] armId values must be unique`);
  if (!ids.includes(policy.defaultArmId)) throw new Error(`experiments[${index}] defaultArmId must reference a configured arm`);
  const sumMin = arms.reduce((sum, arm) => sum + arm.minTrafficShare, 0);
  const sumMax = arms.reduce((sum, arm) => sum + arm.maxTrafficShare, 0);
  if (sumMin > 1 + 1e-12) throw new Error(`experiments[${index}] minimum traffic shares exceed 1`);
  if (sumMax < 1 - 1e-12) throw new Error(`experiments[${index}] maximum traffic shares cannot cover 1`);
}

export function parseCortexBanditProductionConfig(value: unknown): CortexBanditProductionConfig {
  const object = plainObject(value, "bandit production config");
  exactKeys(object, new Set(["version", "scope", "experiments"]), "bandit production config");
  if (object.version !== 1) throw new Error("bandit production config version must be 1");
  const scope = scopeFrom(object.scope);
  const experimentsInput = object.experiments;
  if (!Array.isArray(experimentsInput) || experimentsInput.length < 1 || experimentsInput.length > 64) throw new Error("experiments must contain 1..64 items");
  const experiments = experimentsInput.map((item, index): CortexBanditProductionExperimentConfig => {
    const experiment = plainObject(item, `experiments[${index}]`);
    exactKeys(experiment, new Set(["experimentId", "policy", "arms"]), `experiments[${index}]`);
    const experimentId = requiredString(experiment, "experimentId", `experiments[${index}]`).trim();
    if (!IDENTIFIER.test(experimentId)) throw new Error(`experiments[${index}].experimentId is malformed`);
    const policy = policyFrom(experiment.policy);
    const validatedPolicy = createCortexBanditPolicy(policy);
    const arms = armsFrom(experiment.arms);
    validateExperimentEnvelope(validatedPolicy, arms, index);
    return Object.freeze({ experimentId, policy, arms });
  });
  const ids = experiments.map((item) => item.experimentId);
  if (new Set(ids).size !== ids.length) throw new Error("experimentId values must be unique");
  return Object.freeze({ version: 1, scope, experiments: Object.freeze(experiments) });
}

export function loadCortexBanditProductionConfig(path: string): CortexBanditProductionConfig {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_BANDIT_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("bandit production config path must reference a regular file");
  if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) throw new Error(`bandit production config must be 1..${MAX_CONFIG_BYTES} bytes`);
  const source = readFileSync(path, "utf8");
  return parseCortexBanditProductionConfig(JSON.parse(source) as unknown);
}

function validateToken(token: string): Buffer {
  if (typeof token !== "string" || token.length < 32 || token.length > 4096) throw new Error("NEXUS_CORTEX_API_TOKEN must contain 32..4096 characters");
  return Buffer.from(token, "utf8");
}

function authorized(request: IncomingMessage, expectedToken: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(raw.slice(7), "utf8");
  return candidate.length === expectedToken.length && timingSafeEqual(candidate, expectedToken);
}

function jsonContentType(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  if (typeof raw !== "string") return false;
  return raw.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!jsonContentType(request)) throw new HttpRequestError(415, "content-type must be application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpRequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new HttpRequestError(400, "request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "request body contains malformed JSON");
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpRequestError) return error.statusCode;
  if (error instanceof CortexBanditError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "CONFLICT") return 409;
    if (error.code === "PERSISTENCE_FAILURE" || error.code === "INTEGRITY_FAILURE") return 503;
    return 400;
  }
  if (error instanceof CortexBanditRuntimeControlError) {
    if (error.code === "CONFLICT") return 409;
    if (error.code === "PERSISTENCE_FAILURE" || error.code === "INTEGRITY_FAILURE") return 503;
    return 400;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof CortexBanditError || error instanceof CortexBanditRuntimeControlError) return error.code;
  if (error instanceof HttpRequestError) return "INVALID_HTTP_REQUEST";
  return "UNEXPECTED";
}

function requestObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  try {
    const object = plainObject(value, label);
    exactKeys(object, new Set(allowed), label);
    return object;
  } catch (error) {
    throw new HttpRequestError(400, error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function requestContext(value: unknown): CortexBanditContext {
  try {
    return plainObject(value, "selection request.context") as CortexBanditContext;
  } catch (error) {
    throw new HttpRequestError(400, error instanceof Error ? error.message : "selection request.context is invalid");
  }
}

function controlResponse(state: CortexBanditRuntimeControlState, control: CortexBanditRuntimeController) {
  return Object.freeze({ state, history: control.history(64) });
}

export function createCortexBanditHttpRuntime(options: CortexBanditHttpRuntimeOptions): CortexBanditHttpRuntime {
  const expectedToken = validateToken(options.apiToken);
  const now = options.now ?? Date.now;
  const experiments = new Map<string, RuntimeExperiment>();
  for (const experiment of options.config.experiments) {
    const policy = createCortexBanditPolicy(experiment.policy);
    const engine = new ServerSideContextualBanditEngine(options.transactions, options.config.scope, experiment.experimentId, policy, experiment.arms, now);
    const control = new CortexBanditRuntimeController(options.transactions, options.config.scope, experiment.experimentId, policy.digest, policy.mode, now);
    experiments.set(experiment.experimentId, Object.freeze({ engine, control }));
  }

  const emit = (event: CortexBanditRuntimeTelemetryEvent) => {
    try { options.onTelemetry?.(Object.freeze(event)); } catch (error) {
      try { options.onTelemetryError?.(error); } catch { /* telemetry must not change runtime semantics */ }
    }
  };

  const server = createServer(async (request, response) => {
    const startedAt = now();
    let operation: CortexBanditRuntimeTelemetryEvent["operation"] = "HEALTH";
    let experimentId: string | null = null;
    let decisionReason: string | null = null;
    let controlMode: CortexBanditMode | null = null;
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://cortex.invalid");
      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, experiments: experiments.size });
        emit({ operation, status: "OK", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: null, decisionReason, controlMode });
        return;
      }
      if (!authorized(request, expectedToken)) {
        writeJson(response, 401, { error: "UNAUTHORIZED" });
        emit({ operation, status: "REJECTED", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: "UNAUTHORIZED", decisionReason, controlMode });
        return;
      }
      const match = /^\/v1\/bandits\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(select|outcomes|control)$/u.exec(url.pathname);
      if (!match) {
        writeJson(response, 404, { error: "NOT_FOUND" });
        emit({ operation, status: "REJECTED", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: "NOT_FOUND", decisionReason, controlMode });
        return;
      }
      experimentId = match[1]!;
      const action = match[2]!;
      const runtime = experiments.get(experimentId);
      if (!runtime) {
        writeJson(response, 404, { error: "UNKNOWN_EXPERIMENT" });
        emit({ operation, status: "REJECTED", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: "UNKNOWN_EXPERIMENT", decisionReason, controlMode });
        return;
      }

      if (action === "control" && method === "GET") {
        operation = "CONTROL_READ";
        const value = controlResponse(runtime.control.current(), runtime.control);
        controlMode = value.state.mode;
        writeJson(response, 200, value);
        emit({ operation, status: "OK", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: null, decisionReason, controlMode });
        return;
      }
      if (method !== "POST") {
        writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        emit({ operation, status: "REJECTED", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: "METHOD_NOT_ALLOWED", decisionReason, controlMode });
        return;
      }

      const body = await readJsonBody(request);
      if (action === "select") {
        operation = "SELECT";
        const input = requestObject(body, ["requestId", "context", "eligibleArmIds"], "selection request");
        if (typeof input.requestId !== "string") throw new HttpRequestError(400, "requestId must be a string");
        if (!Array.isArray(input.eligibleArmIds) || !input.eligibleArmIds.every((item) => typeof item === "string")) throw new HttpRequestError(400, "eligibleArmIds must be a string array");
        const context = requestContext(input.context);
        const state = runtime.control.current();
        controlMode = state.mode;
        const decision = runtime.engine.select({ requestId: input.requestId, context, eligibleArmIds: input.eligibleArmIds as string[], mode: state.mode });
        decisionReason = decision.reason;
        writeJson(response, 200, decision);
      } else if (action === "outcomes") {
        operation = "OUTCOME";
        const input = requestObject(body, ["decisionId", "converted", "economicValue", "outcomeAt"], "outcome request");
        if (typeof input.decisionId !== "string" || typeof input.converted !== "boolean" || typeof input.economicValue !== "number" || typeof input.outcomeAt !== "string") {
          throw new HttpRequestError(400, "outcome request fields are malformed");
        }
        const decision = runtime.engine.recordOutcome({ decisionId: input.decisionId, converted: input.converted, economicValue: input.economicValue, outcomeAt: input.outcomeAt });
        decisionReason = decision.reason;
        writeJson(response, 200, decision);
      } else {
        operation = "CONTROL_WRITE";
        const input = requestObject(body, ["expectedRevision", "mode", "reason", "changedAt"], "control request");
        if (typeof input.expectedRevision !== "number" || typeof input.mode !== "string" || typeof input.reason !== "string") {
          throw new HttpRequestError(400, "control request fields are malformed");
        }
        if (input.changedAt !== undefined && typeof input.changedAt !== "string") throw new HttpRequestError(400, "changedAt must be a string");
        const state = runtime.control.set({
          expectedRevision: input.expectedRevision,
          mode: input.mode as CortexBanditMode,
          reason: input.reason,
          ...(input.changedAt === undefined ? {} : { changedAt: input.changedAt }),
        });
        controlMode = state.mode;
        writeJson(response, 200, controlResponse(state, runtime.control));
      }
      emit({ operation, status: "OK", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: null, decisionReason, controlMode });
    } catch (error) {
      const statusCode = errorStatus(error);
      if (!response.headersSent && !response.writableEnded) writeJson(response, statusCode, { error: errorCode(error) });
      emit({ operation, status: statusCode >= 500 ? "FAILED" : "REJECTED", experimentId, durationMs: Math.max(0, now() - startedAt), errorCode: errorCode(error), decisionReason, controlMode });
    }
  });

  return Object.freeze({
    server,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
}

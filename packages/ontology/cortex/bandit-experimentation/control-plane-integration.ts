import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, type OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import {
  ServerSideContextualBanditEngine,
  createCortexBanditPolicy,
  type CortexBanditContext,
  type CortexBanditMode,
  type CortexBanditSelectionEvidence,
} from "./index";
import {
  createCortexBanditHttpRuntime,
  type CortexBanditHttpRuntime,
  type CortexBanditHttpRuntimeOptions,
  type CortexBanditProductionConfig,
} from "./production-runtime";
import { CortexBanditRuntimeController } from "./runtime-control";

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MODES = new Set<CortexBanditMode>(["ACTIVE", "FALLBACK_ONLY", "KILLED"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_POLICY_EXPERIMENTS = 64;
const MAX_EVIDENCE_SCENARIOS = 32;

export interface CortexBanditControlPlaneEvidenceScenarioInput {
  readonly scenarioId: string;
  readonly context: CortexBanditContext;
  readonly eligibleArmIds: readonly string[];
}

export interface CortexBanditControlPlaneExperimentPolicyInput {
  readonly experimentId: string;
  readonly bootstrapMode: "FALLBACK_ONLY" | "KILLED";
  readonly maxVariantTrafficShare: number;
  readonly minimumTotalObservationsForRelaxation: number;
  readonly minimumObservationsPerArmForRelaxation: number;
  readonly maximumPendingOutcomeFractionForRelaxation: number;
  readonly requireConfidentWinnerForActive: boolean;
  readonly evidenceScenarios: readonly CortexBanditControlPlaneEvidenceScenarioInput[];
}

export interface CreateCortexBanditControlPlanePolicyInput {
  readonly version: 1;
  readonly policyId: string;
  readonly maxCommandAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly experiments: readonly CortexBanditControlPlaneExperimentPolicyInput[];
}

export interface CortexBanditControlPlanePolicy extends CreateCortexBanditControlPlanePolicyInput {
  readonly digest: `sha256:${string}`;
}

export interface CortexBanditControlPlaneExperimentState {
  readonly experimentId: string;
  readonly policyDigest: string;
  readonly controlPolicyDigest: string;
  readonly evidenceDigest: string;
  readonly revision: number;
  readonly mode: CortexBanditMode;
  readonly effectiveMode: CortexBanditMode;
  readonly configuredMode: CortexBanditMode;
}

export interface CortexBanditControlPlanePullRequest {
  readonly version: 1;
  readonly scope: OntologyScope;
  readonly experiments: readonly CortexBanditControlPlaneExperimentState[];
}

export interface CortexBanditControlPlaneCommand {
  readonly commandId: string;
  readonly experimentId: string;
  readonly policyDigest: string;
  readonly controlPolicyDigest: string;
  readonly evidenceDigest: string | null;
  readonly expectedRevision: number;
  readonly mode: CortexBanditMode;
  readonly reason: string;
  readonly issuedAt: string;
}

export interface CortexBanditControlPlanePullResponse {
  readonly version: 1;
  readonly commands: readonly CortexBanditControlPlaneCommand[];
}

export interface CortexBanditControlPlaneSource {
  pull(request: CortexBanditControlPlanePullRequest): Promise<CortexBanditControlPlanePullResponse>;
}

export interface HttpCortexBanditControlPlaneSourceConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface CortexBanditControlPlaneSyncResult {
  readonly appliedCommandIds: readonly string[];
  readonly staleCommandIds: readonly string[];
  readonly experimentCount: number;
}

export class CortexBanditControlPlaneIntegrationError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "INVALID_COMMAND", message: string) {
    super(message);
    this.name = "CortexBanditControlPlaneIntegrationError";
  }
}

interface RuntimeExperiment {
  readonly engine: ServerSideContextualBanditEngine;
  readonly control: CortexBanditRuntimeController;
  readonly controlPolicy: CortexBanditControlPlaneExperimentPolicyInput;
  readonly defaultArmId: string;
  readonly variantMaxTrafficShares: readonly number[];
}

interface EvidenceScenarioSnapshot {
  readonly scenarioId: string;
  readonly contextDigest: string;
  readonly evidence: CortexBanditSelectionEvidence;
}

interface EvidenceState {
  readonly digest: `sha256:${string}`;
  readonly scenarios: readonly EvidenceScenarioSnapshot[];
}

function plainObject(value: unknown, label: string, code: "INVALID_CONFIG" | "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, code: "INVALID_CONFIG" | "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} contains unknown field ${key}`);
  for (const key of allowed) if (!(key in value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label}.${key} is required`);
}

function identifier(value: unknown, label: string, code: "INVALID_CONFIG" | "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} is malformed`);
  return value;
}

function digest(value: unknown, label: string, code: "INVALID_CONFIG" | "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} is malformed`);
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  return digest(value, label);
}

function revision(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be a non-negative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label} is outside ${min}..${max}`);
  return value as number;
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label} must be ${min}..${max}`);
  return value;
}

function mode(value: unknown, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): CortexBanditMode {
  if (typeof value !== "string" || !MODES.has(value as CortexBanditMode)) throw new CortexBanditControlPlaneIntegrationError(code, "control-plane mode is invalid");
  return value as CortexBanditMode;
}

function bootstrapMode(value: unknown, label: string): "FALLBACK_ONLY" | "KILLED" {
  if (!(value === "FALLBACK_ONLY" || value === "KILLED")) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label} must be FALLBACK_ONLY or KILLED`);
  return value;
}

function modeRank(value: CortexBanditMode): number { return value === "ACTIVE" ? 0 : value === "FALLBACK_ONLY" ? 1 : 2; }
function isRelaxation(current: CortexBanditMode, next: CortexBanditMode): boolean { return modeRank(next) < modeRank(current); }

function reason(value: unknown, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string") throw new CortexBanditControlPlaneIntegrationError(code, "control-plane reason must be a string");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 3 || normalized.length > 256) throw new CortexBanditControlPlaneIntegrationError(code, "control-plane reason must contain 3..256 characters");
  for (const character of normalized) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) throw new CortexBanditControlPlaneIntegrationError(code, "control-plane reason contains a control character");
  }
  return normalized;
}

function canonicalUtc(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string") throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be canonical UTC`);
  return value;
}

function endpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane endpoint is invalid"); }
  if (parsed.protocol !== "https:") throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane endpoint must use https");
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane endpoint must not contain credentials, query, or fragment");
  return parsed.toString();
}

function token(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096 || /[\r\n\0]/u.test(normalized)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane bearer token must contain 32..4096 safe characters");
  return normalized;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 10_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 60_000) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane timeoutMs must be 1000..60000");
  return resolved;
}

function safeContext(value: unknown, label: string): CortexBanditContext {
  const object = plainObject(value, label, "INVALID_CONFIG");
  const entries = Object.entries(object);
  if (entries.length > 64) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label} contains too many features`);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries) {
    identifier(key, `${label} key`, "INVALID_CONFIG");
    if (typeof item === "string") {
      const normalized = item.normalize("NFKC");
      if (normalized.length > 512 || /[\r\n\0]/u.test(normalized)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label}.${key} is invalid`);
      result[key] = normalized;
    } else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
    else throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `${label}.${key} must be a finite primitive context value`);
  }
  return Object.freeze(result);
}

function policyHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`cortex-bandit-control-plane-policy-v1\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function evidenceHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`cortex-bandit-control-plane-evidence-v1\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

export function createCortexBanditControlPlanePolicy(value: unknown): CortexBanditControlPlanePolicy {
  const object = plainObject(value, "control-plane policy", "INVALID_CONFIG");
  exactKeys(object, ["version", "policyId", "maxCommandAgeMs", "maxFutureSkewMs", "experiments"], "control-plane policy", "INVALID_CONFIG");
  if (object.version !== 1) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane policy version must be 1");
  const policyId = identifier(object.policyId, "control-plane policyId", "INVALID_CONFIG");
  const maxCommandAgeMs = positiveInteger(object.maxCommandAgeMs, "maxCommandAgeMs", 1_000, 86_400_000);
  const maxFutureSkewMs = positiveInteger(object.maxFutureSkewMs, "maxFutureSkewMs", 0, 300_000);
  if (!Array.isArray(object.experiments) || object.experiments.length < 1 || object.experiments.length > MAX_POLICY_EXPERIMENTS) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `control-plane policy experiments must contain 1..${MAX_POLICY_EXPERIMENTS} items`);
  const experiments = object.experiments.map((item, index): CortexBanditControlPlaneExperimentPolicyInput => {
    const experiment = plainObject(item, `control-plane policy experiments[${index}]`, "INVALID_CONFIG");
    exactKeys(experiment, ["experimentId", "bootstrapMode", "maxVariantTrafficShare", "minimumTotalObservationsForRelaxation", "minimumObservationsPerArmForRelaxation", "maximumPendingOutcomeFractionForRelaxation", "requireConfidentWinnerForActive", "evidenceScenarios"], `control-plane policy experiments[${index}]`, "INVALID_CONFIG");
    const experimentId = identifier(experiment.experimentId, `experiments[${index}].experimentId`, "INVALID_CONFIG");
    const configuredBootstrapMode = bootstrapMode(experiment.bootstrapMode, `experiments[${index}].bootstrapMode`);
    const maxVariantTrafficShare = boundedNumber(experiment.maxVariantTrafficShare, `experiments[${index}].maxVariantTrafficShare`, 0, 1);
    const minimumTotalObservationsForRelaxation = positiveInteger(experiment.minimumTotalObservationsForRelaxation, `experiments[${index}].minimumTotalObservationsForRelaxation`, 1, 1_000_000_000);
    const minimumObservationsPerArmForRelaxation = positiveInteger(experiment.minimumObservationsPerArmForRelaxation, `experiments[${index}].minimumObservationsPerArmForRelaxation`, 1, 1_000_000_000);
    const maximumPendingOutcomeFractionForRelaxation = boundedNumber(experiment.maximumPendingOutcomeFractionForRelaxation, `experiments[${index}].maximumPendingOutcomeFractionForRelaxation`, 0, 1);
    if (typeof experiment.requireConfidentWinnerForActive !== "boolean") throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `experiments[${index}].requireConfidentWinnerForActive must be boolean`);
    if (!Array.isArray(experiment.evidenceScenarios) || experiment.evidenceScenarios.length < 1 || experiment.evidenceScenarios.length > MAX_EVIDENCE_SCENARIOS) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `experiments[${index}].evidenceScenarios must contain 1..${MAX_EVIDENCE_SCENARIOS} items`);
    const scenarioIds = new Set<string>();
    const evidenceScenarios = experiment.evidenceScenarios.map((scenarioValue, scenarioIndex): CortexBanditControlPlaneEvidenceScenarioInput => {
      const scenario = plainObject(scenarioValue, `experiments[${index}].evidenceScenarios[${scenarioIndex}]`, "INVALID_CONFIG");
      exactKeys(scenario, ["scenarioId", "context", "eligibleArmIds"], `experiments[${index}].evidenceScenarios[${scenarioIndex}]`, "INVALID_CONFIG");
      const scenarioId = identifier(scenario.scenarioId, `evidenceScenarios[${scenarioIndex}].scenarioId`, "INVALID_CONFIG");
      if (scenarioIds.has(scenarioId)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `duplicate evidence scenario ${scenarioId}`);
      scenarioIds.add(scenarioId);
      if (!Array.isArray(scenario.eligibleArmIds) || scenario.eligibleArmIds.length < 2 || scenario.eligibleArmIds.length > 64) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `evidenceScenarios[${scenarioIndex}].eligibleArmIds must contain 2..64 items`);
      const eligibleArmIds = scenario.eligibleArmIds.map((armId, armIndex) => identifier(armId, `evidenceScenarios[${scenarioIndex}].eligibleArmIds[${armIndex}]`, "INVALID_CONFIG"));
      if (new Set(eligibleArmIds).size !== eligibleArmIds.length) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `evidenceScenarios[${scenarioIndex}].eligibleArmIds contains duplicates`);
      return Object.freeze({ scenarioId, context: safeContext(scenario.context, `evidenceScenarios[${scenarioIndex}].context`), eligibleArmIds: Object.freeze(eligibleArmIds) });
    });
    return Object.freeze({ experimentId, bootstrapMode: configuredBootstrapMode, maxVariantTrafficShare, minimumTotalObservationsForRelaxation, minimumObservationsPerArmForRelaxation, maximumPendingOutcomeFractionForRelaxation, requireConfidentWinnerForActive: experiment.requireConfidentWinnerForActive, evidenceScenarios: Object.freeze(evidenceScenarios) });
  });
  if (new Set(experiments.map((item) => item.experimentId)).size !== experiments.length) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane policy experimentId values must be unique");
  const core = Object.freeze({ version: 1 as const, policyId, maxCommandAgeMs, maxFutureSkewMs, experiments: Object.freeze(experiments) });
  return Object.freeze({ ...core, digest: policyHash(core) });
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response must use application/json");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response content-length is invalid or oversized");
  if (!response.body) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", `control-plane response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(merged)) as unknown; }
  catch { throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response contains malformed JSON"); }
}

function parseCommand(value: unknown, index: number): CortexBanditControlPlaneCommand {
  const object = plainObject(value, `commands[${index}]`);
  exactKeys(object, ["commandId", "experimentId", "policyDigest", "controlPolicyDigest", "evidenceDigest", "expectedRevision", "mode", "reason", "issuedAt"], `commands[${index}]`);
  return Object.freeze({
    commandId: identifier(object.commandId, `commands[${index}].commandId`),
    experimentId: identifier(object.experimentId, `commands[${index}].experimentId`),
    policyDigest: digest(object.policyDigest, `commands[${index}].policyDigest`),
    controlPolicyDigest: digest(object.controlPolicyDigest, `commands[${index}].controlPolicyDigest`),
    evidenceDigest: nullableDigest(object.evidenceDigest, `commands[${index}].evidenceDigest`),
    expectedRevision: revision(object.expectedRevision, `commands[${index}].expectedRevision`),
    mode: mode(object.mode),
    reason: reason(object.reason),
    issuedAt: canonicalUtc(object.issuedAt, `commands[${index}].issuedAt`),
  });
}

function parseResponse(value: unknown): CortexBanditControlPlanePullResponse {
  const object = plainObject(value, "control-plane response");
  exactKeys(object, ["version", "commands"], "control-plane response");
  if (object.version !== 1) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response version must be 1");
  if (!Array.isArray(object.commands) || object.commands.length > 64) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane commands must contain at most 64 items");
  const commands = object.commands.map(parseCommand);
  const commandIds = commands.map((command) => command.commandId);
  if (new Set(commandIds).size !== commandIds.length) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane commandId values must be unique");
  const experimentIds = commands.map((command) => command.experimentId);
  if (new Set(experimentIds).size !== experimentIds.length) throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane may return at most one command per experiment");
  return Object.freeze({ version: 1, commands: Object.freeze(commands) });
}

export class HttpCortexBanditControlPlaneSource implements CortexBanditControlPlaneSource {
  private readonly endpointValue: string;
  private readonly tokenValue: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpCortexBanditControlPlaneSourceConfig) {
    this.endpointValue = endpoint(config.endpoint);
    this.tokenValue = token(config.bearerToken);
    this.timeoutMs = timeout(config.timeoutMs);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async pull(request: CortexBanditControlPlanePullRequest): Promise<CortexBanditControlPlanePullResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointValue, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.tokenValue}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CortexBanditControlPlaneIntegrationError("HTTP_ERROR", `control-plane endpoint returned HTTP ${response.status}`);
      }
      return parseResponse(await boundedJson(response));
    } catch (error) {
      if (controller.signal.aborted) throw new CortexBanditControlPlaneIntegrationError("TIMEOUT", "control-plane request timed out");
      if (error instanceof CortexBanditControlPlaneIntegrationError) throw error;
      throw new CortexBanditControlPlaneIntegrationError("HTTP_ERROR", error instanceof Error ? error.message : "control-plane transport failed");
    } finally { clearTimeout(timer); }
  }
}

export function createExternallyGovernedCortexBanditHttpRuntime(options: Omit<CortexBanditHttpRuntimeOptions, "controlPlaneToken">): CortexBanditHttpRuntime {
  let privateControlToken = randomBytes(48).toString("base64url");
  while (privateControlToken === options.dataPlaneToken) privateControlToken = randomBytes(48).toString("base64url");
  return createCortexBanditHttpRuntime({ ...options, controlPlaneToken: privateControlToken });
}

export class CortexBanditControlPlaneReconciler {
  private readonly experiments = new Map<string, RuntimeExperiment>();
  private readonly scope: OntologyScope;
  readonly policy: CortexBanditControlPlanePolicy;

  constructor(transactions: OntologyTransactionPort, config: CortexBanditProductionConfig, controlPolicyInput: unknown, private readonly source: CortexBanditControlPlaneSource, private readonly now: () => number = Date.now) {
    this.scope = config.scope;
    this.policy = createCortexBanditControlPlanePolicy(controlPolicyInput);
    const controlByExperiment = new Map(this.policy.experiments.map((item) => [item.experimentId, item] as const));
    if (controlByExperiment.size !== config.experiments.length) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane policy must cover exactly the configured experiments");
    for (const experiment of config.experiments) {
      const configuredControlPolicy = controlByExperiment.get(experiment.experimentId);
      if (!configuredControlPolicy) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `control-plane policy is missing experiment ${experiment.experimentId}`);
      const banditPolicy = createCortexBanditPolicy(experiment.policy);
      if (configuredControlPolicy.minimumObservationsPerArmForRelaxation < banditPolicy.minimumObservationsPerArm) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `control-plane evidence floor for ${experiment.experimentId} cannot weaken the bandit policy minimum`);
      const variants = experiment.arms.filter((arm) => arm.armId !== banditPolicy.defaultArmId);
      if (variants.some((arm) => arm.maxTrafficShare > configuredControlPolicy.maxVariantTrafficShare + 1e-12)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `configured variant traffic exceeds the control-plane risk ceiling for ${experiment.experimentId}`);
      const engine = new ServerSideContextualBanditEngine(transactions, config.scope, experiment.experimentId, banditPolicy, experiment.arms, now);
      for (const scenario of configuredControlPolicy.evidenceScenarios) engine.auditSnapshot(scenario.context, scenario.eligibleArmIds);
      const control = new CortexBanditRuntimeController(transactions, config.scope, experiment.experimentId, banditPolicy.digest, banditPolicy.mode, now);
      this.experiments.set(experiment.experimentId, Object.freeze({ engine, control, controlPolicy: configuredControlPolicy, defaultArmId: banditPolicy.defaultArmId, variantMaxTrafficShares: Object.freeze(variants.map((arm) => arm.maxTrafficShare)) }));
    }
    for (const experimentId of controlByExperiment.keys()) if (!this.experiments.has(experimentId)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", `control-plane policy references unknown experiment ${experimentId}`);
    this.enforceBootstrapPolicy();
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane clock returned a non-finite value");
    return value;
  }

  private enforceBootstrapPolicy(): void {
    const changedAt = new Date(this.clock()).toISOString();
    for (const item of this.experiments.values()) {
      const current = item.control.current();
      if (modeRank(current.mode) >= modeRank(item.controlPolicy.bootstrapMode)) continue;
      item.control.set({ expectedRevision: current.revision, mode: item.controlPolicy.bootstrapMode, reason: "external control-plane bootstrap policy", changedAt });
    }
  }

  private evidenceState(experimentId: string, item: RuntimeExperiment): EvidenceState {
    const scenarios = item.controlPolicy.evidenceScenarios.map((scenario): EvidenceScenarioSnapshot => {
      const snapshot = item.engine.auditSnapshot(scenario.context, scenario.eligibleArmIds);
      return Object.freeze({ scenarioId: scenario.scenarioId, contextDigest: snapshot.contextDigest, evidence: snapshot.evidence });
    });
    const core = Object.freeze({ version: 1 as const, experimentId, banditPolicyDigest: item.control.policyDigest, controlPolicyDigest: this.policy.digest, scenarios: Object.freeze(scenarios) });
    return Object.freeze({ digest: evidenceHash(core), scenarios: Object.freeze(scenarios) });
  }

  private validateRelaxation(experimentId: string, item: RuntimeExperiment, targetMode: CortexBanditMode, evidence: EvidenceState): void {
    if (item.variantMaxTrafficShares.some((share) => share > item.controlPolicy.maxVariantTrafficShare + 1e-12)) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `variant traffic risk ceiling is violated for ${experimentId}`);
    for (const scenario of evidence.scenarios) {
      const value = scenario.evidence;
      if (value.totalObservations < item.controlPolicy.minimumTotalObservationsForRelaxation) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `insufficient total observations for ${experimentId}/${scenario.scenarioId}`);
      if (value.arms.some((arm) => arm.observations < item.controlPolicy.minimumObservationsPerArmForRelaxation)) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `insufficient per-arm observations for ${experimentId}/${scenario.scenarioId}`);
      const pending = value.arms.reduce((sum, arm) => sum + arm.pendingOutcomes, 0);
      const pendingFraction = value.totalExposures === 0 ? 1 : pending / value.totalExposures;
      if (pendingFraction > item.controlPolicy.maximumPendingOutcomeFractionForRelaxation + 1e-12) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `pending outcome fraction exceeds policy for ${experimentId}/${scenario.scenarioId}`);
      if (targetMode === "ACTIVE" && item.controlPolicy.requireConfidentWinnerForActive && value.confidentWinnerArmId === null) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `ACTIVE requires a confident winner for ${experimentId}/${scenario.scenarioId}`);
    }
  }

  states(): readonly CortexBanditControlPlaneExperimentState[] {
    return Object.freeze([...this.experiments.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([experimentId, item]) => {
      const current = item.control.current();
      const evidence = this.evidenceState(experimentId, item);
      return Object.freeze({ experimentId, policyDigest: item.control.policyDigest, controlPolicyDigest: this.policy.digest, evidenceDigest: evidence.digest, revision: current.revision, mode: current.mode, effectiveMode: item.control.effectiveMode(), configuredMode: item.control.configuredMode });
    }));
  }

  async syncOnce(): Promise<CortexBanditControlPlaneSyncResult> {
    const response = await this.source.pull(Object.freeze({ version: 1, scope: this.scope, experiments: this.states() }));
    const now = this.clock();
    const prepared: Array<{ command: CortexBanditControlPlaneCommand; control: CortexBanditRuntimeController; stale: boolean }> = [];
    for (const command of response.commands) {
      const item = this.experiments.get(command.experimentId);
      if (!item) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command references unknown experiment ${command.experimentId}`);
      const control = item.control;
      if (command.policyDigest !== control.policyDigest) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command policy digest mismatch for ${command.experimentId}`);
      if (command.controlPolicyDigest !== this.policy.digest) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane policy digest mismatch for ${command.experimentId}`);
      const issuedAt = Date.parse(command.issuedAt);
      if (issuedAt > now + this.policy.maxFutureSkewMs || issuedAt < now - this.policy.maxCommandAgeMs) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command timestamp is outside policy for ${command.experimentId}`);
      const current = control.current();
      if (command.expectedRevision > current.revision) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command skips runtime revision for ${command.experimentId}`);
      if (current.changedAt !== null && issuedAt < Date.parse(current.changedAt) && command.expectedRevision === current.revision) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command predates current runtime state for ${command.experimentId}`);
      if (command.expectedRevision < current.revision) {
        prepared.push({ command, control, stale: true });
        continue;
      }
      if (command.mode === current.mode && command.reason === current.reason) {
        prepared.push({ command, control, stale: true });
        continue;
      }
      if (isRelaxation(current.mode, command.mode)) {
        if (command.evidenceDigest === null) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane relaxation requires evidence for ${command.experimentId}`);
        const evidence = this.evidenceState(command.experimentId, item);
        if (command.evidenceDigest !== evidence.digest) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane evidence digest is stale for ${command.experimentId}`);
        this.validateRelaxation(command.experimentId, item, command.mode, evidence);
      } else if (command.evidenceDigest !== null) {
        throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `non-relaxing control-plane command must not claim relaxation evidence for ${command.experimentId}`);
      }
      prepared.push({ command, control, stale: false });
    }

    const applied: string[] = [];
    const stale: string[] = [];
    for (const item of prepared) {
      if (item.stale) { stale.push(item.command.commandId); continue; }
      item.control.set({ expectedRevision: item.command.expectedRevision, mode: item.command.mode, reason: item.command.reason, changedAt: item.command.issuedAt });
      applied.push(item.command.commandId);
    }
    return Object.freeze({ appliedCommandIds: Object.freeze(applied), staleCommandIds: Object.freeze(stale), experimentCount: this.experiments.size });
  }
}

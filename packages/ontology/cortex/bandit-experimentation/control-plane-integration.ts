import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import { createCortexBanditPolicy, type CortexBanditMode } from "./index";
import type { CortexBanditProductionConfig } from "./production-runtime";
import { CortexBanditRuntimeController } from "./runtime-control";

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MODES = new Set<CortexBanditMode>(["ACTIVE", "FALLBACK_ONLY", "KILLED"]);
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CortexBanditControlPlaneExperimentState {
  readonly experimentId: string;
  readonly policyDigest: string;
  readonly revision: number;
  readonly mode: CortexBanditMode;
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

function plainObject(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} contains unknown field ${key}`);
  for (const key of allowed) if (!(key in value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label}.${key} is required`);
}

function identifier(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} is malformed`);
  return value;
}

function digest(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new CortexBanditControlPlaneIntegrationError(code, `${label} is malformed`);
  return value;
}

function revision(value: unknown, label: string, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CortexBanditControlPlaneIntegrationError(code, `${label} must be a non-negative safe integer`);
  return value as number;
}

function mode(value: unknown, code: "INVALID_RESPONSE" | "INVALID_COMMAND" = "INVALID_RESPONSE"): CortexBanditMode {
  if (typeof value !== "string" || !MODES.has(value as CortexBanditMode)) throw new CortexBanditControlPlaneIntegrationError(code, "control-plane mode is invalid");
  return value as CortexBanditMode;
}

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
  if (normalized.length < 32 || normalized.length > 4096) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane bearer token must contain 32..4096 characters");
  return normalized;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 10_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 60_000) throw new CortexBanditControlPlaneIntegrationError("INVALID_CONFIG", "control-plane timeoutMs must be 1000..60000");
  return resolved;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new CortexBanditControlPlaneIntegrationError("INVALID_RESPONSE", "control-plane response must use application/json");
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
        await reader.cancel();
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
  exactKeys(object, ["commandId", "experimentId", "policyDigest", "expectedRevision", "mode", "reason", "issuedAt"], `commands[${index}]`);
  return Object.freeze({
    commandId: identifier(object.commandId, `commands[${index}].commandId`),
    experimentId: identifier(object.experimentId, `commands[${index}].experimentId`),
    policyDigest: digest(object.policyDigest, `commands[${index}].policyDigest`),
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
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpointValue, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.tokenValue}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new CortexBanditControlPlaneIntegrationError("TIMEOUT", "control-plane request timed out");
      throw new CortexBanditControlPlaneIntegrationError("HTTP_ERROR", error instanceof Error ? error.message : "control-plane transport failed");
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new CortexBanditControlPlaneIntegrationError("HTTP_ERROR", `control-plane endpoint returned HTTP ${response.status}`);
    return parseResponse(await boundedJson(response));
  }
}

export class CortexBanditControlPlaneReconciler {
  private readonly controllers = new Map<string, CortexBanditRuntimeController>();
  private readonly scope: OntologyScope;

  constructor(transactions: OntologyTransactionPort, config: CortexBanditProductionConfig, private readonly source: CortexBanditControlPlaneSource, private readonly now: () => number = Date.now) {
    this.scope = config.scope;
    for (const experiment of config.experiments) {
      const policy = createCortexBanditPolicy(experiment.policy);
      this.controllers.set(experiment.experimentId, new CortexBanditRuntimeController(transactions, config.scope, experiment.experimentId, policy.digest, policy.mode, now));
    }
  }

  states(): readonly CortexBanditControlPlaneExperimentState[] {
    return Object.freeze([...this.controllers.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([experimentId, control]) => {
      const current = control.current();
      return Object.freeze({ experimentId, policyDigest: control.policyDigest, revision: current.revision, mode: control.effectiveMode() });
    }));
  }

  async syncOnce(): Promise<CortexBanditControlPlaneSyncResult> {
    const response = await this.source.pull(Object.freeze({ version: 1, scope: this.scope, experiments: this.states() }));
    const now = this.now();
    const prepared: Array<{ command: CortexBanditControlPlaneCommand; control: CortexBanditRuntimeController; stale: boolean }> = [];
    for (const command of response.commands) {
      const control = this.controllers.get(command.experimentId);
      if (!control) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command references unknown experiment ${command.experimentId}`);
      if (command.policyDigest !== control.policyDigest) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command policy digest mismatch for ${command.experimentId}`);
      const issuedAt = Date.parse(command.issuedAt);
      if (issuedAt > now + 60_000 || issuedAt < now - 24 * 60 * 60 * 1000) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command timestamp is outside the accepted window for ${command.experimentId}`);
      const current = control.current();
      if (command.expectedRevision > current.revision) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command skips runtime revision for ${command.experimentId}`);
      if (current.changedAt !== null && issuedAt < Date.parse(current.changedAt) && command.expectedRevision === current.revision) throw new CortexBanditControlPlaneIntegrationError("INVALID_COMMAND", `control-plane command predates current runtime state for ${command.experimentId}`);
      prepared.push({ command, control, stale: command.expectedRevision < current.revision });
    }

    const applied: string[] = [];
    const stale: string[] = [];
    for (const item of prepared) {
      if (item.stale) { stale.push(item.command.commandId); continue; }
      item.control.set({ expectedRevision: item.command.expectedRevision, mode: item.command.mode, reason: item.command.reason, changedAt: item.command.issuedAt });
      applied.push(item.command.commandId);
    }
    return Object.freeze({ appliedCommandIds: Object.freeze(applied), staleCommandIds: Object.freeze(stale), experimentCount: this.controllers.size });
  }
}

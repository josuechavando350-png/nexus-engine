import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ToolResult } from "./contracts.js";
import { readGitState } from "./git.js";
import type { NexusToolName } from "./policy.js";
import type { ProjectSpec } from "./project-new.js";
import {
  nexusBuild,
  nexusCapture,
  nexusComparator,
  nexusGates,
  nexusPassport,
  nexusProjectNew,
  nexusProjects,
  nexusStatus,
  type ToolDependencies,
} from "./tools.js";

export const NEXUS_OPERATOR_AUTHORITY = "NEXUS_OPENAI_OPERATOR" as const;
const SHA_RE = /^[a-f0-9]{40}$/u;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_MAX_COMMAND_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_AUDIT_EVENTS = 8_192;

const scopeSchema = z.object({
  tenantId: z.string().regex(ID_RE),
  organizationId: z.string().regex(ID_RE),
  brandId: z.string().regex(ID_RE),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
}).strict();

const businessSchema = z.object({
  name: z.string().trim().min(1).max(240),
  industry: z.string().trim().min(1).max(240),
  location: z.string().trim().min(1).max(500),
  contact: z.object({
    phone: z.string().trim().min(1).max(100).optional(),
    email: z.string().email().max(320).optional(),
    website: z.string().url().max(2_048).optional(),
    address: z.string().trim().min(1).max(1_000).optional(),
  }).strict(),
  confirmedServices: z.array(z.object({
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(2_000).optional(),
  }).strict()).min(1).max(100),
}).strict();

const artDirectionSchema = z.object({
  palette: z.array(z.object({
    hex: z.string().regex(/^#[A-Fa-f0-9]{6}$/u),
    role: z.string().trim().min(1).max(120),
    rationale: z.string().trim().min(1).max(1_000),
  }).strict()).min(2).max(32).refine((items) => new Set(items.map((item) => item.role)).size === items.length, "palette roles must be unique"),
  typography: z.object({ display: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(240), rationale: z.string().trim().min(1).max(1_000) }).strict(),
  heroComposition: z.object({ direction: z.string().trim().min(1).max(2_000), rationale: z.string().trim().min(1).max(1_000) }).strict(),
  sectionRhythm: z.object({ direction: z.string().trim().min(1).max(2_000), rationale: z.string().trim().min(1).max(1_000) }).strict(),
  motion: z.object({ direction: z.string().trim().min(1).max(2_000), reducedMotionBehavior: z.string().trim().min(1).max(1_000), rationale: z.string().trim().min(1).max(1_000) }).strict(),
  prohibitions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
}).strict();

const projectSpecSchema = z.object({
  slug: z.string().regex(SLUG_RE).refine((value) => !value.includes("--") && !["_", "reference-", "v2-probe-", "probe-", "test-"].some((prefix) => value.startsWith(prefix)), "slug uses a reserved or invalid project prefix"),
  business: businessSchema,
  artDirection: artDirectionSchema,
  branchName: z.string().regex(/^nexus-mcp\/[a-z0-9][a-z0-9/_-]*$/u).max(200).optional(),
  commitMessage: z.string().trim().min(1).max(200).optional(),
}).strict();

const commandBase = z.object({
  scope: scopeSchema,
  sourceSha: z.string().regex(SHA_RE),
  idempotencyKey: z.string().regex(IDEMPOTENCY_RE),
  requestedAt: z.string().min(1).max(64),
  intentSummary: z.string().trim().min(1).max(2_000),
});

export const operatorCommandSchema = z.discriminatedUnion("action", [
  commandBase.extend({ action: z.literal("INSPECT"), payload: z.object({ includePullRequests: z.boolean().optional().default(true) }).strict() }).strict(),
  commandBase.extend({ action: z.literal("PLAN"), payload: z.object({ objective: z.enum(["WEBSITE_DELIVERY", "PROJECT_BOOTSTRAP", "QUALITY_AUDIT"]), target: z.string().regex(SLUG_RE).optional() }).strict() }).strict(),
  commandBase.extend({ action: z.literal("BUILD"), payload: z.object({ target: z.string().regex(SLUG_RE), clean: z.literal(true).optional().default(true) }).strict() }).strict(),
  commandBase.extend({ action: z.literal("VALIDATE"), payload: z.object({ target: z.string().regex(SLUG_RE), gates: z.array(z.enum(["lint", "typecheck", "test", "build", "quality-gates", "browser"])).min(1).max(6).optional() }).strict() }).strict(),
  commandBase.extend({ action: z.literal("CAPTURE"), payload: z.object({ target: z.string().regex(SLUG_RE), fullPage: z.literal(true).optional().default(true) }).strict() }).strict(),
  commandBase.extend({ action: z.literal("AUDIT"), payload: z.object({ target: z.string().regex(SLUG_RE) }).strict() }).strict(),
  commandBase.extend({ action: z.literal("CREATE_PROJECT"), payload: z.object({ spec: projectSpecSchema }).strict() }).strict(),
]);

export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
export type OperatorScope = z.infer<typeof scopeSchema>;
export type OperatorAction = OperatorCommand["action"];
export type OperatorOutcomeStatus = "PASS" | "FAIL" | "NOT_TESTED" | "COMMITTED" | "REJECTED" | "CANCELLED" | "TIMEOUT" | "OUTCOME_UNKNOWN";

export interface OperatorMutationApproval {
  readonly status: "APPROVED" | "DENIED";
  readonly expiresAt: string;
  readonly evidenceDigest: string;
}

/** Server-owned context. It is never accepted from MCP tool input. */
export interface OperatorRequestContext {
  readonly authority: typeof NEXUS_OPERATOR_AUTHORITY;
  readonly authenticated: true;
  readonly writeAuthorized: boolean;
  readonly authorizationExpiresAt: string;
  readonly enabledTools: ReadonlySet<NexusToolName>;
  readonly mutationApproval?: OperatorMutationApproval;
  readonly clock?: () => Date;
}

export interface OperatorStageRecord {
  readonly stage: string;
  readonly tool: NexusToolName | "operator_plan";
  readonly status: "PASS" | "FAIL" | "NOT_TESTED";
  readonly sourceSha: string | null;
  readonly evidence: readonly string[];
  readonly errorCodes: readonly string[];
  readonly data: unknown;
}

export interface OperatorOutcome {
  readonly schemaVersion: "nexus-operator-outcome-v1";
  readonly writerAuthority: typeof NEXUS_OPERATOR_AUTHORITY;
  readonly commandDigest: string;
  readonly action: OperatorAction;
  readonly sourceSha: string;
  readonly status: OperatorOutcomeStatus;
  readonly evidenceDigest: string;
  readonly stages: readonly OperatorStageRecord[];
}

export interface OperatorAuditEvent {
  readonly sequence: number;
  readonly type: "VALIDATED" | "AUTHORIZED" | "DISPATCHED" | "COMPLETED" | "REJECTED" | "BOUNDED_STOP";
  readonly commandDigest: string;
  readonly action: OperatorAction;
  readonly status: OperatorOutcomeStatus | "VALIDATED" | "AUTHORIZED" | "DISPATCHED";
  readonly previousDigest: string;
  readonly eventDigest: string;
}

export interface OperatorRuntimePolicy {
  readonly maxCommandAgeMs?: number;
  readonly maxEntries?: number;
  readonly maxAuditEvents?: number;
}

function canonicalTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp must be valid");
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new Error("timestamp must be canonical ISO-8601 UTC");
  return canonical;
}

function canonicalize(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 32) throw new Error("operator value exceeds canonicalization depth");
  budget.nodes += 1;
  if (budget.nodes > 20_000) throw new Error("operator value exceeds canonicalization node budget");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("operator value contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1, budget));
  if (typeof value !== "object") throw new Error("operator value contains an unsupported type");
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) normalized[key] = canonicalize(record[key], depth + 1, budget);
  return normalized;
}

export function operatorDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function sameScope(expected: OperatorScope, actual: OperatorScope): boolean {
  return expected.tenantId === actual.tenantId && expected.organizationId === actual.organizationId && expected.brandId === actual.brandId && expected.repository === actual.repository;
}

function stageFromTool(result: ToolResult<unknown>): OperatorStageRecord {
  return Object.freeze({
    stage: result.tool,
    tool: result.tool,
    status: result.status,
    sourceSha: result.sourceSha,
    evidence: Object.freeze(result.evidence.map((item) => item.locator)),
    errorCodes: Object.freeze(result.errors.map((item) => item.code)),
    data: result.data,
  });
}

function aggregate(stages: readonly OperatorStageRecord[]): "PASS" | "FAIL" | "NOT_TESTED" {
  if (stages.some((stage) => stage.status === "FAIL")) return "FAIL";
  if (stages.some((stage) => stage.status === "NOT_TESTED")) return "NOT_TESTED";
  return "PASS";
}

function requiredTools(action: OperatorAction): readonly NexusToolName[] {
  switch (action) {
    case "INSPECT": return ["nexus_status", "nexus_projects"];
    case "PLAN": return ["nexus_projects"];
    case "BUILD": return ["nexus_build"];
    case "VALIDATE": return ["nexus_gates"];
    case "CAPTURE": return ["nexus_capture"];
    case "AUDIT": return ["nexus_gates", "nexus_passport", "nexus_comparator"];
    case "CREATE_PROJECT": return ["nexus_project_new"];
  }
}

function planFor(command: Extract<OperatorCommand, { action: "PLAN" }>, projectExists: boolean): readonly string[] {
  if (command.payload.objective === "PROJECT_BOOTSTRAP") {
    return Object.freeze(projectExists
      ? ["nexus_build", "nexus_gates", "nexus_capture", "nexus_passport"]
      : ["nexus_project_new", "nexus_build", "nexus_gates", "nexus_capture", "nexus_passport"]);
  }
  if (command.payload.objective === "QUALITY_AUDIT") return Object.freeze(["nexus_gates", "nexus_passport", "nexus_comparator"]);
  return Object.freeze(["nexus_build", "nexus_gates", "nexus_capture", "nexus_passport", "nexus_comparator"]);
}

export class NexusOperatorRuntime {
  readonly #scope: OperatorScope;
  readonly #maxCommandAgeMs: number;
  readonly #maxEntries: number;
  readonly #maxAuditEvents: number;
  readonly #bindings = new Map<string, string>();
  readonly #terminal = new Map<string, OperatorOutcome>();
  readonly #inflight = new Map<string, Promise<OperatorOutcome>>();
  readonly #audit: OperatorAuditEvent[] = [];
  #auditAnchorDigest = operatorDigest(null);
  #auditStartSequence = 0;

  constructor(scope: OperatorScope, policy: OperatorRuntimePolicy = {}) {
    this.#scope = scopeSchema.parse(scope);
    this.#maxCommandAgeMs = policy.maxCommandAgeMs ?? DEFAULT_MAX_COMMAND_AGE_MS;
    this.#maxEntries = policy.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxAuditEvents = policy.maxAuditEvents ?? DEFAULT_MAX_AUDIT_EVENTS;
    if (!Number.isSafeInteger(this.#maxCommandAgeMs) || this.#maxCommandAgeMs < 1_000 || this.#maxCommandAgeMs > 24 * 60 * 60_000) throw new Error("maxCommandAgeMs is invalid");
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 100_000) throw new Error("maxEntries is invalid");
    if (!Number.isSafeInteger(this.#maxAuditEvents) || this.#maxAuditEvents < 16 || this.#maxAuditEvents > 200_000) throw new Error("maxAuditEvents is invalid");
  }

  get auditTrail(): readonly OperatorAuditEvent[] { return Object.freeze([...this.#audit]); }

  verifyAuditTrail(): void {
    let previousDigest = this.#auditAnchorDigest;
    let sequence = this.#auditStartSequence;
    for (const event of this.#audit) {
      const { eventDigest, ...core } = event;
      if (event.sequence !== sequence || event.previousDigest !== previousDigest || operatorDigest(core) !== eventDigest) throw new Error("operator audit chain verification failed");
      previousDigest = eventDigest;
      sequence += 1;
    }
  }

  #record(type: OperatorAuditEvent["type"], commandDigest: string, action: OperatorAction, status: OperatorAuditEvent["status"]): void {
    const sequence = this.#auditStartSequence + this.#audit.length;
    const previousDigest = this.#audit.at(-1)?.eventDigest ?? this.#auditAnchorDigest;
    const core = { sequence, type, commandDigest, action, status, previousDigest } as const;
    this.#audit.push(Object.freeze({ ...core, eventDigest: operatorDigest(core) }));
    if (this.#audit.length > this.#maxAuditEvents) {
      const removed = this.#audit.shift();
      if (removed) { this.#auditAnchorDigest = removed.eventDigest; this.#auditStartSequence = removed.sequence + 1; }
    }
  }

  #outcome(command: OperatorCommand, commandDigest: string, status: OperatorOutcomeStatus, stages: readonly OperatorStageRecord[]): OperatorOutcome {
    const evidenceDigest = operatorDigest({ commandDigest, action: command.action, sourceSha: command.sourceSha, status, stages: stages.map((stage) => ({ stage: stage.stage, tool: stage.tool, status: stage.status, sourceSha: stage.sourceSha, evidence: stage.evidence, errorCodes: stage.errorCodes })) });
    return Object.freeze({ schemaVersion: "nexus-operator-outcome-v1", writerAuthority: NEXUS_OPERATOR_AUTHORITY, commandDigest, action: command.action, sourceSha: command.sourceSha, status, evidenceDigest, stages: Object.freeze([...stages]) });
  }

  async execute(rawCommand: unknown, dependencies: ToolDependencies, context: OperatorRequestContext, signal?: AbortSignal): Promise<OperatorOutcome> {
    const command = operatorCommandSchema.parse(rawCommand);
    const requestedAt = canonicalTime(command.requestedAt);
    const now = (context.clock ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new Error("operator clock returned an invalid date");
    if (!sameScope(this.#scope, command.scope) || command.scope.repository !== (dependencies.repository ?? "josuechavando350-png/nexus-engine")) throw new Error("operator scope mismatch");
    const age = now.getTime() - Date.parse(requestedAt);
    if (age < -1_000 || age > this.#maxCommandAgeMs) throw new Error("operator command is stale or from the future");
    if (context.authority !== NEXUS_OPERATOR_AUTHORITY || context.authenticated !== true) throw new Error("operator authority is invalid");
    const authorizationExpiresAt = canonicalTime(context.authorizationExpiresAt);
    const commandDigest = operatorDigest(command);
    this.#record("VALIDATED", commandDigest, command.action, "VALIDATED");

    if (signal?.aborted) {
      const outcome = this.#outcome(command, commandDigest, "CANCELLED", []);
      this.#record("BOUNDED_STOP", commandDigest, command.action, "CANCELLED");
      return outcome;
    }
    if (now.getTime() >= Date.parse(authorizationExpiresAt)) {
      const outcome = this.#outcome(command, commandDigest, "TIMEOUT", []);
      this.#record("BOUNDED_STOP", commandDigest, command.action, "TIMEOUT");
      return outcome;
    }
    if (requiredTools(command.action).some((tool) => !context.enabledTools.has(tool))) {
      const outcome = this.#outcome(command, commandDigest, "REJECTED", []);
      this.#record("REJECTED", commandDigest, command.action, "REJECTED");
      return outcome;
    }
    if (command.action === "CREATE_PROJECT") {
      const approval = context.mutationApproval;
      if (!context.writeAuthorized || !approval || approval.status !== "APPROVED" || !DIGEST_RE.test(approval.evidenceDigest) || now.getTime() >= Date.parse(canonicalTime(approval.expiresAt))) {
        const outcome = this.#outcome(command, commandDigest, "REJECTED", []);
        this.#record("REJECTED", commandDigest, command.action, "REJECTED");
        return outcome;
      }
    }
    this.#record("AUTHORIZED", commandDigest, command.action, "AUTHORIZED");

    const existingBinding = this.#bindings.get(command.idempotencyKey);
    if (existingBinding && existingBinding !== commandDigest) throw new Error("operator idempotency key conflict");
    if (!existingBinding) {
      if (this.#bindings.size >= this.#maxEntries) throw new Error("operator idempotency capacity exhausted");
      this.#bindings.set(command.idempotencyKey, commandDigest);
    }
    const terminal = this.#terminal.get(command.idempotencyKey);
    if (terminal) return terminal;
    const inflight = this.#inflight.get(command.idempotencyKey);
    if (inflight) return await inflight;

    const task = this.#dispatch(command, commandDigest, dependencies, context, signal)
      .then((outcome) => {
        this.#terminal.set(command.idempotencyKey, outcome);
        return outcome;
      })
      .finally(() => { this.#inflight.delete(command.idempotencyKey); });
    this.#inflight.set(command.idempotencyKey, task);
    return await task;
  }

  async #dispatch(command: OperatorCommand, commandDigest: string, dependencies: ToolDependencies, context: OperatorRequestContext, signal?: AbortSignal): Promise<OperatorOutcome> {
    const stages: OperatorStageRecord[] = [];
    let mutationDispatched = false;
    const ensureActive = (): OperatorOutcome | null => {
      const now = (context.clock ?? (() => new Date()))();
      if (signal?.aborted) return this.#outcome(command, commandDigest, mutationDispatched ? "OUTCOME_UNKNOWN" : "CANCELLED", stages);
      if (now.getTime() >= Date.parse(context.authorizationExpiresAt)) return this.#outcome(command, commandDigest, mutationDispatched ? "OUTCOME_UNKNOWN" : "TIMEOUT", stages);
      return null;
    };
    const bounded = ensureActive();
    if (bounded) { this.#record("BOUNDED_STOP", commandDigest, command.action, bounded.status); return bounded; }

    let git;
    try { git = await (dependencies.git ?? readGitState)(dependencies.root); }
    catch {
      const outcome = this.#outcome(command, commandDigest, "FAIL", []);
      this.#record("COMPLETED", commandDigest, command.action, "FAIL");
      return outcome;
    }
    if (git.headSha !== command.sourceSha) {
      const outcome = this.#outcome(command, commandDigest, "REJECTED", []);
      this.#record("REJECTED", commandDigest, command.action, "REJECTED");
      return outcome;
    }
    if (!["INSPECT", "PLAN"].includes(command.action) && !git.clean) {
      const outcome = this.#outcome(command, commandDigest, "REJECTED", []);
      this.#record("REJECTED", commandDigest, command.action, "REJECTED");
      return outcome;
    }

    this.#record("DISPATCHED", commandDigest, command.action, "DISPATCHED");
    try {
      switch (command.action) {
        case "INSPECT": {
          stages.push(stageFromTool(await nexusStatus({ includePullRequests: command.payload.includePullRequests }, dependencies) as ToolResult<unknown>));
          const stop = ensureActive(); if (stop) { this.#record("BOUNDED_STOP", commandDigest, command.action, stop.status); return stop; }
          stages.push(stageFromTool(await nexusProjects({}, dependencies) as ToolResult<unknown>));
          break;
        }
        case "PLAN": {
          const projectsResult = await nexusProjects({}, dependencies);
          stages.push(stageFromTool(projectsResult as ToolResult<unknown>));
          const target = command.payload.target;
          const projects = projectsResult.data?.projects ?? [];
          const exists = target ? projects.some((project) => project.slug === target) : false;
          const plan = planFor(command, exists);
          stages.push(Object.freeze({ stage: "operator_plan", tool: "operator_plan", status: projectsResult.status, sourceSha: projectsResult.sourceSha, evidence: Object.freeze([`sha256:${operatorDigest({ objective: command.payload.objective, target: target ?? null, plan })}`]), errorCodes: Object.freeze([]), data: Object.freeze({ objective: command.payload.objective, target: target ?? null, projectExists: exists, steps: plan }) }));
          break;
        }
        case "BUILD":
          stages.push(stageFromTool(await nexusBuild({ target: command.payload.target, sourceSha: command.sourceSha, clean: command.payload.clean }, dependencies) as ToolResult<unknown>));
          break;
        case "VALIDATE":
          stages.push(stageFromTool(await nexusGates({ target: command.payload.target, sourceSha: command.sourceSha, gates: command.payload.gates }, dependencies) as ToolResult<unknown>));
          break;
        case "CAPTURE":
          stages.push(stageFromTool(await nexusCapture({ source: { target: command.payload.target }, sourceSha: command.sourceSha, fullPage: command.payload.fullPage }, dependencies) as ToolResult<unknown>));
          break;
        case "AUDIT": {
          stages.push(stageFromTool(await nexusGates({ target: command.payload.target, sourceSha: command.sourceSha }, dependencies) as ToolResult<unknown>));
          let stop = ensureActive(); if (stop) { this.#record("BOUNDED_STOP", commandDigest, command.action, stop.status); return stop; }
          stages.push(stageFromTool(await nexusPassport({ target: command.payload.target, sourceSha: command.sourceSha }, dependencies) as ToolResult<unknown>));
          stop = ensureActive(); if (stop) { this.#record("BOUNDED_STOP", commandDigest, command.action, stop.status); return stop; }
          stages.push(stageFromTool(await nexusComparator({ source: { target: command.payload.target }, sourceSha: command.sourceSha }, dependencies) as ToolResult<unknown>));
          break;
        }
        case "CREATE_PROJECT": {
          mutationDispatched = true;
          const spec: ProjectSpec = { ...command.payload.spec, baseSha: command.sourceSha };
          const result = await nexusProjectNew(spec, dependencies);
          stages.push(stageFromTool(result as ToolResult<unknown>));
          const status: OperatorOutcomeStatus = result.status === "PASS" ? "COMMITTED" : result.status;
          const outcome = this.#outcome(command, commandDigest, status, stages);
          this.#record("COMPLETED", commandDigest, command.action, status);
          return outcome;
        }
      }
      const status = aggregate(stages);
      const outcome = this.#outcome(command, commandDigest, status, stages);
      this.#record("COMPLETED", commandDigest, command.action, status);
      return outcome;
    } catch {
      const status: OperatorOutcomeStatus = mutationDispatched ? "OUTCOME_UNKNOWN" : "FAIL";
      const outcome = this.#outcome(command, commandDigest, status, stages);
      this.#record(mutationDispatched ? "BOUNDED_STOP" : "COMPLETED", commandDigest, command.action, status);
      return outcome;
    }
  }
}

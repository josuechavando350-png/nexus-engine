import { canonicalJson, digestValue } from "./index.js";
import { validatePresenceScope, type PresenceScope } from "./presence.js";

export type AdvisoryProvider = "ANTHROPIC_CLAUDE" | "OPENAI_CHATGPT" | "OTHER";

export interface AdvisoryProposal {
  readonly formatVersion: "nexus-advisory-proposal-v1";
  readonly scope: PresenceScope;
  readonly provider: AdvisoryProvider;
  readonly instruction: string;
  readonly createdAt: string;
  readonly proposalDigest: string;
}

function cleanInstruction(value: string): string {
  if (typeof value !== "string") throw new Error("instruction must be a string");
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 20_000) throw new Error("instruction must be non-empty and <= 20000 characters");
  return normalized;
}

function canonicalTime(value: string): string {
  if (typeof value !== "string") throw new Error("createdAt must be a string");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("createdAt must be a valid timestamp");
  const iso = new Date(time).toISOString();
  if (iso !== value) throw new Error("createdAt must be canonical ISO-8601 UTC");
  return iso;
}

function sameScope(left: PresenceScope, right: PresenceScope): boolean {
  return left.tenantId === right.tenantId && left.organizationId === right.organizationId && left.brandId === right.brandId;
}

export function createAdvisoryProposal(input: Omit<AdvisoryProposal, "formatVersion" | "proposalDigest">): AdvisoryProposal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory proposal input must be an object");
  const allowed = new Set(["scope", "provider", "instruction", "createdAt"]);
  for (const key of Object.keys(input as object)) if (!allowed.has(key)) throw new Error(`unknown advisory proposal field: ${key}`);
  const scope = validatePresenceScope(input.scope);
  if (!(["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"] as const).includes(input.provider)) throw new Error("unsupported advisory provider");
  const core = {
    formatVersion: "nexus-advisory-proposal-v1" as const,
    scope,
    provider: input.provider,
    instruction: cleanInstruction(input.instruction),
    createdAt: canonicalTime(input.createdAt),
  };
  return Object.freeze({ ...core, proposalDigest: digestValue(core) });
}

export function verifyAdvisoryProposal(expectedScope: PresenceScope, proposal: AdvisoryProposal): boolean {
  try {
    const scope = validatePresenceScope(expectedScope);
    const rebuilt = createAdvisoryProposal({
      scope: proposal.scope,
      provider: proposal.provider,
      instruction: proposal.instruction,
      createdAt: proposal.createdAt,
    });
    return sameScope(scope, rebuilt.scope) && canonicalJson(rebuilt) === canonicalJson(proposal);
  } catch {
    return false;
  }
}

export type NexusWriterAuthority = "NEXUS_OPENAI_OPERATOR";
export type AdvisoryApprovalStatus = "APPROVED" | "DENIED";
export type AdvisoryExecutionStatus = "COMMITTED" | "REJECTED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN" | "CANCELLED" | "TIMEOUT";

export interface AdvisoryApproval {
  readonly status: AdvisoryApprovalStatus;
  readonly proposalDigest: string;
  readonly scope: PresenceScope;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly approvalDigest: string;
}

export interface AdvisoryExecutionRequest {
  readonly writerAuthority: NexusWriterAuthority;
  readonly proposal: AdvisoryProposal;
  readonly approval: AdvisoryApproval;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface AdvisoryExecutionOutcome {
  readonly status: AdvisoryExecutionStatus;
  readonly requestDigest: string;
  readonly evidenceDigest: string;
  readonly detail?: string;
}

/**
 * The only write-capable adapter on this boundary. Implementations are NEXUS-owned
 * executors operated by the OpenAI/ChatGPT control plane. Advisory providers never
 * receive an instance of this interface or credentials capable of implementing it.
 */
export interface NexusAdvisoryExecutor {
  execute(request: AdvisoryExecutionRequest, signal: AbortSignal): Promise<AdvisoryExecutionOutcome>;
}

/** Read-only future provider transport. It can only return proposal data. */
export interface AdvisoryProposalSource {
  readonly provider: AdvisoryProvider;
  read(signal: AbortSignal): Promise<AdvisoryProposal>;
}

export interface AdvisoryRuntimePolicy {
  readonly scope: PresenceScope;
  readonly allowedProviders: readonly AdvisoryProvider[];
  readonly maxProposalAgeMs: number;
  readonly timeoutMs: number;
}

export interface AdvisoryExecutionInput {
  readonly proposal: AdvisoryProposal;
  readonly approval: AdvisoryApproval;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly signal?: AbortSignal;
}

export interface AdvisoryAuditEvent {
  readonly sequence: number;
  readonly type: "VALIDATED" | "DENIED" | "DISPATCHED" | "COMPLETED" | "BOUNDED_STOP";
  readonly proposalDigest: string;
  readonly requestDigest: string;
  readonly status: AdvisoryExecutionStatus | "VALIDATED";
  readonly previousDigest: string;
  readonly eventDigest: string;
}

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TIMEOUT_MS = 60_000;
const MAX_PROPOSAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown or missing fields`);
}

function validatePolicy(input: AdvisoryRuntimePolicy): Readonly<AdvisoryRuntimePolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory policy must be an object");
  assertExactKeys(input, ["scope", "allowedProviders", "maxProposalAgeMs", "timeoutMs"], "advisory policy");
  const scope = validatePresenceScope(input.scope);
  if (!Array.isArray(input.allowedProviders) || input.allowedProviders.length === 0 || input.allowedProviders.length > 3) throw new Error("allowedProviders is invalid");
  const providers = [...new Set(input.allowedProviders)];
  if (providers.length !== input.allowedProviders.length || providers.some((provider) => !(["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"] as const).includes(provider))) throw new Error("allowedProviders is invalid");
  if (!Number.isInteger(input.maxProposalAgeMs) || input.maxProposalAgeMs < 0 || input.maxProposalAgeMs > MAX_PROPOSAL_AGE_MS) throw new Error("maxProposalAgeMs is invalid");
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 10 || input.timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeoutMs is invalid");
  return Object.freeze({ scope, allowedProviders: Object.freeze(providers), maxProposalAgeMs: input.maxProposalAgeMs, timeoutMs: input.timeoutMs });
}

export function createAdvisoryApproval(input: Omit<AdvisoryApproval, "approvalDigest">): AdvisoryApproval {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("approval must be an object");
  assertExactKeys(input, ["status", "proposalDigest", "scope", "approvedAt", "expiresAt"], "approval");
  if (input.status !== "APPROVED" && input.status !== "DENIED") throw new Error("approval status is invalid");
  if (!DIGEST_RE.test(input.proposalDigest)) throw new Error("approval proposal digest is invalid");
  const scope = validatePresenceScope(input.scope);
  const approvedAt = canonicalTime(input.approvedAt);
  const expiresAt = canonicalTime(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) throw new Error("approval expiry must be after approval time");
  const core = { status: input.status, proposalDigest: input.proposalDigest, scope, approvedAt, expiresAt } as const;
  return Object.freeze({ ...core, approvalDigest: digestValue(core) });
}

export function verifyAdvisoryApproval(expectedScope: PresenceScope, proposal: AdvisoryProposal, approval: AdvisoryApproval, now: string): boolean {
  try {
    const rebuilt = createAdvisoryApproval({
      status: approval.status,
      proposalDigest: approval.proposalDigest,
      scope: approval.scope,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
    });
    const canonicalNow = canonicalTime(now);
    return canonicalJson(rebuilt) === canonicalJson(approval)
      && sameScope(validatePresenceScope(expectedScope), rebuilt.scope)
      && rebuilt.proposalDigest === proposal.proposalDigest
      && rebuilt.status === "APPROVED"
      && Date.parse(canonicalNow) >= Date.parse(rebuilt.approvedAt)
      && Date.parse(canonicalNow) < Date.parse(rebuilt.expiresAt);
  } catch {
    return false;
  }
}

function createRequest(proposal: AdvisoryProposal, approval: AdvisoryApproval, idempotencyKey: string): AdvisoryExecutionRequest {
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) throw new Error("idempotencyKey is invalid");
  const core = { writerAuthority: "NEXUS_OPENAI_OPERATOR" as const, proposal, approval, idempotencyKey };
  return Object.freeze({ ...core, requestDigest: digestValue(core) });
}

function normalizeOutcome(outcome: AdvisoryExecutionOutcome, requestDigest: string): AdvisoryExecutionOutcome {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) throw new Error("executor outcome must be an object");
  const allowed = outcome.detail === undefined ? ["status", "requestDigest", "evidenceDigest"] : ["status", "requestDigest", "evidenceDigest", "detail"];
  assertExactKeys(outcome, allowed, "executor outcome");
  if (!(<readonly string[]>["COMMITTED", "REJECTED", "UNAVAILABLE", "OUTCOME_UNKNOWN", "CANCELLED", "TIMEOUT"]).includes(outcome.status)) throw new Error("executor outcome status is invalid");
  if (outcome.requestDigest !== requestDigest) throw new Error("executor outcome request binding mismatch");
  if (!DIGEST_RE.test(outcome.evidenceDigest)) throw new Error("executor evidence digest is invalid");
  if (outcome.detail !== undefined && (typeof outcome.detail !== "string" || outcome.detail.length > 2_000)) throw new Error("executor outcome detail is invalid");
  return Object.freeze({ ...outcome });
}

class AdvisoryBoundaryError extends Error {
  constructor(readonly reason: "TIMEOUT" | "CANCELLED") {
    super(reason);
    this.name = "AdvisoryBoundaryError";
  }
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw new AdvisoryBoundaryError("CANCELLED");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => controller.abort(new AdvisoryBoundaryError("CANCELLED"));
  parent?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new AdvisoryBoundaryError("TIMEOUT");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new AdvisoryBoundaryError("CANCELLED")), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

export class GovernedAdvisoryRuntime {
  readonly #policy: Readonly<AdvisoryRuntimePolicy>;
  readonly #executor: NexusAdvisoryExecutor;
  readonly #terminal = new Map<string, AdvisoryExecutionOutcome>();
  readonly #bindings = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<AdvisoryExecutionOutcome>>();
  readonly #audit: AdvisoryAuditEvent[] = [];

  constructor(policy: AdvisoryRuntimePolicy, executor: NexusAdvisoryExecutor) {
    this.#policy = validatePolicy(policy);
    if (!executor || typeof executor.execute !== "function") throw new Error("NEXUS advisory executor is invalid");
    this.#executor = executor;
  }

  get auditTrail(): readonly AdvisoryAuditEvent[] { return Object.freeze([...this.#audit]); }

  #record(type: AdvisoryAuditEvent["type"], proposalDigest: string, requestDigest: string, status: AdvisoryAuditEvent["status"]): void {
    const previousDigest = this.#audit.at(-1)?.eventDigest ?? digestValue(null);
    const core = { sequence: this.#audit.length, type, proposalDigest, requestDigest, status, previousDigest };
    this.#audit.push(Object.freeze({ ...core, eventDigest: digestValue(core) }));
  }

  verifyAuditTrail(): void {
    let previousDigest = digestValue(null);
    this.#audit.forEach((event, sequence) => {
      assertExactKeys(event, ["sequence", "type", "proposalDigest", "requestDigest", "status", "previousDigest", "eventDigest"], "advisory audit event");
      const { eventDigest, ...core } = event;
      if (event.sequence !== sequence || event.previousDigest !== previousDigest || digestValue(core) !== eventDigest) throw new Error("advisory audit chain verification failed");
      previousDigest = eventDigest;
    });
  }

  async execute(input: AdvisoryExecutionInput): Promise<AdvisoryExecutionOutcome> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory execution input must be an object");
    const allowed = input.signal === undefined ? ["proposal", "approval", "idempotencyKey", "now"] : ["proposal", "approval", "idempotencyKey", "now", "signal"];
    assertExactKeys(input, allowed, "advisory execution input");
    const now = canonicalTime(input.now);
    if (!verifyAdvisoryProposal(this.#policy.scope, input.proposal)) throw new Error("advisory proposal failed scope/integrity validation");
    if (!this.#policy.allowedProviders.includes(input.proposal.provider)) throw new Error("advisory provider is not allowed by policy");
    const age = Date.parse(now) - Date.parse(input.proposal.createdAt);
    if (age < 0 || age > this.#policy.maxProposalAgeMs) throw new Error("advisory proposal is stale or from the future");
    const request = createRequest(input.proposal, input.approval, input.idempotencyKey);
    if (!verifyAdvisoryApproval(this.#policy.scope, input.proposal, input.approval, now)) {
      this.#record("DENIED", input.proposal.proposalDigest, request.requestDigest, "REJECTED");
      return Object.freeze({ status: "REJECTED", requestDigest: request.requestDigest, evidenceDigest: digestValue({ reason: "APPROVAL_DENIED", requestDigest: request.requestDigest }) });
    }
    this.#record("VALIDATED", input.proposal.proposalDigest, request.requestDigest, "VALIDATED");

    const existingBinding = this.#bindings.get(input.idempotencyKey);
    if (existingBinding && existingBinding !== request.requestDigest) throw new Error("idempotency key conflict");
    this.#bindings.set(input.idempotencyKey, request.requestDigest);
    const terminal = this.#terminal.get(input.idempotencyKey);
    if (terminal) return terminal;
    const inflight = this.#inflight.get(input.idempotencyKey);
    if (inflight) return await inflight;

    const task = (async (): Promise<AdvisoryExecutionOutcome> => {
      this.#record("DISPATCHED", input.proposal.proposalDigest, request.requestDigest, "VALIDATED");
      try {
        const outcome = normalizeOutcome(await bounded((signal) => this.#executor.execute(request, signal), this.#policy.timeoutMs, input.signal), request.requestDigest);
        this.#record("COMPLETED", input.proposal.proposalDigest, request.requestDigest, outcome.status);
        if (outcome.status === "COMMITTED" || outcome.status === "REJECTED" || outcome.status === "UNAVAILABLE") this.#terminal.set(input.idempotencyKey, outcome);
        else this.#terminal.set(input.idempotencyKey, outcome);
        return outcome;
      } catch (error) {
        const boundedReason = error instanceof AdvisoryBoundaryError ? error.reason : null;
        const status: AdvisoryExecutionStatus = boundedReason === "TIMEOUT" ? "TIMEOUT" : boundedReason === "CANCELLED" ? "CANCELLED" : "OUTCOME_UNKNOWN";
        const outcome = Object.freeze({ status, requestDigest: request.requestDigest, evidenceDigest: digestValue({ status, requestDigest: request.requestDigest }) });
        this.#record("BOUNDED_STOP", input.proposal.proposalDigest, request.requestDigest, status);
        this.#terminal.set(input.idempotencyKey, outcome);
        return outcome;
      } finally {
        this.#inflight.delete(input.idempotencyKey);
      }
    })();
    this.#inflight.set(input.idempotencyKey, task);
    return await task;
  }

  async ingest(source: AdvisoryProposalSource, approval: AdvisoryApproval, idempotencyKey: string, now: string, signal?: AbortSignal): Promise<AdvisoryExecutionOutcome> {
    if (!source || !this.#policy.allowedProviders.includes(source.provider) || typeof source.read !== "function") throw new Error("advisory source is invalid or not allowed");
    const proposal = await bounded((childSignal) => source.read(childSignal), this.#policy.timeoutMs, signal);
    if (proposal.provider !== source.provider) throw new Error("advisory source/provider mismatch");
    return await this.execute({ proposal, approval, idempotencyKey, now, ...(signal ? { signal } : {}) });
  }
}

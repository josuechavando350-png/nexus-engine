import { canonicalJson, digestValue } from "./index.js";
import { validatePresenceScope, type PresenceScope } from "./presence.js";

export type AdvisoryProvider = "ANTHROPIC_CLAUDE" | "OPENAI_CHATGPT" | "OTHER";
export type NexusWriterAuthority = "NEXUS_OPENAI_OPERATOR";
export type AdvisoryExecutionStatus = "COMMITTED" | "REJECTED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN" | "CANCELLED" | "TIMEOUT";

export interface AdvisoryProposal {
  readonly formatVersion: "nexus-advisory-proposal-v1";
  readonly scope: PresenceScope;
  readonly provider: AdvisoryProvider;
  readonly instruction: string;
  readonly createdAt: string;
  readonly proposalDigest: string;
}

/** Integrity envelope only; authoritative approval is re-verified by NEXUS governance. */
export interface AdvisoryApproval {
  readonly status: "APPROVED" | "DENIED";
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

export interface AdvisoryGovernanceDecision {
  readonly decision: "ALLOW" | "DENY";
  readonly requestDigest: string;
  readonly authorization: "VERIFIED" | "DENIED";
  readonly capability: "ADVISORY_EXECUTION" | "DENIED";
  readonly budget: "WITHIN_LIMIT" | "EXCEEDED";
  readonly approval: "VERIFIED" | "DENIED";
  readonly evidenceDigest: string;
}

/** NEXUS-side bridge to canonical authorization/capability/budget/approval policy. */
export interface NexusAdvisoryGovernancePort {
  authorize(request: AdvisoryExecutionRequest, now: string, signal: AbortSignal): Promise<AdvisoryGovernanceDecision>;
}

/** The sole write-capable adapter. Advisory providers never receive this interface or its credentials. */
export interface NexusAdvisoryExecutor {
  execute(request: AdvisoryExecutionRequest, signal: AbortSignal): Promise<AdvisoryExecutionOutcome>;
}

/** Provider-neutral and deliberately read-only. */
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
  readonly type: "VALIDATED" | "GOVERNED" | "DENIED" | "DISPATCHED" | "COMPLETED" | "BOUNDED_STOP";
  readonly proposalDigest: string;
  readonly requestDigest: string;
  readonly status: AdvisoryExecutionStatus | "VALIDATED" | "GOVERNED";
  readonly previousDigest: string;
  readonly eventDigest: string;
}

const PROVIDERS: readonly AdvisoryProvider[] = ["ANTHROPIC_CLAUDE", "OPENAI_CHATGPT", "OTHER"];
const EXECUTION_STATUSES: readonly AdvisoryExecutionStatus[] = ["COMMITTED", "REJECTED", "UNAVAILABLE", "OUTCOME_UNKNOWN", "CANCELLED", "TIMEOUT"];
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TIMEOUT_MS = 60_000;
const MAX_PROPOSAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown or missing fields`);
}

function canonicalTime(value: string): string {
  if (typeof value !== "string") throw new Error("timestamp must be a string");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp must be valid");
  const iso = new Date(parsed).toISOString();
  if (iso !== value) throw new Error("timestamp must be canonical ISO-8601 UTC");
  return iso;
}

function sameScope(a: PresenceScope, b: PresenceScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function cleanInstruction(value: string): string {
  if (typeof value !== "string") throw new Error("instruction must be a string");
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 20_000) throw new Error("instruction must be non-empty and <= 20000 characters");
  return normalized;
}

export function createAdvisoryProposal(input: Omit<AdvisoryProposal, "formatVersion" | "proposalDigest">): AdvisoryProposal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory proposal input must be an object");
  exactKeys(input, ["scope", "provider", "instruction", "createdAt"], "advisory proposal");
  const scope = validatePresenceScope(input.scope);
  if (!PROVIDERS.includes(input.provider)) throw new Error("unsupported advisory provider");
  const core = { formatVersion: "nexus-advisory-proposal-v1" as const, scope, provider: input.provider, instruction: cleanInstruction(input.instruction), createdAt: canonicalTime(input.createdAt) };
  return Object.freeze({ ...core, proposalDigest: digestValue(core) });
}

export function verifyAdvisoryProposal(expectedScope: PresenceScope, proposal: AdvisoryProposal): boolean {
  try {
    const rebuilt = createAdvisoryProposal({ scope: proposal.scope, provider: proposal.provider, instruction: proposal.instruction, createdAt: proposal.createdAt });
    return sameScope(validatePresenceScope(expectedScope), rebuilt.scope) && canonicalJson(rebuilt) === canonicalJson(proposal);
  } catch { return false; }
}

export function createAdvisoryApproval(input: Omit<AdvisoryApproval, "approvalDigest">): AdvisoryApproval {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("approval must be an object");
  exactKeys(input, ["status", "proposalDigest", "scope", "approvedAt", "expiresAt"], "approval");
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
    const rebuilt = createAdvisoryApproval({ status: approval.status, proposalDigest: approval.proposalDigest, scope: approval.scope, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
    const instant = Date.parse(canonicalTime(now));
    return canonicalJson(rebuilt) === canonicalJson(approval) && sameScope(validatePresenceScope(expectedScope), rebuilt.scope) && rebuilt.proposalDigest === proposal.proposalDigest && rebuilt.status === "APPROVED" && instant >= Date.parse(rebuilt.approvedAt) && instant < Date.parse(rebuilt.expiresAt);
  } catch { return false; }
}

function validatePolicy(input: AdvisoryRuntimePolicy): Readonly<AdvisoryRuntimePolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory policy must be an object");
  exactKeys(input, ["scope", "allowedProviders", "maxProposalAgeMs", "timeoutMs"], "advisory policy");
  const scope = validatePresenceScope(input.scope);
  if (!Array.isArray(input.allowedProviders) || input.allowedProviders.length === 0 || input.allowedProviders.length > PROVIDERS.length) throw new Error("allowedProviders is invalid");
  const providers = [...new Set(input.allowedProviders)];
  if (providers.length !== input.allowedProviders.length || providers.some((provider) => !PROVIDERS.includes(provider))) throw new Error("allowedProviders is invalid");
  if (!Number.isInteger(input.maxProposalAgeMs) || input.maxProposalAgeMs < 0 || input.maxProposalAgeMs > MAX_PROPOSAL_AGE_MS) throw new Error("maxProposalAgeMs is invalid");
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 10 || input.timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeoutMs is invalid");
  return Object.freeze({ scope, allowedProviders: Object.freeze(providers), maxProposalAgeMs: input.maxProposalAgeMs, timeoutMs: input.timeoutMs });
}

function createRequest(proposal: AdvisoryProposal, approval: AdvisoryApproval, idempotencyKey: string): AdvisoryExecutionRequest {
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) throw new Error("idempotencyKey is invalid");
  const core = { writerAuthority: "NEXUS_OPENAI_OPERATOR" as const, proposal, approval, idempotencyKey };
  return Object.freeze({ ...core, requestDigest: digestValue(core) });
}

function normalizeGovernance(value: AdvisoryGovernanceDecision, requestDigest: string): AdvisoryGovernanceDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("governance decision must be an object");
  exactKeys(value, ["decision", "requestDigest", "authorization", "capability", "budget", "approval", "evidenceDigest"], "governance decision");
  if (!DIGEST_RE.test(value.evidenceDigest) || value.requestDigest !== requestDigest) throw new Error("governance decision binding is invalid");
  const fieldsValid = (value.decision === "ALLOW" || value.decision === "DENY") && (value.authorization === "VERIFIED" || value.authorization === "DENIED") && (value.capability === "ADVISORY_EXECUTION" || value.capability === "DENIED") && (value.budget === "WITHIN_LIMIT" || value.budget === "EXCEEDED") && (value.approval === "VERIFIED" || value.approval === "DENIED");
  if (!fieldsValid) throw new Error("governance decision status is invalid");
  if (value.decision === "ALLOW" && (value.authorization !== "VERIFIED" || value.capability !== "ADVISORY_EXECUTION" || value.budget !== "WITHIN_LIMIT" || value.approval !== "VERIFIED")) throw new Error("governance ALLOW is internally inconsistent");
  return Object.freeze({ ...value });
}

function normalizeOutcome(value: AdvisoryExecutionOutcome, requestDigest: string): AdvisoryExecutionOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("executor outcome must be an object");
  exactKeys(value, value.detail === undefined ? ["status", "requestDigest", "evidenceDigest"] : ["status", "requestDigest", "evidenceDigest", "detail"], "executor outcome");
  if (!EXECUTION_STATUSES.includes(value.status) || value.requestDigest !== requestDigest || !DIGEST_RE.test(value.evidenceDigest)) throw new Error("executor outcome binding is invalid");
  if (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 2_000)) throw new Error("executor outcome detail is invalid");
  return Object.freeze({ ...value });
}

class BoundaryStop extends Error {
  constructor(readonly reason: "TIMEOUT" | "CANCELLED") { super(reason); this.name = "BoundaryStop"; }
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw new BoundaryStop("CANCELLED");
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(new BoundaryStop("CANCELLED"));
  parent?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new BoundaryStop("TIMEOUT"); controller.abort(error); reject(error); }, timeoutMs);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new BoundaryStop("CANCELLED")), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

export class GovernedAdvisoryRuntime {
  readonly #policy: Readonly<AdvisoryRuntimePolicy>;
  readonly #governance: NexusAdvisoryGovernancePort;
  readonly #executor: NexusAdvisoryExecutor;
  readonly #terminal = new Map<string, AdvisoryExecutionOutcome>();
  readonly #bindings = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<AdvisoryExecutionOutcome>>();
  readonly #audit: AdvisoryAuditEvent[] = [];

  constructor(policy: AdvisoryRuntimePolicy, governance: NexusAdvisoryGovernancePort, executor: NexusAdvisoryExecutor) {
    this.#policy = validatePolicy(policy);
    if (!governance || typeof governance.authorize !== "function") throw new Error("NEXUS advisory governance port is invalid");
    if (!executor || typeof executor.execute !== "function") throw new Error("NEXUS advisory executor is invalid");
    this.#governance = governance;
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
      const { eventDigest, ...core } = event;
      if (event.sequence !== sequence || event.previousDigest !== previousDigest || digestValue(core) !== eventDigest) throw new Error("advisory audit chain verification failed");
      previousDigest = eventDigest;
    });
  }

  async execute(input: AdvisoryExecutionInput): Promise<AdvisoryExecutionOutcome> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("advisory execution input must be an object");
    exactKeys(input, input.signal === undefined ? ["proposal", "approval", "idempotencyKey", "now"] : ["proposal", "approval", "idempotencyKey", "now", "signal"], "advisory execution input");
    const now = canonicalTime(input.now);
    if (!verifyAdvisoryProposal(this.#policy.scope, input.proposal)) throw new Error("advisory proposal failed scope/integrity validation");
    if (!this.#policy.allowedProviders.includes(input.proposal.provider)) throw new Error("advisory provider is not allowed by policy");
    const age = Date.parse(now) - Date.parse(input.proposal.createdAt);
    if (age < 0 || age > this.#policy.maxProposalAgeMs) throw new Error("advisory proposal is stale or from the future");
    const request = createRequest(input.proposal, input.approval, input.idempotencyKey);
    if (!verifyAdvisoryApproval(this.#policy.scope, input.proposal, input.approval, now)) {
      this.#record("DENIED", input.proposal.proposalDigest, request.requestDigest, "REJECTED");
      return Object.freeze({ status: "REJECTED", requestDigest: request.requestDigest, evidenceDigest: digestValue({ reason: "PRELIMINARY_APPROVAL_INVALID", requestDigest: request.requestDigest }) });
    }
    this.#record("VALIDATED", input.proposal.proposalDigest, request.requestDigest, "VALIDATED");

    const existing = this.#bindings.get(input.idempotencyKey);
    if (existing && existing !== request.requestDigest) throw new Error("idempotency key conflict");
    this.#bindings.set(input.idempotencyKey, request.requestDigest);
    const terminal = this.#terminal.get(input.idempotencyKey);
    if (terminal) return terminal;
    const inflight = this.#inflight.get(input.idempotencyKey);
    if (inflight) return await inflight;

    const task = (async (): Promise<AdvisoryExecutionOutcome> => {
      try {
        let decision: AdvisoryGovernanceDecision;
        try {
          decision = normalizeGovernance(await bounded((signal) => this.#governance.authorize(request, now, signal), this.#policy.timeoutMs, input.signal), request.requestDigest);
        } catch (error) {
          const status: AdvisoryExecutionStatus = error instanceof BoundaryStop && error.reason === "CANCELLED" ? "CANCELLED" : error instanceof BoundaryStop ? "TIMEOUT" : "UNAVAILABLE";
          const outcome = Object.freeze({ status, requestDigest: request.requestDigest, evidenceDigest: digestValue({ stage: "GOVERNANCE", status, requestDigest: request.requestDigest }) });
          this.#record("BOUNDED_STOP", input.proposal.proposalDigest, request.requestDigest, status);
          this.#terminal.set(input.idempotencyKey, outcome);
          return outcome;
        }
        if (decision.decision !== "ALLOW") {
          const outcome = Object.freeze({ status: "REJECTED" as const, requestDigest: request.requestDigest, evidenceDigest: decision.evidenceDigest });
          this.#record("DENIED", input.proposal.proposalDigest, request.requestDigest, "REJECTED");
          this.#terminal.set(input.idempotencyKey, outcome);
          return outcome;
        }
        this.#record("GOVERNED", input.proposal.proposalDigest, request.requestDigest, "GOVERNED");
        this.#record("DISPATCHED", input.proposal.proposalDigest, request.requestDigest, "VALIDATED");
        try {
          const outcome = normalizeOutcome(await bounded((signal) => this.#executor.execute(request, signal), this.#policy.timeoutMs, input.signal), request.requestDigest);
          this.#record("COMPLETED", input.proposal.proposalDigest, request.requestDigest, outcome.status);
          this.#terminal.set(input.idempotencyKey, outcome);
          return outcome;
        } catch (error) {
          const status: AdvisoryExecutionStatus = error instanceof BoundaryStop && error.reason === "TIMEOUT" ? "TIMEOUT" : error instanceof BoundaryStop && error.reason === "CANCELLED" ? "CANCELLED" : "OUTCOME_UNKNOWN";
          const outcome = Object.freeze({ status, requestDigest: request.requestDigest, evidenceDigest: digestValue({ stage: "EXECUTION", status, requestDigest: request.requestDigest }) });
          this.#record("BOUNDED_STOP", input.proposal.proposalDigest, request.requestDigest, status);
          this.#terminal.set(input.idempotencyKey, outcome);
          return outcome;
        }
      } finally { this.#inflight.delete(input.idempotencyKey); }
    })();
    this.#inflight.set(input.idempotencyKey, task);
    return await task;
  }

  async ingest(source: AdvisoryProposalSource, approval: AdvisoryApproval, idempotencyKey: string, now: string, signal?: AbortSignal): Promise<AdvisoryExecutionOutcome> {
    if (!source || !this.#policy.allowedProviders.includes(source.provider) || typeof source.read !== "function") throw new Error("advisory source is invalid or not allowed");
    const proposal = await bounded((child) => source.read(child), this.#policy.timeoutMs, signal);
    if (proposal.provider !== source.provider) throw new Error("advisory source/provider mismatch");
    return await this.execute({ proposal, approval, idempotencyKey, now, ...(signal ? { signal } : {}) });
  }
}

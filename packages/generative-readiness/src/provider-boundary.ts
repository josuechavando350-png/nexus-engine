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

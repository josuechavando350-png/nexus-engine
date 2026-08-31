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

export function createAdvisoryProposal(input: Omit<AdvisoryProposal, "formatVersion" | "proposalDigest">): AdvisoryProposal {
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

export function verifyAdvisoryProposal(proposal: AdvisoryProposal): boolean {
  try {
    const rebuilt = createAdvisoryProposal(proposal);
    return canonicalJson(rebuilt) === canonicalJson(proposal);
  } catch {
    return false;
  }
}

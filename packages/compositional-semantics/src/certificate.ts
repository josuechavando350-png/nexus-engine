import { digestValue } from "@nexus/visual-algebra";
import type {
  SemanticVerificationCertificate,
  VerificationIssue,
  VerificationResult,
  VerificationPolicy,
  VerificationStatus,
  VerificationTraceEntry,
} from "./types.js";
import { validateSemanticState } from "./state.js";

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256 hex`);
}

function assertVerificationStatus(value: unknown): asserts value is VerificationStatus {
  if (value !== "VERIFIED" && value !== "REJECTED") {
    throw new Error(`Unsupported semantic verification status: ${String(value)}`);
  }
}

export function createSemanticVerificationCertificate(input: {
  readonly planId: string;
  readonly subject: string;
  readonly compositionDigest: string;
  readonly initialStateDigest: string;
  readonly finalStateDigest: string;
  readonly status: VerificationStatus;
  readonly policy: VerificationPolicy;
  readonly issues: readonly VerificationIssue[];
  readonly trace: readonly VerificationTraceEntry[];
}): SemanticVerificationCertificate {
  if (!input.planId.trim()) throw new Error("planId cannot be empty");
  if (!input.subject.trim()) throw new Error("subject cannot be empty");
  assertSha256(input.compositionDigest, "compositionDigest");
  assertSha256(input.initialStateDigest, "initialStateDigest");
  assertSha256(input.finalStateDigest, "finalStateDigest");
  assertVerificationStatus(input.status);
  if (!Number.isInteger(input.policy.maxDepth) || input.policy.maxDepth < 1 || input.policy.maxDepth > 128) throw new Error("Invalid semantic verification maxDepth");
  if (typeof input.policy.failFast !== "boolean") throw new Error("Invalid semantic verification failFast policy");
  const policyDigest = digestValue(input.policy);
  const issuesDigest = digestValue(input.issues);
  const traceDigest = digestValue(input.trace);
  const base = {
    authority: "NEXUS_COMPOSITIONAL_SEMANTICS_V1" as const,
    version: 1 as const,
    planId: input.planId,
    subject: input.subject,
    compositionDigest: input.compositionDigest,
    initialStateDigest: input.initialStateDigest,
    finalStateDigest: input.finalStateDigest,
    status: input.status,
    policyDigest,
    issuesDigest,
    traceDigest,
  };
  return Object.freeze({ ...base, certificateDigest: digestValue(base) });
}

export function validateVerificationResult(result: VerificationResult): void {
  validateSemanticState(result.initialState);
  validateSemanticState(result.finalState);
  assertSha256(result.compositionDigest, "compositionDigest");
  assertVerificationStatus(result.status);
  if (!Number.isInteger(result.policy.maxDepth) || result.policy.maxDepth < 1 || result.policy.maxDepth > 128 || typeof result.policy.failFast !== "boolean") {
    throw new Error("Invalid semantic verification policy");
  }
  if (result.status === "VERIFIED" && result.issues.length !== 0) throw new Error("Verified semantic result cannot contain issues");
  if (result.status === "REJECTED" && result.issues.length === 0) throw new Error("Rejected semantic result requires at least one issue");
  for (const entry of result.trace) assertSha256(entry.stateDigest, "trace stateDigest");
  const certificate = result.certificate;
  if (certificate.authority !== "NEXUS_COMPOSITIONAL_SEMANTICS_V1" || certificate.version !== 1) {
    throw new Error("Unsupported compositional-semantics certificate");
  }
  assertVerificationStatus(certificate.status);
  if (certificate.compositionDigest !== result.compositionDigest ||
      certificate.initialStateDigest !== result.initialState.digest ||
      certificate.finalStateDigest !== result.finalState.digest ||
      certificate.status !== result.status ||
      certificate.policyDigest !== digestValue(result.policy)) {
    throw new Error("Semantic verification certificate linkage mismatch");
  }
  if (certificate.issuesDigest !== digestValue(result.issues) || certificate.traceDigest !== digestValue(result.trace)) {
    throw new Error("Semantic verification evidence digest mismatch");
  }
  const { certificateDigest, ...base } = certificate;
  if (digestValue(base) !== certificateDigest) throw new Error("Semantic verification certificate digest mismatch");
}

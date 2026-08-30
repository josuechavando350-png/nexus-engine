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
import { semanticCompositionDigest, validateSemanticComposition } from "./composition.js";
import { executeSemanticComposition } from "./execution.js";

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256 hex`);
}

function assertVerificationStatus(value: unknown): asserts value is VerificationStatus {
  if (value !== "VERIFIED" && value !== "REJECTED") {
    throw new Error(`Unsupported semantic verification status: ${String(value)}`);
  }
}

function assertPolicy(policy: VerificationPolicy): void {
  if (!policy || typeof policy !== "object" || !Number.isInteger(policy.maxDepth) || policy.maxDepth < 1 || policy.maxDepth > 128) {
    throw new Error("Invalid semantic verification maxDepth");
  }
  if (typeof policy.failFast !== "boolean") throw new Error("Invalid semantic verification failFast policy");
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
  assertPolicy(input.policy);
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
  if (!result || typeof result !== "object") throw new Error("Semantic verification result must be an object");
  assertVerificationStatus(result.status);
  assertPolicy(result.policy);
  if (!Array.isArray(result.issues) || !Array.isArray(result.trace)) throw new Error("Semantic verification evidence must be arrays");
  validateSemanticState(result.initialState);
  validateSemanticState(result.finalState);
  validateSemanticComposition(result.composition, { maxDepth: result.policy.maxDepth });

  assertSha256(result.compositionDigest, "compositionDigest");
  const recomputedCompositionDigest = semanticCompositionDigest(result.composition);
  if (recomputedCompositionDigest !== result.compositionDigest) {
    throw new Error("Semantic verification composition digest mismatch");
  }

  const replay = executeSemanticComposition(result.composition, result.initialState, result.policy);
  const replayStatus: VerificationStatus = replay.accepted ? "VERIFIED" : "REJECTED";
  if (replayStatus !== result.status) throw new Error("Semantic verification status does not match deterministic replay");
  if (replay.state.digest !== result.finalState.digest) throw new Error("Semantic verification final state does not match deterministic replay");
  if (digestValue(replay.issues) !== digestValue(result.issues)) throw new Error("Semantic verification issues do not match deterministic replay");
  if (digestValue(replay.trace) !== digestValue(result.trace)) throw new Error("Semantic verification trace does not match deterministic replay");

  if (result.status === "VERIFIED" && result.issues.length !== 0) throw new Error("Verified semantic result cannot contain issues");
  if (result.status === "REJECTED" && result.issues.length === 0) throw new Error("Rejected semantic result requires at least one issue");
  for (const entry of result.trace) assertSha256(entry.stateDigest, "trace stateDigest");

  const certificate = result.certificate;
  if (!certificate || typeof certificate !== "object" || certificate.authority !== "NEXUS_COMPOSITIONAL_SEMANTICS_V1" || certificate.version !== 1) {
    throw new Error("Unsupported compositional-semantics certificate");
  }
  if (!certificate.planId.trim()) throw new Error("certificate planId cannot be empty");
  if (!certificate.subject.trim()) throw new Error("certificate subject cannot be empty");
  assertVerificationStatus(certificate.status);

  const rebuilt = createSemanticVerificationCertificate({
    planId: certificate.planId,
    subject: certificate.subject,
    compositionDigest: result.compositionDigest,
    initialStateDigest: result.initialState.digest,
    finalStateDigest: result.finalState.digest,
    status: result.status,
    policy: result.policy,
    issues: result.issues,
    trace: result.trace,
  });

  if (digestValue(rebuilt) !== digestValue(certificate)) {
    throw new Error("Semantic verification certificate linkage mismatch");
  }
}

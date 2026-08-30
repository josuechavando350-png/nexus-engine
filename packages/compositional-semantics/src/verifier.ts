import type { VerificationResult, VerifyCompositionInput } from "./types.js";
import { validateSemanticState } from "./state.js";
import {
  MAX_SEMANTIC_COMPOSITION_DEPTH,
  semanticCompositionDigest,
  validateSemanticComposition,
} from "./composition.js";
import { executeSemanticComposition } from "./execution.js";
import { createSemanticVerificationCertificate } from "./certificate.js";

export function verifyComposition(input: VerifyCompositionInput): VerificationResult {
  if (!input.planId.trim()) throw new Error("planId cannot be empty");
  if (!input.subject.trim()) throw new Error("subject cannot be empty");
  validateSemanticState(input.initialState);

  const policy = Object.freeze({
    maxDepth: input.maxDepth ?? MAX_SEMANTIC_COMPOSITION_DEPTH,
    failFast: input.failFast ?? false,
  });
  validateSemanticComposition(input.composition, { maxDepth: policy.maxDepth });
  const compositionDigest = semanticCompositionDigest(input.composition);
  const execution = executeSemanticComposition(input.composition, input.initialState, policy);
  const status = execution.accepted ? "VERIFIED" as const : "REJECTED" as const;
  const certificate = createSemanticVerificationCertificate({
    planId: input.planId,
    subject: input.subject,
    compositionDigest,
    initialStateDigest: input.initialState.digest,
    finalStateDigest: execution.state.digest,
    status,
    policy,
    issues: execution.issues,
    trace: execution.trace,
  });

  return Object.freeze({
    status,
    policy,
    composition: input.composition,
    compositionDigest,
    initialState: input.initialState,
    finalState: execution.state,
    issues: execution.issues,
    trace: execution.trace,
    certificate,
  });
}

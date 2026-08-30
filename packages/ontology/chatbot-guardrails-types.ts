import type { GroundedFact, GroundingContext, KnowledgeClaimClass, KnowledgeEvidenceKind } from "./chatbot-knowledge-types.js";

export type GuardrailRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type GuardrailDisposition = "ALLOW" | "QUALIFY" | "ESCALATE";
export type GuardrailCopyKind = "CONNECTOR" | "QUESTION" | "ESCALATION" | "CLOSING";

export interface ClaimGuardrailPolicy {
  readonly claimClass: KnowledgeClaimClass;
  readonly risk: GuardrailRisk;
  readonly minimumConfidence: number;
  readonly minimumEvidenceCount: number;
  readonly allowedEvidenceKinds: readonly KnowledgeEvidenceKind[];
  readonly requiredAnyEvidenceKinds?: readonly KnowledgeEvidenceKind[];
  readonly requiredAllEvidenceKinds?: readonly KnowledgeEvidenceKind[];
  readonly allowPartialSupport: boolean;
  readonly requireSourceDigest: boolean;
  readonly maxEvidenceAgeMs?: number;
}

export interface ApprovedCopy {
  readonly id: string;
  readonly locale: string;
  readonly kind: GuardrailCopyKind;
  readonly text: string;
  readonly allowedStatuses: readonly GroundingContext["status"][];
}

export interface ApprovedFactTemplate {
  readonly id: string;
  readonly locale: string;
  readonly claimClass: KnowledgeClaimClass;
  readonly text: string;
  readonly qualified: boolean;
  readonly predicates?: readonly string[];
}

export interface FormalGuardrailPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly locale: string;
  readonly maxSegments: number;
  readonly maxResponseChars: number;
  readonly allowHistoricalGrounding: boolean;
  readonly claimPolicies: Readonly<Record<KnowledgeClaimClass, ClaimGuardrailPolicy>>;
  readonly copy: readonly ApprovedCopy[];
  readonly templates: readonly ApprovedFactTemplate[];
  readonly digest: string;
}

export type GuardrailFactRejectionReason =
  | "GROUNDING_CONFLICT"
  | "GROUNDING_UNSUPPORTED"
  | "LOW_CONFIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "UNAPPROVED_EVIDENCE_KIND"
  | "MISSING_REQUIRED_ANY_EVIDENCE_KIND"
  | "MISSING_REQUIRED_ALL_EVIDENCE_KIND"
  | "MISSING_SOURCE_DIGEST"
  | "STALE_EVIDENCE"
  | "FUTURE_EVIDENCE"
  | "FACT_NOT_YET_VALID"
  | "FACT_EXPIRED"
  | "PARTIAL_SUPPORT_NOT_ALLOWED"
  | "INTEGRITY_FAILURE";

export interface GuardrailFactDecision {
  readonly factId: string;
  readonly claimClass: KnowledgeClaimClass;
  readonly risk: GuardrailRisk;
  readonly disposition: "ALLOW" | "QUALIFY" | "REJECT";
  readonly reasons: readonly GuardrailFactRejectionReason[];
  readonly digest: string;
}

export interface GuardrailEnvelope {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly groundingDigest: string;
  readonly requestDigest: string;
  readonly requestedClaimClasses: readonly KnowledgeClaimClass[];
  readonly groundingStatus: GroundingContext["status"];
  readonly disposition: GuardrailDisposition;
  readonly allowedFactIds: readonly string[];
  readonly qualifiedFactIds: readonly string[];
  readonly rejectedFacts: readonly GuardrailFactDecision[];
  readonly facts: readonly GroundedFact[];
  readonly requiredEscalation: boolean;
  readonly suppressFacts: boolean;
  readonly createdAt: string;
  readonly digest: string;
}

export type GuardrailResponseSegment =
  | { readonly kind: "FACT"; readonly factId: string; readonly templateId: string }
  | { readonly kind: "COPY"; readonly copyId: string };

export interface GuardrailResponsePlan {
  readonly planId: string;
  readonly segments: readonly GuardrailResponseSegment[];
}

export interface GuardedGenerationContext {
  readonly grounding: GroundingContext;
  readonly envelope: GuardrailEnvelope;
  readonly digest: string;
}

export interface RenderedGuardrailResponse {
  readonly planId: string;
  readonly policyDigest: string;
  readonly groundingDigest: string;
  readonly envelopeDigest: string;
  readonly text: string;
  readonly usedFactIds: readonly string[];
  readonly usedCopyIds: readonly string[];
  readonly renderedAt: string;
  readonly digest: string;
}

export class GuardrailError extends Error {
  constructor(
    public readonly code:
      | "INVALID_POLICY"
      | "INVALID_INPUT"
      | "INTEGRITY_FAILURE"
      | "FACT_NOT_ALLOWED"
      | "TEMPLATE_NOT_ALLOWED"
      | "COPY_NOT_ALLOWED"
      | "ESCALATION_REQUIRED"
      | "OUTPUT_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}

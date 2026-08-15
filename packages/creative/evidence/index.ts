import { assertCanonicalId, assertNonEmpty, assertScope, canonicalTimestamp, lexicalCompare, type CreativeScope } from "../shared";

export type CreativeEvidenceKind =
  | "ASSET_RESOLUTION"
  | "FALLBACK_SELECTION"
  | "DIGEST_FAILURE"
  | "USAGE_REJECTION"
  | "MEMORY_RETRIEVAL"
  | "MEMORY_STALE_OR_SUPERSEDED"
  | "SCOPE_REJECTION"
  | "BACKEND_FAILURE"
  | "DETERMINISTIC_INPUTS";

export type CreativeEvidence = Readonly<{
  evidenceId: string;
  kind: CreativeEvidenceKind;
  occurredAt: string;
  correlationId: string;
  scope: CreativeScope;
  subjectId: string;
  inputsDigest: string;
  details: Readonly<Record<string, string | number | boolean>>;
  deliveryStatus: "PENDING" | "DELIVERED" | "FAILED";
}>;

export interface CreativeEvidenceSink {
  append(evidence: CreativeEvidence): void | Promise<void>;
}

export class NullCreativeEvidenceSink implements CreativeEvidenceSink {
  append(): void {}
}

function stableDetails(details: CreativeEvidence["details"]): string {
  return Object.entries(details)
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function evidenceId(input: {
  kind: CreativeEvidenceKind;
  correlationId: string;
  subjectId: string;
  inputsDigest: string;
  occurredAt: string;
  scope: CreativeScope;
  details: CreativeEvidence["details"];
}): string {
  const values = [
    input.kind,
    input.scope.tenantId,
    input.scope.brandId,
    input.occurredAt,
    input.correlationId,
    input.subjectId,
    input.inputsDigest,
    stableDetails(input.details)
  ];
  return `creative:${values.map((value) => `${value.length}:${value}`).join("|")}`;
}

export function createEvidence(input: Omit<CreativeEvidence, "evidenceId" | "deliveryStatus">): CreativeEvidence {
  assertScope(input.scope);
  assertCanonicalId(input.correlationId, "correlationId");
  assertNonEmpty(input.subjectId, "subjectId");
  assertNonEmpty(input.inputsDigest, "inputsDigest");
  canonicalTimestamp(input.occurredAt, "occurredAt");
  return Object.freeze({
    ...input,
    evidenceId: evidenceId(input),
    details: Object.freeze({ ...input.details }),
    deliveryStatus: "PENDING"
  });
}

/** Evidence delivery is best-effort. Sink failure is visible but never replaces a typed domain result/error. */
export async function deliverEvidence(sink: CreativeEvidenceSink, evidence: CreativeEvidence): Promise<CreativeEvidence> {
  try {
    await sink.append(evidence);
    return Object.freeze({ ...evidence, deliveryStatus: "DELIVERED" });
  } catch {
    return Object.freeze({ ...evidence, deliveryStatus: "FAILED" });
  }
}

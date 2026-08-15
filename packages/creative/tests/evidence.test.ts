import { describe, expect, it } from "vitest";
import { createEvidence, deliverEvidence, evidenceId } from "../evidence";
import { InMemoryEvidenceSink } from "../testing";

const base = {
  kind: "MEMORY_RETRIEVAL" as const,
  occurredAt: "2026-08-15T00:00:00.000Z",
  correlationId: "corr-1",
  scope: { tenantId: "tenant-a", brandId: "brand-a" },
  subjectId: "homepage",
  inputsDigest: "inputs-1",
  details: { resultCount: 2, authority: "EVIDENCE_ONLY" }
};

describe("creative evidence", () => {
  it("derives stable IDs independent of detail insertion order", () => {
    const left = evidenceId(base);
    const right = evidenceId({ ...base, details: { authority: "EVIDENCE_ONLY", resultCount: 2 } });
    expect(left).toBe(right);
  });

  it("includes scope, timestamp, and semantic details in identity", () => {
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, scope: { tenantId: "tenant-b", brandId: "brand-a" } }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, occurredAt: "2026-08-15T00:00:01.000Z" }));
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, details: { resultCount: 3, authority: "EVIDENCE_ONLY" } }));
  });

  it("rejects non-canonical timestamps", () => {
    expect(() => createEvidence({ ...base, occurredAt: "2026-08-15" })).toThrow();
  });

  it("marks successful evidence delivery", async () => {
    const sink = new InMemoryEvidenceSink();
    const delivered = await deliverEvidence(sink, createEvidence(base));
    expect(delivered.deliveryStatus).toBe("DELIVERED");
    expect(sink.events).toHaveLength(1);
  });

  it("marks sink failure without throwing over the domain result", async () => {
    const sink = new InMemoryEvidenceSink();
    sink.fail = true;
    const delivered = await deliverEvidence(sink, createEvidence(base));
    expect(delivered.deliveryStatus).toBe("FAILED");
  });
});

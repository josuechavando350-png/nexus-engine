import { describe, expect, it } from "vitest";
import { DeterministicArtDirectionEngine, DirectionError, type CreativeBrief, type DirectionCandidate, type DirectionConfig } from "../direction";
import type { RankedMemory } from "../memory";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const brief: CreativeBrief = Object.freeze({ briefId: "brief-1", scope, subjectId: "subject-1", objective: "premium editorial launch", keywords: Object.freeze(["premium", "editorial"]), constraints: Object.freeze(["accessible"]) });
const config: DirectionConfig = Object.freeze({ weights: Object.freeze({ BRIEF: 0.35, BRAND: 0.15, MEMORY: 0.25, CONSTRAINTS: 0.25 }), minimumCandidateConfidence: 0.5, rejectConflictedEvidence: false });
const candidates: readonly DirectionCandidate[] = Object.freeze([
  Object.freeze({ directionId: "direction-a", label: "Editorial", keywords: Object.freeze(["editorial", "premium"]), brandSignals: Object.freeze(["premium"]), satisfiesConstraints: Object.freeze(["accessible"]), confidence: 0.9 }),
  Object.freeze({ directionId: "direction-b", label: "Minimal", keywords: Object.freeze(["minimal"]), brandSignals: Object.freeze(["quiet"]), satisfiesConstraints: Object.freeze(["accessible"]), confidence: 0.9 })
]);

function memory(directionId: string, recordId = "memory-1", overrides: Partial<RankedMemory> = {}): RankedMemory {
  return {
    record: {
      schemaVersion: 1, recordId, scope, subjectId: "subject-1", createdAt: "2026-01-01T00:00:00Z", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z", confidence: 0.8, keywords: ["editorial"], provenance: { sourceId: "source-1", sourceType: "HUMAN", capturedAt: "2026-01-01T00:00:00Z", evidenceIds: ["evidence-1"] }, payload: { kind: "DECISION", directionId, rationale: "worked previously" }
    }, score: 0.8, stale: false, superseded: false, conflicts: [], ...overrides
  };
}

const engine = new DeterministicArtDirectionEngine();

describe("DeterministicArtDirectionEngine", () => {
  it("returns a recommendation without claiming final authority", () => {
    const result = engine.propose({ brief, candidates, memory: [memory("direction-a")], config });
    expect(result.authority).toBe("PROPOSED_DIRECTION");
    expect(result.mayFinalizeDirection).toBe(false);
    expect(result.recommendedDirectionId).toBe("direction-a");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.evaluations[0]?.evidenceIds).toEqual(["evidence-1"]);
  });

  it("is invariant to candidate and memory ordering", () => {
    const memories = [memory("direction-a", "memory-a"), memory("direction-b", "memory-b")];
    const first = engine.propose({ brief, candidates, memory: memories, config });
    const second = engine.propose({ brief, candidates: [...candidates].reverse(), memory: [...memories].reverse(), config });
    expect(second).toEqual(first);
  });

  it("uses lexical direction ID as deterministic tie break", () => {
    const equal = candidates.map((candidate) => ({ ...candidate, keywords: ["editorial"], brandSignals: ["premium"], confidence: 0.9 }));
    const result = engine.propose({ brief, candidates: equal, memory: [], config });
    expect(result.recommendedDirectionId).toBe("direction-a");
  });

  it("rejects invalid weights and confidence", () => {
    expect(() => engine.propose({ brief, candidates, memory: [], config: { ...config, weights: { ...config.weights, BRIEF: 0.9 } } })).toThrowError(DirectionError);
    expect(() => engine.propose({ brief, candidates: [{ ...candidates[0]!, confidence: Number.NaN }], memory: [], config })).toThrowError(DirectionError);
  });

  it("rejects cross-tenant and cross-brand memory", () => {
    const crossTenant = memory("direction-a");
    const tenantRecord = { ...crossTenant.record, scope: { tenantId: "tenant-b", brandId: "brand-a" } };
    expect(() => engine.propose({ brief, candidates, memory: [{ ...crossTenant, record: tenantRecord }], config })).toThrowError(DirectionError);
    const brandRecord = { ...crossTenant.record, scope: { tenantId: "tenant-a", brandId: "brand-b" } };
    expect(() => engine.propose({ brief, candidates, memory: [{ ...crossTenant, record: brandRecord }], config })).toThrowError(DirectionError);
  });

  it("does not let stale or superseded memory influence scoring", () => {
    const baseline = engine.propose({ brief, candidates, memory: [], config });
    const stale = engine.propose({ brief, candidates, memory: [memory("direction-b", "stale", { stale: true })], config });
    const superseded = engine.propose({ brief, candidates, memory: [memory("direction-b", "old", { superseded: true })], config });
    expect(stale).toEqual(baseline);
    expect(superseded).toEqual(baseline);
  });

  it("surfaces conflicts and can reject wholly conflicted evidence", () => {
    const conflicted = memory("direction-a", "conflicted", { conflicts: ["memory-2"] });
    const result = engine.propose({ brief, candidates, memory: [conflicted], config });
    expect(result.conflicts).toEqual(["memory-2"]);
    expect(() => engine.propose({ brief, candidates, memory: [conflicted], config: { ...config, rejectConflictedEvidence: true } })).toThrowError(DirectionError);
  });

  it("rejects candidates that fail constraints and reports no valid candidates", () => {
    const invalid = candidates.map((candidate) => ({ ...candidate, satisfiesConstraints: [] }));
    expect(() => engine.propose({ brief, candidates: invalid, memory: [], config })).toThrowError(DirectionError);
  });

  it("produces an auditable deterministic trace", () => {
    const result = engine.propose({ brief, candidates, memory: [memory("direction-a")], config });
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]?.rank).toBe(1);
    expect(result.trace[0]?.reason).toBe("highest-deterministic-score");
    expect(result.evaluations.every((entry) => Number.isFinite(entry.score))).toBe(true);
  });
});

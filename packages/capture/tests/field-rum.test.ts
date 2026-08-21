import { describe, expect, it } from "vitest";
import { aggregateFieldRum, type FieldVitalSample } from "../field-rum";

const SHA = "a".repeat(40);
const sample = (metric: "LCP" | "INP" | "CLS", value: number, rating: "GOOD" | "NEEDS_IMPROVEMENT" | "POOR", observedAt = "2026-08-20T12:00:00.000Z"): FieldVitalSample => ({
  schemaVersion: 1,
  projectId: "fixture",
  buildRevision: SHA,
  observedAt,
  metric,
  value,
  rating,
  viewport: { width: 390, height: 844 },
  attribution: { navigationType: "navigate", targetSelectorHash: "sha256:fixture" },
});

describe("field RUM", () => {
  it("reports NOT_TESTED when no field samples exist", () => {
    const evidence = aggregateFieldRum({ projectId: "fixture", buildRevision: SHA, windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-31T23:59:59.999Z", samples: [] });
    expect(evidence.status).toBe("NOT_TESTED");
    expect(evidence.aggregates).toEqual([]);
  });

  it("computes deterministic p75 aggregates for measured samples", () => {
    const evidence = aggregateFieldRum({
      projectId: "fixture",
      buildRevision: SHA,
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-31T23:59:59.999Z",
      samples: [sample("LCP", 1200, "GOOD"), sample("LCP", 1800, "GOOD"), sample("LCP", 2400, "NEEDS_IMPROVEMENT"), sample("LCP", 3200, "POOR")],
    });
    expect(evidence.status).toBe("MEASURED");
    expect(evidence.aggregates[0]).toMatchObject({ metric: "LCP", sampleCount: 4, p75: 2400, goodRatio: 0.5, needsImprovementRatio: 0.25, poorRatio: 0.25 });
  });

  it("rejects samples from another build", () => {
    const bad = { ...sample("INP", 100, "GOOD"), buildRevision: "b".repeat(40) };
    expect(() => aggregateFieldRum({ projectId: "fixture", buildRevision: SHA, windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-31T23:59:59.999Z", samples: [bad] })).toThrow(/scope/);
  });
});

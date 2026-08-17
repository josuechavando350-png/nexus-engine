import { describe, expect, it } from "vitest";
import { brief, capabilities, fingerprint, originalityReport, plan, recipe } from "./experience";

describe("LA PAUSE NEXUS Experience", () => {
  it("executes the real @nexus/experience compiler with no unresolved placements", () => {
    expect(plan.version).toBe(2);
    expect(plan.briefId).toBe(brief.id);
    expect(plan.recipeId).toBe(recipe.id);
    expect(plan.capabilityPlacements).toHaveLength(capabilities.length);
    expect(plan.unresolvedDecisions).toEqual([]);
  });

  it("preserves the compiled strategies required before implementation", () => {
    expect(plan.narrativeSequence.map((stage) => stage.stageId)).toEqual(["arrival", "chapters", "conversion"]);
    expect(plan.mediaStrategy.dominance).toBeGreaterThan(0.5);
    expect(plan.mediaStrategy.reducedCostFallbackRequired).toBe(true);
    expect(plan.interactionStrategy.directness).toBeGreaterThan(0.8);
    expect(plan.responsiveStrategy.preserveSemanticOrder).toBe(true);
    expect(plan.responsiveStrategy.preserveIdentityAcrossViewports).toBe(true);
    expect(plan.motionStrategy.reducedMotionFallbackRequired).toBe(true);
    expect(plan.constraints.length).toBeGreaterThanOrEqual(4);
    expect(plan.originalitySeed.stageSequence).toEqual(["arrival", "chapters", "conversion"]);
  });

  it("keeps the implemented StyleFingerprint structurally distinct from the generic restaurant stack", () => {
    expect(fingerprint.structure.cardReliance).toBeLessThan(0.1);
    expect(fingerprint.openingSignature).toContain("table-runner");
    expect(originalityReport.overall).toBeLessThan(0.62);
    expect(originalityReport.warnings).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { evaluateExcessRemoval } from "../excess-removal";

describe("evaluateExcessRemoval", () => {
  it("returns NOT_TESTED when no candidates were evaluated", () => {
    expect(evaluateExcessRemoval([]).verdict).toBe("NOT_TESTED");
  });

  it("fails unexplained decoration instead of rewarding visual excess", () => {
    const report = evaluateExcessRemoval([{ elementId: "floating-orb", purposes: [], rationale: "" }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("MISSING_PURPOSE");
  });

  it("does not accept declared purpose without a removal experiment", () => {
    const report = evaluateExcessRemoval([{ elementId: "hero-grid", purposes: ["HIERARCHY"], rationale: "Establishes primary visual hierarchy" }]);
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.findings[0]?.code).toBe("REMOVAL_NOT_TESTED");
  });

  it("fails an element when removal causes no material loss", () => {
    const report = evaluateExcessRemoval([{
      elementId: "decorative-sparkles",
      purposes: ["IDENTITY"],
      rationale: "Claimed brand signature",
      observation: { outcome: "NO_MATERIAL_LOSS", evidenceIds: ["shot:before", "shot:after"], notes: "Hierarchy, comprehension and identity remained unchanged." },
    }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("EXCESS_CONFIRMED");
  });

  it("passes only when removal evidence demonstrates meaningful loss or breakage", () => {
    const report = evaluateExcessRemoval([{
      elementId: "espresso-extraction-timeline",
      purposes: ["IDENTITY", "COMPREHENSION"],
      rationale: "Makes the café ritual legible and project-specific",
      observation: { outcome: "MEANINGFUL_LOSS", evidenceIds: ["genome:before", "review:after-removal"], notes: "Removal erased the serving-ritual narrative and category-specific interaction." },
    }]);
    expect(report.verdict).toBe("PASS");
    expect(report.findings[0]?.code).toBe("PURPOSE_SUPPORTED");
  });
});

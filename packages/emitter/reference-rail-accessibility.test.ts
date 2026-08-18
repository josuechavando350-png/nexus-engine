import { describe, expect, it } from "vitest";
import type { ReferencePresentationPlan } from "./reference-presentation";
import { augmentReferenceRailAccessibility } from "./reference-rail-accessibility";

const plan = Object.freeze({
  authority: "NEXUS_REFERENCE_PRESENTATION_V1", referenceId: "ref",
  rail: Object.freeze({ mode: "FOCUS_RAIL", activeItemViewportRatio: .607, adjacentPeek: true, labelPlacement: "BELOW", controls: "NONE", counter: false, interaction: "SCROLL_SNAP_SWIPE", evidenceIds: Object.freeze(["ref:mobile"]) }),
  heroMotion: Object.freeze({ enabled: true, primitive: "TRACE_GLINT", durationMs: 1150, reducedMotionFallback: true, evidenceIds: Object.freeze(["user:motion"]) }),
  freezePolicy: Object.freeze({ preserveUnlistedSurfaces: true }),
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
}) as ReferencePresentationPlan;

describe("reference rail accessibility", () => {
  it("adds focusability and region semantics without adding controls", () => {
    const source = `<div className="nexusReferenceRail" aria-label="Tecnología">{items}</div>`;
    const result = augmentReferenceRailAccessibility({ jsx: source, plan, evidenceIds: ["requirement:keyboard-scroll"] });
    expect(result.jsx).toContain('role="region"');
    expect(result.jsx).toContain('tabIndex={0}');
    expect(result.jsx).not.toMatch(/button|prev|next|arrow/i);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed if the generated rail root is missing", () => {
    expect(() => augmentReferenceRailAccessibility({ jsx: `<div />`, plan, evidenceIds: ["requirement:keyboard-scroll"] })).toThrow(/could not find/);
  });
});

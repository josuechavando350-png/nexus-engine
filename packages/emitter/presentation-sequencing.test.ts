import { describe, expect, it } from "vitest";
import { sequenceReferencePresentationAfterOverlay } from "./presentation-sequencing";
import type { ReferencePresentationPlan } from "./reference-presentation";

const plan = Object.freeze({
  authority: "NEXUS_REFERENCE_PRESENTATION_V1" as const,
  referenceId: "fixture",
  rail: Object.freeze({
    mode: "FOCUS_RAIL" as const,
    activeItemViewportRatio: 0.607,
    adjacentPeek: true as const,
    labelPlacement: "BELOW" as const,
    controls: "NONE" as const,
    counter: false,
    interaction: "SCROLL_SNAP_SWIPE" as const,
    evidenceIds: Object.freeze(["ref"]),
  }),
  heroMotion: Object.freeze({
    enabled: true,
    primitive: "TRACE_GLINT" as const,
    durationMs: 1150,
    reducedMotionFallback: true as const,
    evidenceIds: Object.freeze(["hero"]),
  }),
  freezePolicy: Object.freeze({ preserveUnlistedSurfaces: true }),
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
}) satisfies ReferencePresentationPlan;

describe("presentation sequencing", () => {
  it("defers hero motion until the evidence-bound splash duration has elapsed", () => {
    const output = sequenceReferencePresentationAfterOverlay({ plan, overlayDurationMs: 1200 });
    expect(output.css).toContain(".nexusBrandMotionLogo{animation-delay:1200ms}");
    expect(output.css).toContain(".nexusBrandMotionGlint{animation-delay:1407ms}");
    expect(output.css).toContain(".nexusBrandMotionTagline{animation-delay:1568ms}");
    expect(output.css).toContain("prefers-reduced-motion:reduce");
    expect(output.overlayDurationMs).toBe(1200);
  });

  it("rejects invented or nonsensical overlay timing", () => {
    expect(() => sequenceReferencePresentationAfterOverlay({ plan, overlayDurationMs: -1 })).toThrow(/overlayDurationMs/);
    expect(() => sequenceReferencePresentationAfterOverlay({ plan, overlayDurationMs: 5001 })).toThrow(/overlayDurationMs/);
    expect(() => sequenceReferencePresentationAfterOverlay({ plan, overlayDurationMs: 1200.5 })).toThrow(/overlayDurationMs/);
  });
});

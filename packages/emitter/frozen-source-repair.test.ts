import { describe, expect, it } from "vitest";
import type { ReferencePresentationPlan } from "./reference-presentation";
import { applyFrozenReferenceSourceRepair } from "./frozen-source-repair";

const plan = Object.freeze({
  authority: "NEXUS_REFERENCE_PRESENTATION_V1",
  referenceId: "reference",
  rail: Object.freeze({ mode: "FOCUS_RAIL", activeItemViewportRatio: 0.607, adjacentPeek: true, labelPlacement: "BELOW", controls: "NONE", counter: false, interaction: "SCROLL_SNAP_SWIPE", evidenceIds: Object.freeze(["ref:technology"]) }),
  heroMotion: Object.freeze({ enabled: true, primitive: "TRACE_GLINT", durationMs: 1150, reducedMotionFallback: true, evidenceIds: Object.freeze(["user:hero-logo-motion"]) }),
  freezePolicy: Object.freeze({ preserveUnlistedSurfaces: true }),
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
}) as ReferencePresentationPlan;

describe("frozen reference source repair", () => {
  it("removes forbidden ordinal markup without altering surrounding source", () => {
    const before = `<article><span className="service-index">0{index + 1}</span><div><h3>{service.name}</h3></div></article>`;
    const result = applyFrozenReferenceSourceRepair({ source: before, plan, evidenceIds: ["user:no-service-ordinals"] });
    expect(result.source).toBe(`<article><div><h3>{service.name}</h3></div></article>`);
    expect(result.mutationCount).toBe(1);
    expect(result.source).not.toContain("service-index");
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed when the requested frozen mutation is not present", () => {
    expect(() => applyFrozenReferenceSourceRepair({ source: `<article><h3>Servicio</h3></article>`, plan, evidenceIds: ["user:no-service-ordinals"] })).toThrow(/no authorized source mutation/);
  });

  it("fails closed if unlisted surfaces are not frozen", () => {
    const unfrozen = { ...plan, freezePolicy: Object.freeze({ preserveUnlistedSurfaces: false }) } as ReferencePresentationPlan;
    expect(() => applyFrozenReferenceSourceRepair({ source: `<span className="service-index">01</span>`, plan: unfrozen, evidenceIds: ["user:no-service-ordinals"] })).toThrow(/preserve unlisted surfaces/);
  });
});

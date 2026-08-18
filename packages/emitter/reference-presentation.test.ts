import { describe, expect, it } from "vitest";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "@nexus/experience/dna";
import { deriveReferencePresentationPlan, emitReferencePresentationCss, renderHeroBrandMotionJsx, renderTechnologyRailJsx } from "./reference-presentation";

function dna(): ExperienceDNA {
  const because = "Evidence-bound fixture for reference presentation tests.";
  return defineExperienceDNA({
    version: 2,
    subject: "reference-fixture",
    principles: ["Reference evidence controls the requested surface"],
    artDirectionVocabulary: ["reference", "focus", "motion"],
    composition: { asymmetry: intent(0.55, because), gridDiscipline: intent(0.72, because), overlap: intent(0.3, because), continuity: intent(0.68, because), dominantFlow: direction("measured progression", because) },
    density: { information: intent(0.45, because), whitespace: intent(0.72, because), compression: intent(0.35, because) },
    geometry: { angularity: intent(0.42, because), regularity: intent(0.74, because), boundaryVisibility: intent(0.34, because), dominantShape: direction("restrained geometry", because) },
    typography: { scaleContrast: intent(0.7, because), hierarchyRigidity: intent(0.66, because), expressiveType: intent(0.68, because), voice: direction("controlled editorial", because) },
    media: { dominance: intent(0.82, because), continuity: intent(0.75, because), documentaryVsAbstract: intent(0.9, because), role: direction("documentary evidence carrier", because) },
    navigation: { persistence: intent(0.55, because), visibility: intent(0.75, because), topology: direction("direct hierarchical", because) },
    interaction: { discoverability: intent(0.75, because), directness: intent(0.7, because), spatiality: intent(0.68, because), language: direction("guided spatial response", because) },
    cta: { prominence: intent(0.62, because), repetition: intent(0.35, because), grammar: direction("explicit action", because) },
    motion: { intensity: intent(0.58, because), continuity: intent(0.78, because), choreography: direction("continuous guided transitions", because) },
    editoriality: intent(0.72, because),
    cinematicity: intent(0.72, because),
    ornamentation: intent(0.35, because),
  });
}

const observations = [
  {
    id: "ref:aventura:technology-mobile",
    sourceId: "reference:https://aventuradentalarts.com/",
    surface: "TECHNOLOGY_SEQUENCE" as const,
    horizontalSequence: true,
    centeredFocus: true,
    adjacentPeek: true,
    labelPlacement: "BELOW" as const,
    activeItemViewportRatio: 0.607,
    arrowControlsObserved: true,
    counterObserved: true,
  },
  {
    id: "user:hero-logo-motion",
    sourceId: "user:hero-logo-motion",
    surface: "HERO_BRAND" as const,
  },
] as const;

describe("reference-bound presentation", () => {
  it("derives a focus rail from evidence and honors explicit no-arrows/no-ordinals overrides", () => {
    const plan = deriveReferencePresentationPlan({
      referenceId: "aventura-technology",
      dna: dna(),
      observations,
      userOverrides: {
        arrowControls: "FORBID",
        ordinalLabels: "FORBID",
        preserveUnlistedSurfaces: true,
        requireHeroLogoMotion: true,
        heroMotionEvidenceIds: ["user:hero-logo-motion"],
      },
    });

    expect(plan.rail.mode).toBe("FOCUS_RAIL");
    expect(plan.rail.activeItemViewportRatio).toBe(0.607);
    expect(plan.rail.controls).toBe("NONE");
    expect(plan.rail.counter).toBe(false);
    expect(plan.rail.evidenceIds).toContain("ref:aventura:technology-mobile");
    expect(plan.freezePolicy.preserveUnlistedSurfaces).toBe(true);
    expect(plan.heroMotion.enabled).toBe(true);
    expect(plan.heroMotion.reducedMotionFallback).toBe(true);
  });

  it("emits swipe/scroll-snap focus-rail mechanics without arrow UI and hides forbidden service ordinals", () => {
    const fixtureDna = dna();
    const plan = deriveReferencePresentationPlan({
      referenceId: "aventura-technology",
      dna: fixtureDna,
      observations,
      userOverrides: { arrowControls: "FORBID", ordinalLabels: "FORBID", requireHeroLogoMotion: true },
    });
    const emitted = emitReferencePresentationCss(plan, fixtureDna);
    expect(emitted.css).toContain("scroll-snap-type:x mandatory");
    expect(emitted.css).toContain("scroll-snap-align:center");
    expect(emitted.css).toContain(".service-index{display:none!important}");
    expect(emitted.css).toContain("prefers-reduced-motion");
    expect(emitted.css).not.toMatch(/\b(prev|next|arrow)\b/i);
  });

  it("emits hero-logo and technology source fragments without manual arrow controls or counters", () => {
    const hero = renderHeroBrandMotionJsx({ logoSrc: "/media/zona-dental-logo-reference.png", alt: "Zona Dental Polanco", tagline: "Odontología avanzada restauradora" });
    const rail = renderTechnologyRailJsx();
    expect(hero).toContain("nexusBrandMotionLogo");
    expect(hero).toContain("zona-dental-logo-reference.png");
    expect(rail).toContain("nexusReferenceRail");
    expect(rail).not.toMatch(/prev|next|arrow|counter/i);
  });

  it("fails closed when the reference lacks the evidence needed for a focus rail", () => {
    expect(() => deriveReferencePresentationPlan({
      referenceId: "weak-reference",
      dna: dna(),
      observations: [{ id: "weak", sourceId: "weak", surface: "TECHNOLOGY_SEQUENCE", horizontalSequence: true }],
      userOverrides: { arrowControls: "FORBID" },
    })).toThrow(/INSUFFICIENT_REFERENCE_EVIDENCE/);
  });
});

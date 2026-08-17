import { describe, expect, it } from "vitest";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "../dna";
import { deriveDnaContentConstraints, toContentReadinessPolicy } from "../content-constraints";

function dna(overrides: { mediaDominance?: number; documentary?: number; cinematicity?: number; ctaRepetition?: number; editoriality?: number } = {}): ExperienceDNA {
  const because = "Project-specific evidence requires this intent.";
  return defineExperienceDNA({
    version: 2,
    subject: "specialty-coffee-flagship",
    principles: ["The real service ritual controls the experience"],
    artDirectionVocabulary: ["editorial", "documentary"],
    composition: { asymmetry: intent(0.7, because), gridDiscipline: intent(0.45, because), overlap: intent(0.6, because), continuity: intent(0.8, because), dominantFlow: direction("vertical narrative", because) },
    density: { information: intent(0.5, because), whitespace: intent(0.7, because), compression: intent(0.25, because) },
    geometry: { angularity: intent(0.5, because), regularity: intent(0.35, because), boundaryVisibility: intent(0.4, because), dominantShape: direction("editorial crop", because) },
    typography: { scaleContrast: intent(0.85, because), hierarchyRigidity: intent(0.55, because), expressiveType: intent(0.75, because), voice: direction("editorial contrast", because) },
    media: { dominance: intent(overrides.mediaDominance ?? 0.8, because), continuity: intent(0.72, because), documentaryVsAbstract: intent(overrides.documentary ?? 0.7, because), role: direction("evidence", because) },
    navigation: { persistence: intent(0.4, because), visibility: intent(0.7, because), topology: direction("contextual", because) },
    interaction: { discoverability: intent(0.7, because), directness: intent(0.7, because), spatiality: intent(0.6, because), language: direction("direct response", because) },
    cta: { prominence: intent(0.6, because), repetition: intent(overrides.ctaRepetition ?? 0.2, because), grammar: direction("single decisive action", because) },
    motion: { intensity: intent(0.65, because), continuity: intent(0.8, because), choreography: direction("continuous reveal", because) },
    editoriality: intent(overrides.editoriality ?? 0.8, because),
    cinematicity: intent(overrides.cinematicity ?? 0.8, because),
    ornamentation: intent(0.3, because),
  });
}

describe("DNA-derived content constraints", () => {
  it("requires business-specific copy and real media roles from the DNA instead of a generic content checklist", () => {
    const result = deriveDnaContentConstraints(dna(), {
      businessType: "specialty coffee bar",
      goals: ["VISIT", "TRUST"],
      differentiators: ["single-origin roasting", "barista-led tasting ritual"],
    });

    expect(result.authority).toBe("NEXUS_DNA_CONTENT_CONSTRAINTS_V1");
    expect(result.requiredCopyRoles).toEqual(expect.arrayContaining([
      "headline", "value-proposition", "primary-cta", "proof", "location-and-hours", "credentials-and-proof", "differentiators",
    ]));
    expect(result.requiredPhotoRoles).toEqual(expect.arrayContaining(["hero-media", "proof-media", "documentary-context", "cinematic-sequence"]));
    expect(result.maximumPrimaryCtaOccurrences).toBe(1);
    expect(result.minimumProofItems).toBe(2);
    expect(result.constraints.every((constraint) => constraint.because.trim().length > 0)).toBe(true);
  });

  it("does not invent media requirements when the DNA explicitly makes media secondary", () => {
    const result = deriveDnaContentConstraints(dna({ mediaDominance: 0.2, documentary: 0.2, cinematicity: 0.2, editoriality: 0.2, ctaRepetition: 0.8 }), {
      businessType: "B2B consultancy",
      goals: ["INQUIRE"],
      differentiators: [],
    });

    expect(result.requiredPhotoRoles).toEqual([]);
    expect(result.requiredCopyRoles).toContain("qualification-and-contact");
    expect(result.maximumPrimaryCtaOccurrences).toBe(3);
    expect(result.minimumProofItems).toBe(1);
  });

  it("converts constraints into readiness policy while keeping image thresholds caller-controlled", () => {
    const constraints = deriveDnaContentConstraints(dna(), { businessType: "restaurant", goals: ["BOOK"], differentiators: ["wood-fired menu"] });
    const policy = toContentReadinessPolicy(constraints, { widthPx: 1600, heightPx: 1000 });

    expect(policy.requiredCopyRoles).toEqual(constraints.requiredCopyRoles);
    expect(policy.requiredPhotoRoles).toEqual(constraints.requiredPhotoRoles);
    expect(policy.minimumPhotoWidthPx).toBe(1600);
    expect(policy.minimumPhotoHeightPx).toBe(1000);
  });

  it("fails closed on ambiguous business profiles and invalid readiness thresholds", () => {
    expect(() => deriveDnaContentConstraints(dna(), { businessType: "", goals: ["BUY"], differentiators: [] })).toThrow(/businessType/);
    expect(() => deriveDnaContentConstraints(dna(), { businessType: "shop", goals: [], differentiators: [] })).toThrow(/business goal/);
    const constraints = deriveDnaContentConstraints(dna(), { businessType: "shop", goals: ["BUY"], differentiators: [] });
    expect(() => toContentReadinessPolicy(constraints, { widthPx: 0 })).toThrow(/widthPx/);
  });
});

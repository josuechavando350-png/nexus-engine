import { describe, expect, it } from "vitest";
import { defineExperienceDNA, direction, intent } from "@nexus/experience/dna";
import { deriveColorConstrainedEmitterInput, resolveColorConstraints } from "./color-constraints";
import { deriveExperienceTokenManifest } from "./index";

const because = "fixture evidence";
const dna = defineExperienceDNA({
  version: 2,
  subject: "constraint fixture",
  principles: ["explicit constraints survive emission"],
  artDirectionVocabulary: ["restrained"],
  composition: { asymmetry: intent(0.5, because), gridDiscipline: intent(0.5, because), overlap: intent(0.5, because), continuity: intent(0.5, because), dominantFlow: direction("measured", because) },
  density: { information: intent(0.5, because), whitespace: intent(0.7, because), compression: intent(0.3, because) },
  geometry: { angularity: intent(0.5, because), regularity: intent(0.5, because), boundaryVisibility: intent(0.5, because), dominantShape: direction("neutral", because) },
  typography: { scaleContrast: intent(0.5, because), hierarchyRigidity: intent(0.5, because), expressiveType: intent(0.5, because), voice: direction("controlled", because) },
  media: { dominance: intent(0.5, because), continuity: intent(0.5, because), documentaryVsAbstract: intent(0.7, because), role: direction("proof", because) },
  navigation: { persistence: intent(0.5, because), visibility: intent(0.5, because), topology: direction("direct", because) },
  interaction: { discoverability: intent(0.5, because), directness: intent(0.5, because), spatiality: intent(0.5, because), language: direction("direct", because) },
  cta: { prominence: intent(0.5, because), repetition: intent(0.3, because), grammar: direction("restrained", because) },
  motion: { intensity: intent(0.3, because), continuity: intent(0.5, because), choreography: direction("restrained", because) },
  editoriality: intent(0.6, because),
  cinematicity: intent(0.9, because),
  ornamentation: intent(0.2, because),
});

describe("color constraint resolver", () => {
  it("keeps explicit white/gray output neutral and excludes gold without operator palette choices", () => {
    const constraints = ["Use white and elegant gray as the color family.", "Absolutely no gold or dorado anywhere."];
    const resolved = resolveColorConstraints({ constraints, projectSeed: "zona-dental-polanco" });
    expect(resolved.surfaceTone).toBe("light");
    expect(resolved.accent.chroma).toBeLessThanOrEqual(0.012);
    expect(resolved.forbiddenHueRanges.some((range) => range.min === 60 && range.max === 105)).toBe(true);
    expect(resolved.accent.hue >= 60 && resolved.accent.hue <= 105).toBe(false);

    const manifest = deriveExperienceTokenManifest(deriveColorConstrainedEmitterInput({ dna, constraints, projectSeed: "zona-dental-polanco" }));
    expect(manifest["surface-0"]).toContain("98.5%");
    expect(manifest["surface-1"]).toContain("94.5%");
  });

  it("is deterministic and moves requested forbidden hues outside the forbidden range", () => {
    const constraints = ["Use gold as the accent.", "Avoid gold in the final output."];
    const first = resolveColorConstraints({ constraints, projectSeed: "same" });
    const second = resolveColorConstraints({ constraints, projectSeed: "same" });
    expect(first).toEqual(second);
    expect(first.accent.hue >= 60 && first.accent.hue <= 105).toBe(false);
  });
});

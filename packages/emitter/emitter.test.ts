import { describe, expect, it } from "vitest";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "@nexus/experience/dna";
import { emitExperienceCss } from "./index";

function dna(scaleContrast: number, cinematicity: number, angularity: number): ExperienceDNA {
  const because = "Project-specific evidence requires this intent.";
  return defineExperienceDNA({
    version: 2,
    subject: `fixture-${scaleContrast}-${cinematicity}-${angularity}`,
    principles: ["Business ritual controls composition"],
    artDirectionVocabulary: ["ritual", "spatial"],
    composition: {
      asymmetry: intent(0.7, because), gridDiscipline: intent(0.45, because), overlap: intent(0.62, because), continuity: intent(0.8, because), dominantFlow: direction("orbital", because),
    },
    density: { information: intent(0.45, because), whitespace: intent(0.72, because), compression: intent(0.25, because) },
    geometry: { angularity: intent(angularity, because), regularity: intent(0.35, because), boundaryVisibility: intent(0.4, because), dominantShape: direction("tensioned curves", because) },
    typography: { scaleContrast: intent(scaleContrast, because), hierarchyRigidity: intent(0.55, because), expressiveType: intent(0.7, because), voice: direction("editorial contrast", because) },
    media: { dominance: intent(0.8, because), continuity: intent(0.72, because), documentaryVsAbstract: intent(0.4, because), role: direction("narrative object", because) },
    navigation: { persistence: intent(0.5, because), visibility: intent(0.7, because), topology: direction("contextual", because) },
    interaction: { discoverability: intent(0.72, because), directness: intent(0.6, because), spatiality: intent(0.8, because), language: direction("physical response", because) },
    cta: { prominence: intent(0.55, because), repetition: intent(0.2, because), grammar: direction("single decisive action", because) },
    motion: { intensity: intent(0.65, because), continuity: intent(0.88, because), choreography: direction("persistent transformation", because) },
    editoriality: intent(0.7, because), cinematicity: intent(cinematicity, because), ornamentation: intent(0.35, because),
  });
}

const accent = { lightness: 0.62, chroma: 0.19, hue: 28 } as const;

describe("DNA to CSS emitter", () => {
  it("emits byte-identical CSS for the same DNA and accent", async () => {
    const input = { dna: dna(0.85, 0.8, 0.7), accent };
    const first = await emitExperienceCss(input);
    const second = await emitExperienceCss(input);
    expect(second.css).toBe(first.css);
    expect(second.tokenManifest).toEqual(first.tokenManifest);
    expect(first.css).toContain("--nexus-type-step-5");
    expect(first.css).toContain("oklch(");
  });

  it("produces materially different scales for different DNA", async () => {
    const restrained = await emitExperienceCss({ dna: dna(0.05, 0.15, 0.1), accent });
    const expressive = await emitExperienceCss({ dna: dna(0.95, 0.9, 0.95), accent });

    expect(expressive.css).not.toBe(restrained.css);
    expect(expressive.tokenManifest["type-step-5"]).not.toBe(restrained.tokenManifest["type-step-5"]);
    expect(expressive.tokenManifest["radius-md"]).not.toBe(restrained.tokenManifest["radius-md"]);
    expect(expressive.tokenManifest["surface-0"]).not.toBe(restrained.tokenManifest["surface-0"]);
  });

  it("rejects invalid accent input instead of silently normalizing it", async () => {
    await expect(emitExperienceCss({ dna: dna(0.5, 0.5, 0.5), accent: { lightness: 1.2, chroma: 0.2, hue: 20 } })).rejects.toThrow(/lightness/);
  });
});

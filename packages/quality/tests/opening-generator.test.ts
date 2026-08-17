import { describe, expect, it } from "vitest";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "@nexus/experience";
import { generateOpeningCandidates } from "../opening-generator";

function dna(overrides: Partial<Pick<ExperienceDNA, "editoriality" | "cinematicity" | "ornamentation">> = {}): ExperienceDNA {
  return defineExperienceDNA({
    version: 2,
    subject: "Independent specialty coffee roaster with transparent sourcing",
    principles: ["origin before ornament"],
    artDirectionVocabulary: ["tactile", "traceable", "ritual"],
    composition: {
      asymmetry: intent(0.78, "asymmetry reflects the uneven geography of origin lots", ["brief:origin-map"]),
      gridDiscipline: intent(0.48, "structure must remain legible without becoming corporate"),
      overlap: intent(0.62, "overlap connects farm, roast and cup as one chain"),
      continuity: intent(0.84, "the sourcing story should feel continuous", ["research:supply-chain"]),
      dominantFlow: direction("origin-to-cup diagonal", "the business story progresses from source to ritual", ["brief:journey"]),
    },
    density: {
      information: intent(0.58, "traceability needs meaningful detail"),
      whitespace: intent(0.72, "premium coffee benefits from deliberate breathing room", ["brand:quiet-confidence"]),
      compression: intent(0.34, "avoid catalogue density"),
    },
    geometry: {
      angularity: intent(0.66, "terrain and roast graphs create directional energy"),
      regularity: intent(0.42, "natural source material should not feel mechanically uniform"),
      boundaryVisibility: intent(0.38, "relationships matter more than boxes"),
      dominantShape: direction("contour path", "topographic sourcing is a business-specific visual cue", ["asset:farm-map"]),
    },
    typography: {
      scaleContrast: intent(0.81, "origin names and tasting notes need dramatic hierarchy", ["copy:origin-names"]),
      hierarchyRigidity: intent(0.52, "editorial hierarchy can flex by coffee story"),
      expressiveType: intent(0.67, "type should carry sensory character"),
      voice: direction("precise editorial warmth", "the brand balances expertise with hospitality", ["brand:voice"]),
    },
    media: {
      dominance: intent(0.77, "farm and process photography are primary evidence", ["photo:farm"]),
      continuity: intent(0.82, "media should connect source and finished cup"),
      documentaryVsAbstract: intent(0.86, "documentary evidence supports transparency"),
      role: direction("documentary provenance", "photography proves sourcing claims", ["photo:producer"]),
    },
    navigation: {
      persistence: intent(0.4, "navigation should not overpower the story"),
      visibility: intent(0.65, "shop and sourcing remain findable"),
      topology: direction("story-led branches", "people enter through coffee, origin or philosophy"),
    },
    interaction: {
      discoverability: intent(0.69, "traceability details should reward exploration"),
      directness: intent(0.61, "buying coffee stays straightforward"),
      spatiality: intent(0.8, "origin relationships can be understood spatially", ["research:origin-relations"]),
      language: direction("trace-and-reveal", "interaction exposes provenance rather than decoration", ["brief:traceability"]),
    },
    cta: {
      prominence: intent(0.55, "commerce matters without dominating provenance"),
      repetition: intent(0.28, "avoid repeated sales prompts"),
      grammar: direction("contextual invitation", "actions follow the coffee story"),
    },
    motion: {
      intensity: intent(0.64, "motion connects stages of the sourcing journey", ["motion:purpose"]),
      continuity: intent(0.78, "transitions should preserve spatial context"),
      choreography: direction("trace progression", "movement follows origin-to-cup causality", ["motion:trace"]),
    },
    editoriality: overrides.editoriality ?? intent(0.8, "long-form provenance benefits from editorial pacing"),
    cinematicity: overrides.cinematicity ?? intent(0.68, "documentary media can create emotional scale"),
    ornamentation: overrides.ornamentation ?? intent(0.31, "decoration must yield to sourcing evidence"),
  });
}

const input = {
  dna: dna(),
  businessSignals: ["single-farm traceability", "small-batch roast dates", "producer revenue transparency"],
  references: [
    { principle: "use spatial continuity to connect evidence across sections", evidenceId: "gallery:ref-a" },
    { principle: "let documentary media carry proof instead of decoration", evidenceId: "gallery:ref-b" },
  ],
};

describe("opening candidate generator", () => {
  it("deterministically generates three evidence-grounded, structurally distinct openings", () => {
    const first = generateOpeningCandidates(input);
    const second = generateOpeningCandidates(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((candidate) => candidate.openingId)).size).toBe(3);
    expect(new Set(first.map((candidate) => candidate.openingSignature)).size).toBe(3);
    expect(new Set(first.map((candidate) => candidate.signatureMechanic)).size).toBe(3);
    expect(first.every((candidate) => candidate.evidenceIds.some((id) => id.startsWith("gallery:")))).toBe(true);
  });

  it("does not emit known template vocabulary", () => {
    const output = JSON.stringify(generateOpeningCandidates(input)).toLowerCase();
    for (const term of ["hero", "feature cards", "pill nav", "card grid", "cta band"]) expect(output).not.toContain(term);
  });

  it("changes ordering and identities when the DNA changes materially", () => {
    const editorial = generateOpeningCandidates({ ...input, dna: dna({ editoriality: intent(0.95, "editorial structure is dominant") }) });
    const cinematic = generateOpeningCandidates({ ...input, dna: dna({ editoriality: intent(0.1, "editorial structure is intentionally weak"), cinematicity: intent(0.99, "cinematic media is dominant") }) });
    expect(editorial.map((candidate) => candidate.openingId)).not.toEqual(cinematic.map((candidate) => candidate.openingId));
    expect(editorial[0]?.openingSignature).not.toBe(cinematic[0]?.openingSignature);
  });

  it("fails closed without business specificity or real reference diversity", () => {
    expect(() => generateOpeningCandidates({ ...input, businessSignals: ["premium", "modern"] })).toThrow("businessSignals requires at least 3");
    expect(() => generateOpeningCandidates({ ...input, references: [{ principle: "one", evidenceId: "same" }, { principle: "two", evidenceId: "same" }] })).toThrow("two distinct reference evidence ids");
    expect(() => generateOpeningCandidates({ ...input, references: [{ principle: "same", evidenceId: "a" }, { principle: "same", evidenceId: "b" }] })).toThrow("two distinct reference principles");
  });
});

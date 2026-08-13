import { describe, expect, it } from "vitest";
import {
  compileExperiencePlan,
  defineExperienceBrief,
  defineExperienceDNA,
  direction,
  intent,
  RECIPE_LIBRARY,
  resolveCapabilities
} from "../index";

const because = "Because the brief requires this specific decision.";

const brief = defineExperienceBrief({
  version: 2,
  id: "test-brief",
  brand: { name: "Test", industry: "Research", positioning: "Precise", personality: ["direct"], audiences: ["buyer"] },
  commercialGoal: "Generate qualified contact",
  priorities: ["Fast comprehension"],
  requiredCapabilityIds: ["gallery", "contact"],
  assets: [], references: [], forbiddenPatterns: [], forbiddenWords: [], constraints: []
});

const dna = defineExperienceDNA({
  version: 2, subject: "test", principles: ["Evidence before action"], artDirectionVocabulary: ["editorial"],
  composition: { asymmetry: intent(0.5,because), gridDiscipline: intent(0.5,because), overlap: intent(0.2,because), continuity: intent(0.8,because), dominantFlow: direction("sequence",because) },
  density: { information: intent(0.5,because), whitespace: intent(0.6,because), compression: intent(0.2,because) },
  geometry: { angularity: intent(0.5,because), regularity: intent(0.5,because), boundaryVisibility: intent(0.4,because), dominantShape: direction("field",because) },
  typography: { scaleContrast: intent(0.7,because), hierarchyRigidity: intent(0.5,because), expressiveType: intent(0.5,because), voice: direction("editorial",because) },
  media: { dominance: intent(0.7,because), continuity: intent(0.5,because), documentaryVsAbstract: intent(0.8,because), role: direction("proof",because) },
  navigation: { persistence: intent(0.2,because), visibility: intent(0.8,because), topology: direction("linear",because) },
  interaction: { discoverability: intent(0.8,because), directness: intent(0.9,because), spatiality: intent(0.1,because), language: direction("direct",because) },
  cta: { prominence: intent(0.4,because), repetition: intent(0.2,because), grammar: direction("text-link",because) },
  motion: { intensity: intent(0.3,because), continuity: intent(0.5,because), choreography: direction("reveal",because) },
  editoriality: intent(0.8,because), cinematicity: intent(0.3,because), ornamentation: intent(0.1,because)
});

describe("Experience compiler", () => {
  it("turns brief + DNA + capabilities + recipe into a UI-agnostic plan", () => {
    const plan = compileExperiencePlan({
      brief,
      dna,
      capabilities: resolveCapabilities(brief.requiredCapabilityIds),
      recipe: RECIPE_LIBRARY["editorial-sequence"]!
    });

    expect(plan.narrativeSequence.map((stage) => stage.stageId)).toEqual(["thesis", "evidence", "action"]);
    expect(plan.capabilityPlacements.map((placement) => placement.capabilityId).sort()).toEqual(["contact", "gallery"]);
    expect(JSON.stringify(plan)).not.toMatch(/className|borderRadius|fontFamily|buttonVariant/);
    expect(plan.unresolvedDecisions).toEqual([]);
  });

  it("fails when a required capability definition is missing", () => {
    expect(() => compileExperiencePlan({
      brief,
      dna,
      capabilities: resolveCapabilities(["gallery"]),
      recipe: RECIPE_LIBRARY["editorial-sequence"]!
    })).toThrow(/missing required capability definitions/i);
  });
});

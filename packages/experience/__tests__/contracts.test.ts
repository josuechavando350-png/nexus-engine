import { describe, expect, it } from "vitest";
import {
  defineCapability,
  defineExperienceBrief,
  defineExperienceDNA,
  defineRecipe,
  direction,
  intent,
  STANDARD_CAPABILITIES
} from "../index";

const rationale = "Because this specific brand/problem requires it.";

function validDNA() {
  return defineExperienceDNA({
    version: 2,
    subject: "probe",
    principles: ["Intent before convention"],
    artDirectionVocabulary: ["editorial"],
    composition: { asymmetry: intent(0.5, rationale), gridDiscipline: intent(0.5, rationale), overlap: intent(0.2, rationale), continuity: intent(0.7, rationale), dominantFlow: direction("continuous reading", rationale) },
    density: { information: intent(0.4, rationale), whitespace: intent(0.8, rationale), compression: intent(0.2, rationale) },
    geometry: { angularity: intent(0.6, rationale), regularity: intent(0.4, rationale), boundaryVisibility: intent(0.3, rationale), dominantShape: direction("open field", rationale) },
    typography: { scaleContrast: intent(0.8, rationale), hierarchyRigidity: intent(0.4, rationale), expressiveType: intent(0.7, rationale), voice: direction("editorial", rationale) },
    media: { dominance: intent(0.3, rationale), continuity: intent(0.5, rationale), documentaryVsAbstract: intent(0.6, rationale), role: direction("evidence", rationale) },
    navigation: { persistence: intent(0.2, rationale), visibility: intent(0.8, rationale), topology: direction("linear", rationale) },
    interaction: { discoverability: intent(0.8, rationale), directness: intent(0.9, rationale), spatiality: intent(0.1, rationale), language: direction("text-led", rationale) },
    cta: { prominence: intent(0.4, rationale), repetition: intent(0.2, rationale), grammar: direction("editorial link", rationale) },
    motion: { intensity: intent(0.2, rationale), continuity: intent(0.4, rationale), choreography: direction("quiet reveal", rationale) },
    editoriality: intent(0.9, rationale),
    cinematicity: intent(0.2, rationale),
    ornamentation: intent(0.1, rationale)
  });
}

describe("V2 Experience contracts", () => {
  it("rejects UI-specific fields inside capabilities", () => {
    const invalid = {
      id: "bad",
      name: "Bad",
      outcome: "Do something",
      primaryActor: "visitor",
      journeyRoles: ["utility"],
      dataNeeds: [],
      criticality: "supporting",
      component: "Card"
    };
    expect(() => defineCapability(invalid as never)).toThrow(/UI-specific key/);
  });

  it("rejects UI-specific fields inside recipes", () => {
    const invalid = {
      id: "bad-recipe",
      name: "Bad",
      intent: "Bad",
      stages: [{ id: "one", purpose: "One", acceptsRoles: ["utility"], moves: [] }],
      constraints: [],
      antiPatterns: [],
      borderRadius: "999px"
    };
    expect(() => defineRecipe(invalid as never)).toThrow(/UI-specific key/);
  });

  it("requires every DNA scale to stay normalized and justified", () => {
    expect(validDNA().composition.asymmetry.value).toBe(0.5);
    expect(() => intent(2, rationale)).not.toThrow();
    const dna = validDNA();
    expect(() => defineExperienceDNA({ ...dna, editoriality: intent(2, rationale) })).toThrow(/between 0 and 1/);
  });

  it("keeps reference adaptation explicitly inspire-not-copy", () => {
    const brief = defineExperienceBrief({
      version: 2,
      id: "brief",
      brand: { name: "Brand", industry: "Test", positioning: "Distinct", personality: ["precise"], audiences: ["buyers"] },
      commercialGoal: "Qualified demand",
      priorities: ["Clarity"],
      requiredCapabilityIds: ["contact"],
      assets: [],
      references: [{ id: "ref", sourceLabel: "Reference", observations: { rhythm: "alternating" }, adaptationRule: "inspire-not-copy" }],
      forbiddenPatterns: [],
      forbiddenWords: [],
      constraints: []
    });
    expect(brief.references[0]?.adaptationRule).toBe("inspire-not-copy");
  });

  it("ships capability definitions as outcomes, not UI", () => {
    expect(STANDARD_CAPABILITIES.whatsapp?.outcome).toMatch(/WhatsApp/);
    expect(JSON.stringify(STANDARD_CAPABILITIES)).not.toMatch(/className|borderRadius|buttonVariant|cardVariant/);
  });
});

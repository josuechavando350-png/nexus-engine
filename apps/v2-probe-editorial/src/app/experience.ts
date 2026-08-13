import {
  compileExperiencePlan,
  defineExperienceBrief,
  defineExperienceDNA,
  direction,
  intent,
  RECIPE_LIBRARY,
  resolveCapabilities
} from "@nexus/experience";

const why = "The probe must demonstrate reading-led hierarchy without a conventional marketing hero or card grid.";

export const brief = defineExperienceBrief({
  version: 2,
  id: "v2-editorial",
  brand: {
    name: "Éditions 27",
    industry: "Independent cultural publication",
    positioning: "Quiet authority for readers who value depth over promotion.",
    personality: ["measured", "literary", "precise"],
    audiences: ["collectors", "cultural readers"]
  },
  commercialGoal: "Move a qualified reader from point of view to subscription/contact.",
  priorities: ["Reading rhythm", "Editorial trust", "Low-pressure conversion"],
  requiredCapabilityIds: ["gallery", "social-proof", "contact"],
  assets: [{ id: "essay-images", kind: "photography", status: "planned" }],
  references: [],
  forbiddenPatterns: ["marketing hero", "feature cards", "dual pill CTA"],
  forbiddenWords: [],
  constraints: [{ id: "semantic-order", statement: "Reading order must remain coherent on narrow screens.", source: "accessibility", severity: "required" }]
});

export const dna = defineExperienceDNA({
  version: 2,
  subject: brief.id,
  principles: ["Thesis before action", "Whitespace is pacing, not decoration"],
  artDirectionVocabulary: ["editorial", "quiet", "paper-like", "essay-led"],
  composition: { asymmetry: intent(0.58, why), gridDiscipline: intent(0.72, why), overlap: intent(0.05, why), continuity: intent(0.9, why), dominantFlow: direction("continuous reading column interrupted by marginalia", why) },
  density: { information: intent(0.5, why), whitespace: intent(0.9, why), compression: intent(0.1, why) },
  geometry: { angularity: intent(0.85, why), regularity: intent(0.62, why), boundaryVisibility: intent(0.48, why), dominantShape: direction("rules, margins, long columns", why) },
  typography: { scaleContrast: intent(0.92, why), hierarchyRigidity: intent(0.38, why), expressiveType: intent(0.88, why), voice: direction("literary editorial", why) },
  media: { dominance: intent(0.32, why), continuity: intent(0.4, why), documentaryVsAbstract: intent(0.8, why), role: direction("evidence placed inside the reading flow", why) },
  navigation: { persistence: intent(0.18, why), visibility: intent(0.75, why), topology: direction("margin index", why) },
  interaction: { discoverability: intent(0.86, why), directness: intent(0.8, why), spatiality: intent(0.08, why), language: direction("text-led and explicit", why) },
  cta: { prominence: intent(0.28, why), repetition: intent(0.12, why), grammar: direction("editorial text action with rule", why) },
  motion: { intensity: intent(0.08, why), continuity: intent(0.2, why), choreography: direction("near-static reveal", why) },
  editoriality: intent(1, why),
  cinematicity: intent(0.08, why),
  ornamentation: intent(0.12, why)
});

export const plan = compileExperiencePlan({
  brief,
  dna,
  capabilities: resolveCapabilities(brief.requiredCapabilityIds),
  recipe: RECIPE_LIBRARY["editorial-sequence"]!
});

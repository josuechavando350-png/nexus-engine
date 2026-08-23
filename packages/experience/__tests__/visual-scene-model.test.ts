import { describe, expect, it } from "vitest";
import { compileExperiencePlan } from "../compiler";
import { defineExperienceDNA, direction, intent } from "../dna";
import { defineExperienceBrief } from "../brief";
import { RECIPE_LIBRARY } from "../recipes";
import { resolveCapabilities } from "../capabilities";
import { assertSceneHasNoSilentOverlap, deriveVisualSceneModel, type SceneAsset, type SceneContent } from "../visual-scene-model";

const because = "Because the fixture requires evidence-bound intrinsic layout.";
const dna = defineExperienceDNA({
  version: 2, subject: "scene-fixture", principles: ["Content determines space"], artDirectionVocabulary: ["editorial"],
  composition: { asymmetry: intent(0.5, because), gridDiscipline: intent(0.8, because), overlap: intent(0, because), continuity: intent(0.8, because), dominantFlow: direction("sequence", because) },
  density: { information: intent(0.5, because), whitespace: intent(0.6, because), compression: intent(0.2, because) },
  geometry: { angularity: intent(0.5, because), regularity: intent(0.5, because), boundaryVisibility: intent(0.4, because), dominantShape: direction("field", because) },
  typography: { scaleContrast: intent(0.7, because), hierarchyRigidity: intent(0.5, because), expressiveType: intent(0.5, because), voice: direction("editorial", because) },
  media: { dominance: intent(0.7, because), continuity: intent(0.5, because), documentaryVsAbstract: intent(0.8, because), role: direction("proof", because) },
  navigation: { persistence: intent(0.2, because), visibility: intent(0.8, because), topology: direction("linear", because) },
  interaction: { discoverability: intent(0.8, because), directness: intent(0.9, because), spatiality: intent(0.1, because), language: direction("direct", because) },
  cta: { prominence: intent(0.4, because), repetition: intent(0.2, because), grammar: direction("text-link", because) },
  motion: { intensity: intent(0.3, because), continuity: intent(0.5, because), choreography: direction("reveal", because) },
  editoriality: intent(0.8, because), cinematicity: intent(0.3, because), ornamentation: intent(0.1, because)
});
const brief = defineExperienceBrief({ version: 2, id: "scene", brand: { name: "Fixture", industry: "test", positioning: "clear", personality: ["direct"], audiences: ["reader"] }, commercialGoal: "Explain", priorities: ["intrinsic flow"], requiredCapabilityIds: ["gallery", "contact"], assets: [], references: [], forbiddenPatterns: [], forbiddenWords: [], constraints: [] });
const plan = compileExperiencePlan({ brief, dna, capabilities: resolveCapabilities(brief.requiredCapabilityIds), recipe: RECIPE_LIBRARY["editorial-sequence"]! });
const content: readonly SceneContent[] = [
  { id: "heading", stageId: "thesis", kind: "HEADING", text: "A concise heading" },
  { id: "body", stageId: "thesis", kind: "BODY", text: "Evidence-led copy must allocate its own space." },
  { id: "action", stageId: "action", kind: "ACTION", text: "Continue" }
];
const asset: SceneAsset = { id: "hero", stageId: "evidence", sourceDigest: `sha256:${"a".repeat(64)}`, width: 1600, height: 900, available: true };
const derive = (overrides: Partial<Parameters<typeof deriveVisualSceneModel>[0]> = {}) => deriveVisualSceneModel({ projectId: "fixture", dna, plan, content, assets: [asset], environment: { viewportWidth: 1440, zoom: 1, reducedMotion: false }, ...overrides });

describe("Visual Scene Model intrinsic derivation", () => {
  it("is deterministic, provenance-bound and cannot express clipping", () => {
    const first = derive();
    const second = derive();
    expect(first).toEqual(second);
    expect(first.provenance.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.layoutPolicy).toEqual({ blockSizing: "INTRINSIC", contentGrowth: "REFLOW", clipping: "FORBIDDEN", semanticOrderPreserved: true });
    expect(JSON.stringify(first)).not.toMatch(/overflow|fixedHeight|598|585/);
    expect(() => assertSceneHasNoSilentOverlap(first)).not.toThrow();
  });

  it("reflows text x2 and a 40-character heading by growing intrinsic space", () => {
    const base = derive();
    const stressed = derive({ content: content.map((item) => ({ ...item, text: item.kind === "HEADING" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" : `${item.text} ${item.text}` })) });
    expect(stressed.stages[0]!.blockSize).toBeGreaterThan(base.stages[0]!.blockSize);
    expect(() => assertSceneHasNoSilentOverlap(stressed)).not.toThrow();
  });

  it("represents absent and vertical imagery without collapsing the flow", () => {
    const missing = derive({ assets: [{ ...asset, available: false }] });
    const vertical = derive({ assets: [{ ...asset, width: 540, height: 960 }] });
    expect(missing.stages[1]!.nodes[0]).toMatchObject({ kind: "MEDIA_FALLBACK", sizing: "INTRINSIC_FALLBACK" });
    expect(vertical.stages[1]!.blockSize).toBeGreaterThan(derive().stages[1]!.blockSize);
    expect(() => assertSceneHasNoSilentOverlap(vertical)).not.toThrow();
  });

  it("reflows at 390px and zoom 200% instead of clipping", () => {
    const narrow = derive({ environment: { viewportWidth: 390, zoom: 1, reducedMotion: false } });
    const zoomed = derive({ environment: { viewportWidth: 390, zoom: 2, reducedMotion: false } });
    expect(narrow.stages.every((stage) => stage.columns === 1)).toBe(true);
    expect(zoomed.stages[0]!.blockSize).toBeGreaterThan(narrow.stages[0]!.blockSize);
    expect(() => assertSceneHasNoSilentOverlap(zoomed)).not.toThrow();
  });

  it("derives reduced motion without changing intrinsic geometry", () => {
    const normal = derive();
    const reduced = derive({ environment: { viewportWidth: 1440, zoom: 1, reducedMotion: true } });
    expect(reduced.motion).toEqual({ mode: "REDUCED", choreography: "none" });
    expect(reduced.stages).toEqual(normal.stages);
  });
});

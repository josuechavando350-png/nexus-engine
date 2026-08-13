import type { CompositionStage } from "./composition";
import { assertUiAgnostic } from "./shared";

export type RecipeDefinition = {
  id: string;
  name: string;
  intent: string;
  stages: readonly CompositionStage[];
  constraints: readonly string[];
  antiPatterns: readonly string[];
};

export function defineRecipe(input: RecipeDefinition): RecipeDefinition {
  assertUiAgnostic(input, `Recipe(${input.id || "unknown"})`);
  if (!input.id.trim()) throw new Error("Recipe.id is required.");
  if (!input.stages.length) throw new Error(`Recipe ${input.id} requires at least one stage.`);

  const ids = input.stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Recipe ${input.id} has duplicate stage ids.`);
  }

  return Object.freeze(input);
}

export const RECIPE_LIBRARY: Readonly<Record<string, RecipeDefinition>> = Object.freeze({
  "editorial-sequence": defineRecipe({
    id: "editorial-sequence",
    name: "Editorial sequence",
    intent: "Let narrative hierarchy and reading rhythm drive the experience.",
    stages: [
      { id: "thesis", purpose: "Establish a point of view before asking for action.", acceptsRoles: ["discovery", "trust"], moves: [{ kind: "isolate", subject: "brand-thesis", purpose: "Give the thesis its own reading tempo." }] },
      { id: "evidence", purpose: "Accumulate evidence without converting it into tiles by default.", acceptsRoles: ["proof", "discovery"], moves: [{ kind: "sequence", subjects: ["evidence-a", "evidence-b"], purpose: "Create editorial progression." }] },
      { id: "action", purpose: "Offer a next step only after context exists.", acceptsRoles: ["conversion", "utility"], moves: [{ kind: "anchor", subject: "primary-action", purpose: "Make action legible without dominating the narrative." }] }
    ],
    constraints: ["Reading order must remain coherent without decorative media."],
    antiPatterns: ["card-grid-by-default", "dual-cta-by-default"]
  }),
  "media-immersion": defineRecipe({
    id: "media-immersion",
    name: "Media immersion",
    intent: "Use media continuity as the primary carrier of atmosphere and proof.",
    stages: [
      { id: "arrival", purpose: "Enter through atmosphere rather than a marketing stack.", acceptsRoles: ["discovery", "proof"], moves: [{ kind: "layer", subjects: ["identity", "media"], purpose: "Make atmosphere and identity arrive together." }] },
      { id: "chapters", purpose: "Reveal product/service meaning through successive media-led chapters.", acceptsRoles: ["discovery", "proof", "trust"], moves: [{ kind: "reveal", subject: "chapter-sequence", purpose: "Control attention through continuity rather than boxes." }] },
      { id: "conversion", purpose: "Make the next step appear as a consequence of the story.", acceptsRoles: ["conversion", "utility"], moves: [{ kind: "interrupt", subject: "conversion", purpose: "Interrupt immersion only when the visitor has enough context." }] }
    ],
    constraints: ["Must retain identity when rich media is removed or reduced."],
    antiPatterns: ["autoplay-required-for-comprehension", "effect-for-effect-sake"]
  }),
  "dense-index": defineRecipe({
    id: "dense-index",
    name: "Dense index",
    intent: "Prioritize fast scanning, comparison, and operational clarity.",
    stages: [
      { id: "orientation", purpose: "Expose system state and information architecture immediately.", acceptsRoles: ["utility", "discovery"], moves: [{ kind: "anchor", subject: "system-index", purpose: "Orient before persuasion." }] },
      { id: "matrix", purpose: "Allow dense comparison without breaking each item into decorative cards.", acceptsRoles: ["discovery", "proof", "utility"], moves: [{ kind: "juxtapose", subjects: ["labels", "values"], purpose: "Keep relationships visible." }] },
      { id: "action-rail", purpose: "Keep operational actions discoverable while the index remains primary.", acceptsRoles: ["conversion", "utility"], moves: [{ kind: "echo", subject: "utility-actions", purpose: "Repeat access, not visual chrome." }] }
    ],
    constraints: ["Information density must not remove keyboard or touch clarity."],
    antiPatterns: ["marketing-hero", "decorative-card-grid"]
  }),
  "asymmetric-field": defineRecipe({
    id: "asymmetric-field",
    name: "Asymmetric field",
    intent: "Create hierarchy through imbalance, interruption, and deliberate spatial tension.",
    stages: [
      { id: "field", purpose: "Establish a spatial field with multiple attention anchors.", acceptsRoles: ["discovery", "trust"], moves: [{ kind: "juxtapose", subjects: ["identity", "evidence"], purpose: "Create tension between identity and proof." }] },
      { id: "break", purpose: "Use an interruption to reset reading rhythm.", acceptsRoles: ["proof", "utility"], moves: [{ kind: "interrupt", subject: "evidence-break", purpose: "Avoid uniform section cadence." }] },
      { id: "resolve", purpose: "Resolve spatial tension into a clear next action.", acceptsRoles: ["conversion", "utility"], moves: [{ kind: "isolate", subject: "resolution", purpose: "Let the action feel deliberate rather than repeated." }] }
    ],
    constraints: ["Asymmetry must preserve semantic reading order on narrow viewports."],
    antiPatterns: ["random-overlap", "desktop-only-composition"]
  }),
  "continuous-bands": defineRecipe({
    id: "continuous-bands",
    name: "Continuous bands",
    intent: "Build one continuous information surface using boundaries and rhythm instead of isolated cards.",
    stages: [
      { id: "signal", purpose: "State the operating premise quickly.", acceptsRoles: ["discovery", "trust"], moves: [{ kind: "anchor", subject: "premise", purpose: "Create a stable point of orientation." }] },
      { id: "bands", purpose: "Move through capabilities as a connected system.", acceptsRoles: ["discovery", "proof", "utility"], moves: [{ kind: "sequence", subjects: ["band-a", "band-b", "band-c"], purpose: "Preserve continuity across dense material." }] },
      { id: "handoff", purpose: "Hand the visitor into an operational next step.", acceptsRoles: ["conversion", "utility"], moves: [{ kind: "anchor", subject: "handoff", purpose: "Make the transition explicit." }] }
    ],
    constraints: ["Bands must remain distinguishable without relying on color alone."],
    antiPatterns: ["floating-card-stack", "rounded-surface-default"]
  })
});

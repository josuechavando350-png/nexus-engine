import type { EngineConstraint, NonEmptyArray } from "./shared";
import { assertUiAgnostic, uniq } from "./shared";

export type BrandAssetKind =
  | "logo"
  | "photography"
  | "video"
  | "illustration"
  | "copy"
  | "data"
  | "testimonial"
  | "other";

export type BrandAsset = {
  id: string;
  kind: BrandAssetKind;
  status: "available" | "planned" | "missing";
  notes?: string;
};

/**
 * Structured observation of a visual reference. It records transferable
 * principles, never source assets or instructions to clone the source.
 */
export type ReferenceDirection = {
  id: string;
  sourceLabel: string;
  observations: {
    architecture?: string;
    rhythm?: string;
    proportion?: string;
    whitespace?: string;
    navigation?: string;
    imageRelationship?: string;
    hierarchy?: string;
    geometry?: string;
    interaction?: string;
    motion?: string;
    density?: string;
    responsiveBehavior?: string;
  };
  adaptationRule: "inspire-not-copy";
  notes?: string;
};

export type ExperienceBrief = {
  version: 2;
  id: string;
  brand: {
    name: string;
    industry: string;
    positioning: string;
    personality: NonEmptyArray<string>;
    audiences: NonEmptyArray<string>;
  };
  commercialGoal: string;
  priorities: NonEmptyArray<string>;
  requiredCapabilityIds: readonly string[];
  assets: readonly BrandAsset[];
  references: readonly ReferenceDirection[];
  forbiddenPatterns: readonly string[];
  forbiddenWords: readonly string[];
  constraints: readonly EngineConstraint[];
};

export function defineExperienceBrief(input: ExperienceBrief): ExperienceBrief {
  assertUiAgnostic(input, "ExperienceBrief");

  if (input.version !== 2) throw new Error("ExperienceBrief.version must be 2.");
  if (!input.id.trim()) throw new Error("ExperienceBrief.id is required.");
  if (!input.brand.name.trim()) throw new Error("ExperienceBrief.brand.name is required.");
  if (!input.brand.industry.trim()) throw new Error("ExperienceBrief.brand.industry is required.");
  if (!input.brand.positioning.trim()) throw new Error("ExperienceBrief.brand.positioning is required.");
  if (!input.commercialGoal.trim()) throw new Error("ExperienceBrief.commercialGoal is required.");

  const duplicateCapabilities = input.requiredCapabilityIds.filter(
    (id, index, ids) => ids.indexOf(id) !== index
  );
  if (duplicateCapabilities.length) {
    throw new Error(`ExperienceBrief has duplicate capability ids: ${uniq(duplicateCapabilities).join(", ")}`);
  }

  for (const reference of input.references) {
    if (reference.adaptationRule !== "inspire-not-copy") {
      throw new Error(`Reference ${reference.id} must use adaptationRule=inspire-not-copy.`);
    }
  }

  return Object.freeze(input);
}

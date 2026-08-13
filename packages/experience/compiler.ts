import type { CapabilityDefinition, JourneyRole } from "./capabilities";
import type { ExperienceBrief } from "./brief";
import type { ExperienceDNA } from "./dna";
import type { RecipeDefinition } from "./recipes";
import type { EngineConstraint } from "./shared";
import type { PremiumCapabilityId } from "./premium-capabilities";

export type CapabilityPlacement = {
  capabilityId: string;
  stageId: string;
  matchedRole: JourneyRole;
  priority: "primary" | "supporting" | "optional";
};

export type ExperiencePlan = {
  version: 2;
  id: string;
  briefId: string;
  dnaSubject: string;
  recipeId: string;
  narrativeSequence: ReadonlyArray<{
    stageId: string;
    purpose: string;
    moves: RecipeDefinition["stages"][number]["moves"];
    capabilityIds: readonly string[];
  }>;
  capabilityPlacements: readonly CapabilityPlacement[];
  mediaStrategy: {
    role: string;
    dominance: number;
    reducedCostFallbackRequired: boolean;
  };
  interactionStrategy: {
    language: string;
    directness: number;
    spatiality: number;
  };
  responsiveStrategy: {
    preserveSemanticOrder: true;
    preserveIdentityAcrossViewports: true;
    notes: readonly string[];
  };
  motionStrategy: {
    choreography: string;
    intensity: number;
    reducedMotionFallbackRequired: boolean;
  };
  adaptiveLuxuryStrategy: {
    requested: readonly PremiumCapabilityId[];
    rule: "identity-stable-cost-adaptive";
  };
  constraints: readonly EngineConstraint[];
  originalitySeed: {
    openingSignature: string;
    stageSequence: readonly string[];
    compositionMoves: readonly string[];
    ctaGrammar: string;
    navigationTopology: string;
  };
  unresolvedDecisions: readonly string[];
};

function capabilityPriority(capability: CapabilityDefinition): CapabilityPlacement["priority"] {
  return capability.criticality === "essential"
    ? "primary"
    : capability.criticality === "supporting"
      ? "supporting"
      : "optional";
}

export function compileExperiencePlan(input: {
  brief: ExperienceBrief;
  dna: ExperienceDNA;
  capabilities: readonly CapabilityDefinition[];
  recipe: RecipeDefinition;
  requestedPremiumCapabilities?: readonly PremiumCapabilityId[];
  additionalConstraints?: readonly EngineConstraint[];
}): ExperiencePlan {
  const available = new Map(input.capabilities.map((capability) => [capability.id, capability]));
  const missing = input.brief.requiredCapabilityIds.filter((id) => !available.has(id));
  if (missing.length) throw new Error(`ExperiencePlan missing required capability definitions: ${missing.join(", ")}`);

  const placements: CapabilityPlacement[] = [];
  const unresolved: string[] = [];

  for (const capability of input.capabilities) {
    const match = input.recipe.stages.find((stage) =>
      capability.journeyRoles.some((role) => stage.acceptsRoles.includes(role))
    );

    if (!match) {
      unresolved.push(`No recipe stage accepts capability ${capability.id} roles (${capability.journeyRoles.join(", ")}).`);
      continue;
    }

    const matchedRole = capability.journeyRoles.find((role) => match.acceptsRoles.includes(role));
    if (!matchedRole) continue;

    placements.push({
      capabilityId: capability.id,
      stageId: match.id,
      matchedRole,
      priority: capabilityPriority(capability)
    });
  }

  const narrativeSequence = input.recipe.stages.map((stage) => ({
    stageId: stage.id,
    purpose: stage.purpose,
    moves: stage.moves,
    capabilityIds: placements.filter((placement) => placement.stageId === stage.id).map((placement) => placement.capabilityId)
  }));

  return Object.freeze({
    version: 2 as const,
    id: `${input.brief.id}:${input.recipe.id}`,
    briefId: input.brief.id,
    dnaSubject: input.dna.subject,
    recipeId: input.recipe.id,
    narrativeSequence,
    capabilityPlacements: placements,
    mediaStrategy: {
      role: input.dna.media.role.label,
      dominance: input.dna.media.dominance.value,
      reducedCostFallbackRequired: input.dna.media.dominance.value > 0.5
    },
    interactionStrategy: {
      language: input.dna.interaction.language.label,
      directness: input.dna.interaction.directness.value,
      spatiality: input.dna.interaction.spatiality.value
    },
    responsiveStrategy: {
      preserveSemanticOrder: true as const,
      preserveIdentityAcrossViewports: true as const,
      notes: [
        "Composition may transform; content meaning and capability access must remain stable.",
        "Do not infer low capability from viewport width alone."
      ]
    },
    motionStrategy: {
      choreography: input.dna.motion.choreography.label,
      intensity: input.dna.motion.intensity.value,
      reducedMotionFallbackRequired: input.dna.motion.intensity.value > 0
    },
    adaptiveLuxuryStrategy: {
      requested: input.requestedPremiumCapabilities ?? [],
      rule: "identity-stable-cost-adaptive" as const
    },
    constraints: [...input.brief.constraints, ...(input.additionalConstraints ?? [])],
    originalitySeed: {
      openingSignature: `${input.recipe.id}:${input.recipe.stages[0]?.id ?? "none"}`,
      stageSequence: input.recipe.stages.map((stage) => stage.id),
      compositionMoves: input.recipe.stages.flatMap((stage) => stage.moves.map((move) => move.kind)),
      ctaGrammar: input.dna.cta.grammar.label,
      navigationTopology: input.dna.navigation.topology.label
    },
    unresolvedDecisions: unresolved
  });
}

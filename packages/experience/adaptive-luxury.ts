import type { PremiumCapabilityId } from "./premium-capabilities";
import { PREMIUM_CAPABILITIES } from "./premium-capabilities";

export type ExecutionBudget = {
  js: "zero-client" | "minimal-interaction" | "rich-interaction";
  gpu: "none" | "css-only" | "webgl" | "webgpu";
  network: "ultra-light" | "standard" | "media-heavy";
};

export type RuntimeSignals = {
  reducedMotion: boolean;
  reducedData: boolean;
  hover: boolean;
  precisePointer: boolean;
};

export type LuxuryExecutionProfile = {
  tier: "essential" | "enhanced" | "immersive";
  allowed: readonly PremiumCapabilityId[];
  denied: ReadonlyArray<{ id: PremiumCapabilityId; reason: string }>;
  rationale: readonly string[];
};

export function resolveLuxuryProfile(input: {
  requested: readonly PremiumCapabilityId[];
  signals: RuntimeSignals;
  budget: ExecutionBudget;
}): LuxuryExecutionProfile {
  const allowed: PremiumCapabilityId[] = [];
  const denied: Array<{ id: PremiumCapabilityId; reason: string }> = [];

  for (const id of input.requested) {
    const capability = PREMIUM_CAPABILITIES[id];
    const requirements = capability.signalRequirements;

    if (requirements?.reducedMotionMustBeFalse && input.signals.reducedMotion) {
      denied.push({ id, reason: "prefers-reduced-motion" });
      continue;
    }
    if (requirements?.reducedDataMustBeFalse && input.signals.reducedData) {
      denied.push({ id, reason: "prefers-reduced-data" });
      continue;
    }
    if (requirements?.hover && !input.signals.hover) {
      denied.push({ id, reason: "hover unavailable" });
      continue;
    }
    if (requirements?.precisePointer && !input.signals.precisePointer) {
      denied.push({ id, reason: "precise pointer unavailable" });
      continue;
    }

    const gpuTooExpensive = capability.cost.gpu === "high" && !["webgl", "webgpu"].includes(input.budget.gpu);
    const networkTooExpensive = capability.cost.network === "high" && input.budget.network !== "media-heavy";
    const jsTooExpensive = capability.cost.clientJs === "high" && input.budget.js !== "rich-interaction";

    if (gpuTooExpensive || networkTooExpensive || jsTooExpensive) {
      denied.push({ id, reason: "declared capability budget does not permit this execution cost" });
      continue;
    }

    allowed.push(id);
  }

  const tier: LuxuryExecutionProfile["tier"] = allowed.some((id) => {
    const cost = PREMIUM_CAPABILITIES[id].cost;
    return cost.gpu === "high" || cost.motion === "high" || cost.network === "high";
  })
    ? "immersive"
    : allowed.length
      ? "enhanced"
      : "essential";

  return {
    tier,
    allowed,
    denied,
    rationale: [
      "Same artistic identity at every tier; execution cost changes, meaning does not.",
      "Only reliable user/runtime signals are consumed here; deviceMemory and navigator.connection are intentionally absent."
    ]
  };
}

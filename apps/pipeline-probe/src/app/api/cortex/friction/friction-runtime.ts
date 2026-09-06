import { parseFrictionProbabilityModel, type FrictionProbabilityModel } from "@nexus/core/cortex/friction-abandonment-scoring";

export type Cortex09Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface Cortex09Runtime {
  readonly mode: Cortex09Mode;
  readonly model: FrictionProbabilityModel | null;
}

export function readCortex09Runtime(): Cortex09Runtime {
  const rawMode = process.env.NEXUS_CORTEX_09_MODE?.trim();
  const requestedMode: Cortex09Mode = rawMode === "ACTIVE" || rawMode === "OBSERVE_ONLY" || rawMode === "KILLED" ? rawMode : "KILLED";
  if (requestedMode === "KILLED") return Object.freeze({ mode: "KILLED", model: null });

  const rawModel = process.env.NEXUS_CORTEX_09_MODEL_JSON?.trim();
  if (!rawModel) return Object.freeze({ mode: "KILLED", model: null });
  try {
    return Object.freeze({ mode: requestedMode, model: parseFrictionProbabilityModel(JSON.parse(rawModel) as unknown) });
  } catch {
    return Object.freeze({ mode: "KILLED", model: null });
  }
}

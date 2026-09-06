import { createHash } from "node:crypto";
import { parseFrictionProbabilityModel, type FrictionProbabilityModel } from "@nexus/core/cortex/friction-abandonment-scoring";

export type Cortex09Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface Cortex09Runtime {
  readonly mode: Cortex09Mode;
  readonly model: FrictionProbabilityModel | null;
  readonly modelArtifactDigest: `sha256:${string}` | null;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function artifactDigest(rawModel: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(rawModel, "utf8").digest("hex")}`;
}

export function readCortex09Runtime(): Cortex09Runtime {
  const rawMode = process.env.NEXUS_CORTEX_09_MODE?.trim();
  const requestedMode: Cortex09Mode = rawMode === "ACTIVE" || rawMode === "OBSERVE_ONLY" || rawMode === "KILLED" ? rawMode : "KILLED";
  if (requestedMode === "KILLED") return Object.freeze({ mode: "KILLED", model: null, modelArtifactDigest: null });

  const rawModel = process.env.NEXUS_CORTEX_09_MODEL_JSON?.trim();
  const expectedArtifactDigest = process.env.NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST?.trim();
  const expectedCalibrationSourceDigest = process.env.NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST?.trim();
  if (
    !rawModel
    || !expectedArtifactDigest
    || !SHA256.test(expectedArtifactDigest)
    || !expectedCalibrationSourceDigest
    || !SHA256.test(expectedCalibrationSourceDigest)
  ) {
    return Object.freeze({ mode: "KILLED", model: null, modelArtifactDigest: null });
  }

  const actualArtifactDigest = artifactDigest(rawModel);
  if (actualArtifactDigest !== expectedArtifactDigest) {
    return Object.freeze({ mode: "KILLED", model: null, modelArtifactDigest: null });
  }

  try {
    const model = parseFrictionProbabilityModel(JSON.parse(rawModel) as unknown);
    // The model cannot self-authorize its own calibration provenance. Require an
    // independently configured source identity and fail closed on disagreement.
    if (model.sourceDigest !== expectedCalibrationSourceDigest) {
      return Object.freeze({ mode: "KILLED", model: null, modelArtifactDigest: null });
    }
    return Object.freeze({ mode: requestedMode, model, modelArtifactDigest: actualArtifactDigest });
  } catch {
    return Object.freeze({ mode: "KILLED", model: null, modelArtifactDigest: null });
  }
}

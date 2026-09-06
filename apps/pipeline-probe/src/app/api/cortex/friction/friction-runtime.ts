import { createHash } from "node:crypto";
import {
  FRICTION_FEATURE_CONTRACT_ID,
  parseFrictionProbabilityModel,
  type FrictionProbabilityModel,
} from "@nexus/core/cortex/friction-abandonment-scoring";

export type Cortex09Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface Cortex09Runtime {
  readonly mode: Cortex09Mode;
  readonly featureContractId: typeof FRICTION_FEATURE_CONTRACT_ID;
  readonly model: FrictionProbabilityModel | null;
  readonly modelArtifactDigest: `sha256:${string}` | null;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function artifactDigest(rawModel: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(rawModel, "utf8").digest("hex")}`;
}

function killed(): Cortex09Runtime {
  return Object.freeze({
    mode: "KILLED",
    featureContractId: FRICTION_FEATURE_CONTRACT_ID,
    model: null,
    modelArtifactDigest: null,
  });
}

export function readCortex09Runtime(): Cortex09Runtime {
  const rawMode = process.env.NEXUS_CORTEX_09_MODE?.trim();
  const requestedMode: Cortex09Mode = rawMode === "ACTIVE" || rawMode === "OBSERVE_ONLY" || rawMode === "KILLED"
    ? rawMode
    : "KILLED";
  if (requestedMode === "KILLED") return killed();

  const rawModel = process.env.NEXUS_CORTEX_09_MODEL_JSON?.trim();
  const expectedArtifactDigest = process.env.NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST?.trim();
  const expectedCalibrationSourceDigest = process.env.NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST?.trim();
  if (
    !rawModel
    || !expectedArtifactDigest
    || !SHA256.test(expectedArtifactDigest)
    || !expectedCalibrationSourceDigest
    || !SHA256.test(expectedCalibrationSourceDigest)
  ) return killed();

  const actualArtifactDigest = artifactDigest(rawModel);
  if (actualArtifactDigest !== expectedArtifactDigest) return killed();

  try {
    const model = parseFrictionProbabilityModel(JSON.parse(rawModel) as unknown);
    // A model cannot authorize its own claimed training/calibration provenance.
    // Require an independent operator-provided source identity and fail closed
    // when it does not agree with the artifact's declared source digest.
    if (model.sourceDigest !== expectedCalibrationSourceDigest) return killed();
    return Object.freeze({
      mode: requestedMode,
      featureContractId: FRICTION_FEATURE_CONTRACT_ID,
      model,
      modelArtifactDigest: actualArtifactDigest,
    });
  } catch {
    return killed();
  }
}

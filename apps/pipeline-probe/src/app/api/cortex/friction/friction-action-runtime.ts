import { createHash } from "node:crypto";
import { parseFrictionActionPolicy, type FrictionActionPolicy } from "@nexus/core/cortex/friction-control-plane-actions";

export type Cortex29ActionMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface Cortex29ActionRuntime {
  readonly mode: Cortex29ActionMode;
  readonly policy: FrictionActionPolicy | null;
  readonly policyArtifactDigest: `sha256:${string}` | null;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_POLICY_BYTES = 32 * 1024;

function killed(): Cortex29ActionRuntime {
  return Object.freeze({ mode: "KILLED", policy: null, policyArtifactDigest: null });
}

export function readCortex29ActionRuntime(): Cortex29ActionRuntime {
  const raw = process.env.NEXUS_CORTEX_29_ACTION_POLICY_JSON;
  const expectedArtifact = process.env.NEXUS_CORTEX_29_ACTION_POLICY_ARTIFACT_DIGEST?.trim();
  const expectedSource = process.env.NEXUS_CORTEX_29_ACTION_POLICY_SOURCE_DIGEST?.trim();
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES || !expectedArtifact || !SHA256.test(expectedArtifact) || !expectedSource || !SHA256.test(expectedSource)) return killed();
  const artifact = `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}` as const;
  if (artifact !== expectedArtifact) return killed();
  try {
    const policy = parseFrictionActionPolicy(JSON.parse(raw) as unknown);
    if (policy.sourceDigest !== expectedSource) return killed();
    return Object.freeze({ mode: policy.mode, policy, policyArtifactDigest: artifact });
  } catch {
    return killed();
  }
}

export function sameCortex29ActionRuntime(left: Cortex29ActionRuntime, right: Cortex29ActionRuntime): boolean {
  return Boolean(
    left.policy
    && right.policy
    && left.policyArtifactDigest
    && right.policyArtifactDigest
    && left.mode === right.mode
    && left.policyArtifactDigest === right.policyArtifactDigest
    && left.policy.policyId === right.policy.policyId
    && left.policy.sourceDigest === right.policy.sourceDigest,
  );
}

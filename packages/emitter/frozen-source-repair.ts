import { createHash } from "node:crypto";
import type { ReferencePresentationPlan } from "./reference-presentation";

export interface FrozenSourceRepairResult {
  authority: "NEXUS_FROZEN_SOURCE_REPAIR_V1";
  source: string;
  mutationCount: number;
  evidenceIds: readonly string[];
  digest: `sha256:${string}`;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function applyFrozenReferenceSourceRepair(input: {
  source: string;
  plan: ReferencePresentationPlan;
  evidenceIds: readonly string[];
}): FrozenSourceRepairResult {
  if (!input.source.trim()) throw new Error("frozen source repair requires source text");
  if (input.plan.authority !== "NEXUS_REFERENCE_PRESENTATION_V1") throw new Error("frozen source repair requires a NEXUS reference presentation plan");
  if (!input.plan.freezePolicy.preserveUnlistedSurfaces) throw new Error("frozen source repair refuses a plan that does not preserve unlisted surfaces");
  const evidenceIds = [...new Set(input.evidenceIds.map((id) => id.trim()).filter(Boolean))];
  if (!evidenceIds.length || evidenceIds.length !== input.evidenceIds.length) throw new Error("frozen source repair requires unique traceable evidence ids");

  let source = input.source;
  let mutationCount = 0;
  if (!input.plan.rail.counter) {
    const ordinal = /\s*<span\s+className=["']service-index["']>[^<]*<\/span>/g;
    const matches = source.match(ordinal) ?? [];
    source = source.replace(ordinal, "");
    mutationCount += matches.length;
  }

  if (/className=["']service-index["']/.test(source)) throw new Error("forbidden service ordinal markup survived frozen source repair");
  if (mutationCount === 0) throw new Error("frozen source repair found no authorized source mutation to apply");

  const core = {
    authority: "NEXUS_FROZEN_SOURCE_REPAIR_V1" as const,
    source,
    mutationCount,
    evidenceIds: Object.freeze(evidenceIds),
  };
  return Object.freeze({ ...core, digest: sha256(JSON.stringify(core)) });
}

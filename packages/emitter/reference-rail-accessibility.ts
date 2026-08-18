import { createHash } from "node:crypto";
import type { ReferencePresentationPlan } from "./reference-presentation";

export interface ReferenceRailAccessibilityArtifact {
  authority: "NEXUS_REFERENCE_RAIL_ACCESSIBILITY_V1";
  jsx: string;
  evidenceIds: readonly string[];
  digest: `sha256:${string}`;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function augmentReferenceRailAccessibility(input: {
  jsx: string;
  plan: ReferencePresentationPlan;
  evidenceIds: readonly string[];
}): ReferenceRailAccessibilityArtifact {
  if (input.plan.authority !== "NEXUS_REFERENCE_PRESENTATION_V1" || input.plan.rail.mode !== "FOCUS_RAIL") throw new Error("reference rail accessibility requires a NEXUS focus-rail plan");
  const evidenceIds = [...new Set(input.evidenceIds.map((id) => id.trim()).filter(Boolean))];
  if (!evidenceIds.length || evidenceIds.length !== input.evidenceIds.length) throw new Error("reference rail accessibility requires unique traceable evidence ids");
  if (!input.jsx.includes('className="nexusReferenceRail"')) throw new Error("reference rail accessibility could not find the generated rail root");
  if (/tabIndex=/.test(input.jsx) || /role=["']region["']/.test(input.jsx)) throw new Error("reference rail accessibility refuses already-mutated rail markup");

  const jsx = input.jsx.replace('className="nexusReferenceRail"', 'className="nexusReferenceRail" role="region" tabIndex={0}');
  const core = { authority: "NEXUS_REFERENCE_RAIL_ACCESSIBILITY_V1" as const, jsx, evidenceIds: Object.freeze(evidenceIds) };
  return Object.freeze({ ...core, digest: sha256(JSON.stringify(core)) });
}

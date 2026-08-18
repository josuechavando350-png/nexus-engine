import { createHash } from "node:crypto";

export interface ViewportOverflowFinding {
  viewport: string;
  horizontalOverflowPx: number;
  evidenceIds: readonly string[];
}

export interface ViewportContainmentRepair {
  authority: "NEXUS_VIEWPORT_CONTAINMENT_REPAIR_V1";
  viewport: string;
  horizontalOverflowPx: number;
  css: "html,body{overflow-x:clip}";
  evidenceIds: readonly string[];
  digest: `sha256:${string}`;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function deriveViewportContainmentRepair(finding: ViewportOverflowFinding): ViewportContainmentRepair {
  const viewport = finding.viewport.trim();
  if (!viewport) throw new Error("viewport containment repair requires viewport evidence");
  if (!Number.isFinite(finding.horizontalOverflowPx) || finding.horizontalOverflowPx <= 0) {
    throw new Error("viewport containment repair requires a positive measured horizontal overflow");
  }
  const evidenceIds = [...new Set(finding.evidenceIds.map((id) => id.trim()).filter(Boolean))];
  if (!evidenceIds.length) throw new Error("viewport containment repair requires traceable evidence ids");
  if (evidenceIds.length !== finding.evidenceIds.length) throw new Error("viewport containment repair evidence ids must be unique non-empty values");

  const core = {
    authority: "NEXUS_VIEWPORT_CONTAINMENT_REPAIR_V1" as const,
    viewport,
    horizontalOverflowPx: Number(finding.horizontalOverflowPx.toFixed(3)),
    css: "html,body{overflow-x:clip}" as const,
    evidenceIds: Object.freeze(evidenceIds),
  };
  return Object.freeze({ ...core, digest: sha256(JSON.stringify(core)) });
}

import { digestValue } from "@nexus/visual-algebra";
import type { OriginalityEdge } from "./types.js";

function assertEdgeIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim() || value.length > 256 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`${label} must be a stable non-empty identifier`);
  }
}

export function createOriginalityEdge(leftId: string, rightId: string, weight: number): OriginalityEdge {
  assertEdgeIdentifier(leftId, "edge leftId");
  assertEdgeIdentifier(rightId, "edge rightId");
  if (leftId === rightId) throw new Error("Originality edge cannot be a self-loop");
  if (!Number.isFinite(weight) || weight < 0) throw new Error("Originality edge weight must be finite and non-negative");
  const [a, b] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  const base = Object.freeze({ a, b, weight });
  return Object.freeze({ ...base, edgeDigest: digestValue({ authority: "NEXUS_ORIGINALITY_EDGE_V1", ...base }) });
}

export function validateOriginalityEdge(edge: OriginalityEdge): void {
  if (!edge || typeof edge !== "object") throw new Error("Originality edge must be an object");
  const rebuilt = createOriginalityEdge(edge.a, edge.b, edge.weight);
  if (
    rebuilt.a !== edge.a
    || rebuilt.b !== edge.b
    || rebuilt.weight !== edge.weight
    || rebuilt.edgeDigest !== edge.edgeDigest
  ) {
    throw new Error("Originality edge digest/canonicalization mismatch");
  }
}

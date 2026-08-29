import { digestValue } from "@nexus/visual-algebra";
import type { OriginalityEdge } from "./types.js";

export function createOriginalityEdge(leftId: string, rightId: string, weight: number): OriginalityEdge {
  if (leftId === rightId) throw new Error("Originality edge cannot be a self-loop");
  if (!Number.isFinite(weight) || weight < 0) throw new Error("Originality edge weight must be finite and non-negative");
  const [a, b] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  const base = Object.freeze({ a, b, weight });
  return Object.freeze({ ...base, edgeDigest: digestValue({ authority: "NEXUS_ORIGINALITY_EDGE_V1", ...base }) });
}

import { digestValue } from "@nexus/visual-algebra";
import { validatePersistenceDiagram } from "./homology.js";
import type { PersistenceDiagram, PersistenceDimensionSummary, PersistenceInterval, TopologicalFingerprint } from "./types.js";

const EPSILON = 1e-12;
function observedLifetime(interval: PersistenceInterval, limit: number): number { return Math.max(0, (interval.death ?? limit) - interval.birth); }
function persistenceEntropy(lifetimes: readonly number[]): number {
  const positive = lifetimes.filter((value) => value > EPSILON); if (positive.length <= 1) return 0;
  const total = positive.reduce((sum, value) => sum + value, 0); if (total <= EPSILON) return 0;
  let entropy = 0; for (const lifetime of positive) { const p = lifetime / total; entropy -= p * Math.log2(p); }
  const max = Math.log2(positive.length); return max <= EPSILON ? 0 : Math.min(1, Math.max(0, entropy / max));
}
function dimensionSummary(diagram: PersistenceDiagram, dimension: 0 | 1): PersistenceDimensionSummary {
  const intervals = diagram.intervals.filter((item) => item.dimension === dimension);
  const lifetimes = intervals.map((item) => observedLifetime(item, diagram.filtrationLimit));
  const positive = lifetimes.filter((value) => value > EPSILON);
  return Object.freeze({
    dimension, intervalCount: intervals.length, essentialCount: intervals.filter((item) => item.death === null).length,
    positiveLifetimeCount: positive.length, totalPersistence: positive.reduce((sum, value) => sum + value, 0),
    maxPersistence: positive.length === 0 ? 0 : Math.max(...positive), entropy: persistenceEntropy(lifetimes),
  });
}
export function createTopologicalFingerprint(diagram: PersistenceDiagram): TopologicalFingerprint {
  validatePersistenceDiagram(diagram);
  const H0 = dimensionSummary(diagram, 0); const H1 = dimensionSummary(diagram, 1);
  const all = diagram.intervals.map((item) => observedLifetime(item, diagram.filtrationLimit)); const positive = all.filter((value) => value > EPSILON);
  const base = {
    authority: "NEXUS_TOPOLOGICAL_FINGERPRINT_V1" as const, sourceComplexDigest: diagram.sourceComplexDigest, sourceDiagramDigest: diagram.digest,
    componentCount: H0.essentialCount, cycleCount: H1.positiveLifetimeCount, totalPersistence: H0.totalPersistence + H1.totalPersistence,
    maxPersistence: positive.length === 0 ? 0 : Math.max(...positive), entropy: persistenceEntropy(all), H0, H1,
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}
export function compareTopologicalFingerprints(left: TopologicalFingerprint, right: TopologicalFingerprint): number {
  const a = [left.componentCount, left.cycleCount, left.totalPersistence, left.maxPersistence, left.entropy];
  const b = [right.componentCount, right.cycleCount, right.totalPersistence, right.maxPersistence, right.entropy];
  const scale = [Math.max(1, a[0]!, b[0]!), Math.max(1, a[1]!, b[1]!), Math.max(1, a[2]!, b[2]!), Math.max(1, a[3]!, b[3]!), 1];
  let squared = 0; for (let i = 0; i < a.length; i += 1) { const delta = (a[i]! - b[i]!) / scale[i]!; squared += delta * delta; }
  return 1 - Math.min(1, Math.sqrt(squared / a.length));
}

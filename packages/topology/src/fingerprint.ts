import { digestValue } from "@nexus/visual-algebra";
import { validatePersistenceDiagram } from "./homology.js";
import type {
  PersistenceDiagram,
  PersistenceDimensionSummary,
  PersistenceInterval,
  TopologicalFingerprint,
} from "./types.js";

const EPSILON = 1e-12;

function observedLifetime(interval: PersistenceInterval, limit: number): number {
  return Math.max(0, (interval.death ?? limit) - interval.birth);
}

function persistenceEntropy(lifetimes: readonly number[]): number {
  const positive = lifetimes.filter((value) => value > EPSILON);
  if (positive.length <= 1) return 0;
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= EPSILON) return 0;
  let entropy = 0;
  for (const lifetime of positive) {
    const p = lifetime / total;
    entropy -= p * Math.log2(p);
  }
  const max = Math.log2(positive.length);
  return max <= EPSILON ? 0 : Math.min(1, Math.max(0, entropy / max));
}

function dimensionSummary(diagram: PersistenceDiagram, dimension: 0 | 1): PersistenceDimensionSummary {
  const intervals = diagram.intervals.filter((item) => item.dimension === dimension);
  const lifetimes = intervals.map((item) => observedLifetime(item, diagram.filtrationLimit));
  const positive = lifetimes.filter((value) => value > EPSILON);
  return Object.freeze({
    dimension,
    intervalCount: intervals.length,
    essentialCount: intervals.filter((item) => item.death === null).length,
    positiveLifetimeCount: positive.length,
    totalPersistence: positive.reduce((sum, value) => sum + value, 0),
    maxPersistence: positive.length === 0 ? 0 : Math.max(...positive),
    entropy: persistenceEntropy(lifetimes),
  });
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

function assertUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be finite and in [0,1]`);
}

function validateSummary(summary: PersistenceDimensionSummary, dimension: 0 | 1, label: string): void {
  if (summary.dimension !== dimension) throw new Error(`${label}.dimension mismatch`);
  assertCount(summary.intervalCount, `${label}.intervalCount`);
  assertCount(summary.essentialCount, `${label}.essentialCount`);
  assertCount(summary.positiveLifetimeCount, `${label}.positiveLifetimeCount`);
  if (summary.essentialCount > summary.intervalCount || summary.positiveLifetimeCount > summary.intervalCount) {
    throw new Error(`${label} counts exceed intervalCount`);
  }
  assertNonNegativeFinite(summary.totalPersistence, `${label}.totalPersistence`);
  assertNonNegativeFinite(summary.maxPersistence, `${label}.maxPersistence`);
  assertUnit(summary.entropy, `${label}.entropy`);
  if (summary.maxPersistence > summary.totalPersistence + EPSILON) {
    throw new Error(`${label}.maxPersistence cannot exceed totalPersistence`);
  }
}

export function createTopologicalFingerprint(diagram: PersistenceDiagram): TopologicalFingerprint {
  validatePersistenceDiagram(diagram);
  const H0 = dimensionSummary(diagram, 0);
  const H1 = dimensionSummary(diagram, 1);
  const all = diagram.intervals.map((item) => observedLifetime(item, diagram.filtrationLimit));
  const positive = all.filter((value) => value > EPSILON);
  const base = {
    authority: "NEXUS_TOPOLOGICAL_FINGERPRINT_V1" as const,
    sourceComplexDigest: diagram.sourceComplexDigest,
    sourceDiagramDigest: diagram.digest,
    componentCount: H0.essentialCount,
    cycleCount: H1.positiveLifetimeCount,
    totalPersistence: H0.totalPersistence + H1.totalPersistence,
    maxPersistence: positive.length === 0 ? 0 : Math.max(...positive),
    entropy: persistenceEntropy(all),
    H0,
    H1,
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}

export function validateTopologicalFingerprint(fingerprint: TopologicalFingerprint): void {
  if (fingerprint.authority !== "NEXUS_TOPOLOGICAL_FINGERPRINT_V1") {
    throw new Error("Unsupported topological fingerprint authority");
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint.sourceComplexDigest)) {
    throw new Error("Topological fingerprint sourceComplexDigest must be SHA-256 hex");
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint.sourceDiagramDigest)) {
    throw new Error("Topological fingerprint sourceDiagramDigest must be SHA-256 hex");
  }
  assertCount(fingerprint.componentCount, "fingerprint.componentCount");
  assertCount(fingerprint.cycleCount, "fingerprint.cycleCount");
  assertNonNegativeFinite(fingerprint.totalPersistence, "fingerprint.totalPersistence");
  assertNonNegativeFinite(fingerprint.maxPersistence, "fingerprint.maxPersistence");
  assertUnit(fingerprint.entropy, "fingerprint.entropy");
  validateSummary(fingerprint.H0, 0, "fingerprint.H0");
  validateSummary(fingerprint.H1, 1, "fingerprint.H1");

  if (fingerprint.componentCount !== fingerprint.H0.essentialCount) {
    throw new Error("Topological fingerprint component count mismatch");
  }
  if (fingerprint.cycleCount !== fingerprint.H1.positiveLifetimeCount) {
    throw new Error("Topological fingerprint cycle count mismatch");
  }
  if (Math.abs(fingerprint.totalPersistence - (fingerprint.H0.totalPersistence + fingerprint.H1.totalPersistence)) > EPSILON) {
    throw new Error("Topological fingerprint total persistence mismatch");
  }
  if (Math.abs(fingerprint.maxPersistence - Math.max(fingerprint.H0.maxPersistence, fingerprint.H1.maxPersistence)) > EPSILON) {
    throw new Error("Topological fingerprint max persistence mismatch");
  }

  const { digest, ...payload } = fingerprint;
  if (!/^[a-f0-9]{64}$/.test(digest) || digestValue(payload) !== digest) {
    throw new Error("Topological fingerprint digest mismatch");
  }
}

export function compareTopologicalFingerprints(left: TopologicalFingerprint, right: TopologicalFingerprint): number {
  validateTopologicalFingerprint(left);
  validateTopologicalFingerprint(right);
  const a = [left.componentCount, left.cycleCount, left.totalPersistence, left.maxPersistence, left.entropy];
  const b = [right.componentCount, right.cycleCount, right.totalPersistence, right.maxPersistence, right.entropy];
  const scale = [
    Math.max(1, a[0]!, b[0]!),
    Math.max(1, a[1]!, b[1]!),
    Math.max(1, a[2]!, b[2]!),
    Math.max(1, a[3]!, b[3]!),
    1,
  ];
  let squared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = (a[i]! - b[i]!) / scale[i]!;
    squared += delta * delta;
  }
  return 1 - Math.min(1, Math.sqrt(squared / a.length));
}

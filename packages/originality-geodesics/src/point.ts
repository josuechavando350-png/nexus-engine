import { digestValue, verifyVisualAlgebraTerm } from "@nexus/visual-algebra";
import { projectToStructureFields } from "@nexus/visual-algebra";
import type { GeometricFingerprint, GeometricMetrics } from "@nexus/visual-algebra";
import { ORIGINALITY_METRICS } from "./constants.js";
import type { CreateOriginalityPointInput, OriginalityPoint, OriginalityPointFromFingerprintInput, OriginalityPointFromTermInput } from "./types.js";

function assertIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim() || value.length > 256 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`${label} must be a stable non-empty identifier`);
  }
}

function assertSubject(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("Originality point subject cannot be empty");
  if (value.length > 4_096) throw new Error("Originality point subject exceeds maximum length");
}

function assertTermDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Originality point termDigest must be SHA-256 hex");
}

export function validateGeometricMetrics(metrics: GeometricMetrics): void {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("Originality metrics must be a canonical object");
  }
  const prototype = Object.getPrototypeOf(metrics);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Originality metrics must be a plain object");
  }
  const expected = [...ORIGINALITY_METRICS].sort();
  const actual = Object.keys(metrics).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Originality metrics must contain exactly the eight canonical Visual Algebra metrics");
  }
  for (const metric of ORIGINALITY_METRICS) {
    const value = metrics[metric];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Originality metric ${metric} must be finite and normalized to [0,1]`);
    }
  }
}

function canonicalMetrics(metrics: GeometricMetrics): GeometricMetrics {
  validateGeometricMetrics(metrics);
  return Object.freeze(Object.fromEntries(
    ORIGINALITY_METRICS.map((metric) => [metric, metrics[metric]]),
  )) as unknown as GeometricMetrics;
}

export function createOriginalityPoint(input: CreateOriginalityPointInput): OriginalityPoint {
  assertIdentifier(input.pointId, "pointId");
  assertSubject(input.subject);
  assertTermDigest(input.termDigest);
  if (input.role !== "PROTECTED" && input.role !== "CONTEXT" && input.role !== "CANDIDATE") {
    throw new Error("Unsupported originality point role");
  }
  const normalizedMetrics = canonicalMetrics(input.metrics);

  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_POINT_V1" as const,
    version: 1 as const,
    pointId: input.pointId,
    role: input.role,
    subject: input.subject,
    termDigest: input.termDigest,
    metrics: normalizedMetrics,
  });
  return Object.freeze({ ...base, pointDigest: digestValue(base) });
}

export function originalityPointFromFingerprint(input: OriginalityPointFromFingerprintInput): OriginalityPoint {
  const fingerprint: GeometricFingerprint = input.fingerprint;
  if (!fingerprint || typeof fingerprint !== "object") throw new Error("Visual Algebra fingerprint must be an object");
  if (fingerprint.authority !== "NEXUS_VISUAL_ALGEBRA_V1") throw new Error("Unsupported Visual Algebra fingerprint authority");
  validateGeometricMetrics(fingerprint.metrics);
  if (digestValue(projectToStructureFields(fingerprint.metrics)) !== digestValue(fingerprint.structure)) {
    throw new Error("Visual Algebra fingerprint structure/metrics mismatch");
  }
  return createOriginalityPoint({
    pointId: input.pointId,
    role: input.role,
    subject: fingerprint.subject,
    termDigest: fingerprint.termDigest,
    metrics: fingerprint.metrics,
  });
}

export function originalityPointFromTerm(input: OriginalityPointFromTermInput): OriginalityPoint {
  verifyVisualAlgebraTerm(input.term);
  return createOriginalityPoint({
    pointId: input.pointId,
    role: input.role,
    subject: input.term.subject,
    termDigest: input.term.digest,
    metrics: input.term.metrics,
  });
}

export function validateOriginalityPoint(point: OriginalityPoint): void {
  if (!point || typeof point !== "object") throw new Error("Originality point must be an object");
  if (point.authority !== "NEXUS_ORIGINALITY_POINT_V1" || point.version !== 1) {
    throw new Error("Unsupported originality point authority/version");
  }
  const rebuilt = createOriginalityPoint({
    pointId: point.pointId,
    role: point.role,
    subject: point.subject,
    termDigest: point.termDigest,
    metrics: point.metrics,
  });
  if (rebuilt.pointDigest !== point.pointDigest || digestValue(rebuilt.metrics) !== digestValue(point.metrics)) {
    throw new Error("Originality point digest/canonicalization mismatch");
  }
}

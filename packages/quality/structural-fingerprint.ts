import type { DesignGenomeObservation } from "@nexus/capture/design-genome";
import { compareFingerprints, type StyleFingerprintV2 } from "@nexus/experience";
import type { VerdictState } from "@nexus/creative";

export interface StructuralFingerprintPolicy {
  maxCardReliance: number;
  maxGridRegularity: number;
  maxCenteredElementRatio: number;
  uniformRadiusSpreadPx: number;
  minimumRadiusSamples: number;
  bannedStructuralMarkers: readonly string[];
}

export interface StructuralFingerprintAttack {
  verdict: VerdictState;
  findings: readonly string[];
  evidence: readonly string[];
}

export interface StructuralFingerprintReport {
  authority: "NEXUS_STRUCTURAL_FINGERPRINT";
  templateFingerprint: StructuralFingerprintAttack;
  aiFingerprint: StructuralFingerprintAttack;
}

const DEFAULT_POLICY: StructuralFingerprintPolicy = Object.freeze({
  maxCardReliance: 0.72,
  maxGridRegularity: 0.78,
  maxCenteredElementRatio: 0.65,
  uniformRadiusSpreadPx: 1,
  minimumRadiusSamples: 4,
  bannedStructuralMarkers: Object.freeze([
    "centered hero",
    "four cards",
    "4 cards",
    "feature cards",
    "decorative numbering",
    "01/02/03",
    "01 02 03",
  ]),
});

function assertUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
}

function validatePolicy(policy: StructuralFingerprintPolicy): void {
  assertUnit(policy.maxCardReliance, "maxCardReliance");
  assertUnit(policy.maxGridRegularity, "maxGridRegularity");
  assertUnit(policy.maxCenteredElementRatio, "maxCenteredElementRatio");
  if (!Number.isFinite(policy.uniformRadiusSpreadPx) || policy.uniformRadiusSpreadPx < 0) throw new Error("uniformRadiusSpreadPx must be finite and non-negative");
  if (!Number.isInteger(policy.minimumRadiusSamples) || policy.minimumRadiusSamples < 2) throw new Error("minimumRadiusSamples must be an integer >= 2");
  if (!policy.bannedStructuralMarkers.length || policy.bannedStructuralMarkers.some((marker) => !marker.trim())) throw new Error("bannedStructuralMarkers must contain non-empty markers");
}

function frozenAttack(verdict: VerdictState, findings: string[], evidence: string[]): StructuralFingerprintAttack {
  return Object.freeze({ verdict, findings: Object.freeze(findings), evidence: Object.freeze(evidence) });
}

function evaluateTemplateFingerprint(
  fingerprint: StyleFingerprintV2,
  priorFingerprints: readonly StyleFingerprintV2[],
): StructuralFingerprintAttack {
  if (!priorFingerprints.length) {
    return frozenAttack("NOT_TESTED", ["no prior project fingerprint history is available for template regression"], []);
  }
  const reports = priorFingerprints.map((prior) => compareFingerprints(fingerprint, prior));
  const exact = reports.filter((report) => report.warnings.some((warning) => warning.startsWith("exact structural duplication")));
  if (exact.length) {
    return frozenAttack(
      "FAIL",
      exact.map((report) => `structural template duplication detected against ${report.right}`),
      exact.flatMap((report) => report.dimensions.filter((dimension) => dimension.score === 1).map((dimension) => `${report.right}:${dimension.dimension}:exact`)),
    );
  }
  return frozenAttack(
    "PASS",
    [],
    reports.map((report) => `${report.right}:compared:${report.dimensions.length}-dimensions`),
  );
}

function markerHaystack(fingerprint: StyleFingerprintV2): string {
  return [
    fingerprint.openingSignature,
    fingerprint.navigationSignature,
    ...fingerprint.ctaGrammar,
    ...fingerprint.geometryGrammar,
    ...fingerprint.mediaGrammar,
    ...fingerprint.motionGrammar,
    ...fingerprint.typographyHierarchy,
    fingerprint.notes ?? "",
  ].join(" | ").toLowerCase();
}

function evaluateAiStructuralFingerprint(
  fingerprint: StyleFingerprintV2,
  genomes: readonly DesignGenomeObservation[],
  policy: StructuralFingerprintPolicy,
): StructuralFingerprintAttack {
  if (!genomes.length) {
    return frozenAttack("NOT_TESTED", ["no measured Design Genome observations are available for structural fingerprint analysis"], []);
  }

  const findings: string[] = [];
  const evidence: string[] = [];
  const haystack = markerHaystack(fingerprint);
  for (const marker of policy.bannedStructuralMarkers) {
    if (haystack.includes(marker.trim().toLowerCase())) {
      findings.push(`explicit banned structural marker detected: ${marker}`);
      evidence.push(`marker:${marker}`);
    }
  }

  const genericCardGrid = fingerprint.structure.cardReliance >= policy.maxCardReliance
    && fingerprint.structure.gridRegularity >= policy.maxGridRegularity;
  if (genericCardGrid) {
    findings.push("high card reliance and grid regularity match the prohibited generic card-grid structure");
    evidence.push(`cardReliance:${fingerprint.structure.cardReliance}`, `gridRegularity:${fingerprint.structure.gridRegularity}`);
  }

  for (const genome of genomes) {
    if (genome.schemaVersion !== 1) throw new Error("unsupported Design Genome schemaVersion");
    const viewport = `${genome.viewport.width}x${genome.viewport.height}`;
    if (genome.layout.centeredElementRatio >= policy.maxCenteredElementRatio && genericCardGrid) {
      findings.push(`generic card-grid structure remains heavily centered at ${viewport}`);
      evidence.push(`${viewport}:centeredElementRatio:${genome.layout.centeredElementRatio}`);
    }
    const radii = genome.geometry.borderRadiusPx.filter((value) => Number.isFinite(value));
    if (radii.length >= policy.minimumRadiusSamples) {
      const spread = Math.max(...radii) - Math.min(...radii);
      if (spread <= policy.uniformRadiusSpreadPx && genericCardGrid) {
        findings.push(`generic card-grid structure repeats nearly identical radii at ${viewport}`);
        evidence.push(`${viewport}:radiusSpreadPx:${Number(spread.toFixed(3))}`);
      }
    }
  }

  return findings.length
    ? frozenAttack("FAIL", findings, evidence)
    : frozenAttack("PASS", [], genomes.map((genome) => `genome:${genome.viewport.width}x${genome.viewport.height}:measured`));
}

export function evaluateStructuralFingerprints(input: {
  fingerprint: StyleFingerprintV2;
  priorFingerprints: readonly StyleFingerprintV2[];
  genomes: readonly DesignGenomeObservation[];
  policy?: StructuralFingerprintPolicy;
}): StructuralFingerprintReport {
  const policy = input.policy ?? DEFAULT_POLICY;
  validatePolicy(policy);
  if (!input.fingerprint.subject.trim()) throw new Error("fingerprint subject is required");
  if (input.priorFingerprints.some((fingerprint) => !fingerprint.subject.trim())) throw new Error("prior fingerprint subject is required");
  return Object.freeze({
    authority: "NEXUS_STRUCTURAL_FINGERPRINT",
    templateFingerprint: evaluateTemplateFingerprint(input.fingerprint, input.priorFingerprints),
    aiFingerprint: evaluateAiStructuralFingerprint(input.fingerprint, input.genomes, policy),
  });
}

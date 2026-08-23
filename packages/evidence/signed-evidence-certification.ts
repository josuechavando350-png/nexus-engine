import type { KeyLike } from "node:crypto";
import { verifySignedEvidenceBundle, type EvidenceSource, type SignedEvidenceBundle } from "./index";

export type DeliveryGateName =
  | "creative"
  | "visual"
  | "red-team"
  | "repair"
  | "accessibility"
  | "browser"
  | "build";

export interface SignedEvidenceCertificationPolicy {
  requiredSources: readonly EvidenceSource[];
  requiredGates: readonly DeliveryGateName[];
}

export interface SignedEvidenceCertificationResult {
  authority: "NEXUS_SIGNED_EVIDENCE_CERTIFICATION";
  sourceRevision: string;
  tenantId: string;
  projectId: string;
  bundleId: string;
  certified: boolean;
  findings: readonly string[];
  verifiedGates: readonly DeliveryGateName[];
}

const BASELINE_REQUIRED_SOURCES = Object.freeze(["CAPTURE", "QUALITY"] as const satisfies readonly EvidenceSource[]);
const BASELINE_REQUIRED_GATES = Object.freeze([
  "creative",
  "visual",
  "red-team",
  "repair",
  "accessibility",
  "browser",
  "build",
] as const satisfies readonly DeliveryGateName[]);

const DEFAULT_POLICY: SignedEvidenceCertificationPolicy = Object.freeze({
  requiredSources: BASELINE_REQUIRED_SOURCES,
  requiredGates: BASELINE_REQUIRED_GATES,
});

function assertSourceRevision(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("delivery sourceRevision must be a full lowercase git SHA-1");
}

function unique<T extends string>(values: readonly T[], label: string): void {
  if (!values.length) throw new Error(`${label} cannot be empty`);
  if (new Set(values).size !== values.length) throw new Error(`${label} cannot contain duplicates`);
}

function assertPolicyCannotDowngrade(policy: SignedEvidenceCertificationPolicy): void {
  unique(policy.requiredSources, "delivery requiredSources");
  unique(policy.requiredGates, "delivery requiredGates");

  const sources = new Set<EvidenceSource>(policy.requiredSources);
  for (const source of BASELINE_REQUIRED_SOURCES) {
    if (!sources.has(source)) throw new Error(`delivery policy cannot remove baseline required source ${source}`);
  }

  const gates = new Set<DeliveryGateName>(policy.requiredGates);
  for (const gate of BASELINE_REQUIRED_GATES) {
    if (!gates.has(gate)) throw new Error(`delivery policy cannot remove baseline required gate ${gate}`);
  }
}

export function certifySignedEvidenceForDelivery(input: {
  signedEvidence: SignedEvidenceBundle;
  publicKey: KeyLike;
  sourceRevision: string;
  tenantId: string;
  projectId: string;
  policy?: SignedEvidenceCertificationPolicy;
}): SignedEvidenceCertificationResult {
  const policy = input.policy ?? DEFAULT_POLICY;
  assertSourceRevision(input.sourceRevision);
  if (!input.tenantId.trim() || !input.projectId.trim()) throw new Error("delivery tenantId and projectId are required");
  assertPolicyCannotDowngrade(policy);

  verifySignedEvidenceBundle(input.signedEvidence, input.publicKey);
  const bundle = input.signedEvidence.bundle;
  const findings: string[] = [];
  const verifiedGates: DeliveryGateName[] = [];

  if (bundle.scope.tenantId !== input.tenantId || bundle.scope.brandId !== input.projectId) {
    findings.push("signed evidence scope does not match requested tenant/project");
  }
  if (!bundle.complete) findings.push("signed evidence bundle is incomplete");

  const requiredInBundle = new Set(bundle.requiredSources);
  for (const source of policy.requiredSources) {
    if (!requiredInBundle.has(source)) findings.push(`signed bundle does not require source ${source}`);
  }

  const qualitySourceId = `quality:${input.sourceRevision}`;
  const qualityRecords = bundle.records.filter((record) => record.source === "QUALITY" && record.sourceId === qualitySourceId);
  if (qualityRecords.length !== 1) {
    findings.push(`expected exactly one verified QUALITY record bound to ${qualitySourceId}`);
  } else {
    const quality = qualityRecords[0]!;
    if (quality.integrity !== "VERIFIED" || quality.status !== "MEASURED") {
      findings.push("revision-bound QUALITY record is not verified measured evidence");
    } else {
      const sampleNames = new Set<string>();
      for (const sample of quality.samples) {
        if (sampleNames.has(sample.name)) {
          findings.push(`duplicate quality gate sample ${sample.name}`);
          continue;
        }
        sampleNames.add(sample.name);
      }
      for (const gate of policy.requiredGates) {
        const name = `gate.${gate}`;
        const samples = quality.samples.filter((sample) => sample.name === name);
        if (samples.length !== 1) {
          findings.push(`missing unique signed quality gate ${name}`);
          continue;
        }
        const sample = samples[0]!;
        if (sample.unit !== "boolean" || sample.value !== 1) {
          findings.push(`signed quality gate ${name} is not PASS`);
          continue;
        }
        verifiedGates.push(gate);
      }
    }
  }

  if (policy.requiredSources.includes("CAPTURE")) {
    const capturePrefix = `capture:${input.sourceRevision}:`;
    const revisionCaptures = bundle.records.filter((record) => record.source === "CAPTURE" && record.sourceId.startsWith(capturePrefix));
    const verifiedRevisionCaptures = revisionCaptures.filter((record) => record.integrity === "VERIFIED" && record.status === "MEASURED");
    if (!verifiedRevisionCaptures.length) findings.push(`no verified measured CAPTURE evidence is bound to ${input.sourceRevision}`);
    if (revisionCaptures.some((record) => record.integrity !== "VERIFIED" || record.status !== "MEASURED")) findings.push("revision-bound CAPTURE evidence contains unverified or non-measured records");
  }

  return Object.freeze({
    authority: "NEXUS_SIGNED_EVIDENCE_CERTIFICATION",
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    bundleId: bundle.bundleId,
    certified: findings.length === 0 && verifiedGates.length === policy.requiredGates.length,
    findings: Object.freeze(findings),
    verifiedGates: Object.freeze([...verifiedGates]),
  });
}

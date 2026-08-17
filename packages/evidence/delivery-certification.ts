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

export interface DeliveryCertificationPolicy {
  requiredSources: readonly EvidenceSource[];
  requiredGates: readonly DeliveryGateName[];
}

export interface DeliveryCertificationResult {
  authority: "NEXUS_DELIVERY_CERTIFICATION";
  sourceRevision: string;
  tenantId: string;
  projectId: string;
  bundleId: string;
  certified: boolean;
  findings: readonly string[];
  verifiedGates: readonly DeliveryGateName[];
}

const DEFAULT_POLICY: DeliveryCertificationPolicy = Object.freeze({
  requiredSources: Object.freeze(["CAPTURE", "QUALITY"] as const),
  requiredGates: Object.freeze(["creative", "visual", "red-team", "repair", "accessibility", "browser", "build"] as const),
});

function assertSourceRevision(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("delivery sourceRevision must be a full lowercase git SHA-1");
}

function unique<T extends string>(values: readonly T[], label: string): void {
  if (!values.length) throw new Error(`${label} cannot be empty`);
  if (new Set(values).size !== values.length) throw new Error(`${label} cannot contain duplicates`);
}

export function certifyDelivery(input: {
  signedEvidence: SignedEvidenceBundle;
  publicKey: KeyLike;
  sourceRevision: string;
  tenantId: string;
  projectId: string;
  policy?: DeliveryCertificationPolicy;
}): DeliveryCertificationResult {
  const policy = input.policy ?? DEFAULT_POLICY;
  assertSourceRevision(input.sourceRevision);
  if (!input.tenantId.trim() || !input.projectId.trim()) throw new Error("delivery tenantId and projectId are required");
  unique(policy.requiredSources, "delivery requiredSources");
  unique(policy.requiredGates, "delivery requiredGates");

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

  const capturePresent = bundle.records.some((record) => record.source === "CAPTURE" && record.integrity === "VERIFIED" && record.status === "MEASURED");
  if (policy.requiredSources.includes("CAPTURE") && !capturePresent) findings.push("no verified measured CAPTURE evidence is present");

  return Object.freeze({
    authority: "NEXUS_DELIVERY_CERTIFICATION",
    sourceRevision: input.sourceRevision,
    tenantId: input.tenantId,
    projectId: input.projectId,
    bundleId: bundle.bundleId,
    certified: findings.length === 0 && verifiedGates.length === policy.requiredGates.length,
    findings: Object.freeze(findings),
    verifiedGates: Object.freeze([...verifiedGates]),
  });
}

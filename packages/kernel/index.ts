export const NEXUS_KERNEL_CONTRACT_VERSION = "7.0.0" as const;

export const MATURITY_STATES = [
  "PLANNED",
  "EXPERIMENTAL",
  "IMPLEMENTED",
  "TESTED",
  "BENCHMARKED",
  "INTEGRATED",
  "OPERATIONALLY_EVIDENCED",
  "PRODUCTION_PROVEN"
] as const;

export type MaturityState = (typeof MATURITY_STATES)[number];

export const EVIDENCE_LEVELS = [
  "CLAIM",
  "SOURCE_INSPECTION",
  "STATIC_GATE",
  "UNIT_TEST",
  "INTEGRATION_TEST",
  "BENCHMARK_REPORT",
  "OPERATIONS_RECORD",
  "PRODUCTION_AUDIT"
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const FABRIC_DOMAINS = [
  "ENTERPRISE_ONTOLOGY",
  "CONNECTOR_FABRIC",
  "DECISION_MEMORY",
  "POLICY_GRAPH",
  "DURABLE_WORKFLOWS",
  "AGENT_GOVERNANCE",
  "EXECUTION_FABRIC",
  "EVIDENCE_PLANE",
  "OUTCOME_INTELLIGENCE",
  "IDENTITY",
  "MULTI_TENANCY"
] as const;

export type FabricDomain = (typeof FABRIC_DOMAINS)[number];

export function fabricDomainSlug(domain: FabricDomain): string {
  return domain.toLowerCase().replaceAll("_", "-");
}

export function contractIdFor(domain: FabricDomain): string {
  return `nexus.v7.${fabricDomainSlug(domain)}`;
}

export function contractEvidenceIdFor(domain: FabricDomain): string {
  return `ev.v7.${fabricDomainSlug(domain)}.contract`;
}

export interface KernelContractRef {
  readonly id: string;
  readonly version: typeof NEXUS_KERNEL_CONTRACT_VERSION;
  readonly domain: FabricDomain;
}

export interface TenantRef {
  readonly tenantId: string;
}

export interface PrincipalRef {
  readonly principalId: string;
  readonly tenantId: string;
}

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly level: EvidenceLevel;
  readonly source: string;
  readonly collectedAt: string;
}

export interface PolicyDecisionEnvelope {
  readonly decisionId: string;
  readonly tenant: TenantRef;
  readonly principal?: PrincipalRef;
  readonly decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
  readonly reasons: readonly string[];
  readonly evidence: readonly EvidenceRef[];
}

export interface FabricContractDescriptor {
  readonly contract: KernelContractRef;
  readonly maturity: MaturityState;
  readonly evidence: readonly EvidenceRef[];
  readonly adapterBoundary: "SPEC_ONLY" | "REPLACEABLE_ADAPTER" | "IMPLEMENTATION_BOUNDARY";
}

export const V7_FABRIC_CONTRACTS: readonly FabricContractDescriptor[] =
  FABRIC_DOMAINS.map((domain) => ({
    contract: {
      id: contractIdFor(domain),
      version: NEXUS_KERNEL_CONTRACT_VERSION,
      domain
    },
    maturity: "IMPLEMENTED",
    evidence: [
      {
        evidenceId: contractEvidenceIdFor(domain),
        level: "SOURCE_INSPECTION",
        source: "packages/kernel/index.ts",
        collectedAt: "2026-08-15T00:00:00.000Z"
      }
    ],
    adapterBoundary: "SPEC_ONLY"
  }));

export function isProductionProven(descriptor: FabricContractDescriptor): boolean {
  return descriptor.maturity === "PRODUCTION_PROVEN";
}

export function assertKernelRef(ref: KernelContractRef): KernelContractRef {
  if (!ref.id.startsWith("nexus.v7.")) {
    throw new Error("Kernel contract id must use the nexus.v7 namespace.");
  }

  if (ref.version !== NEXUS_KERNEL_CONTRACT_VERSION) {
    throw new Error("Kernel contract version is not supported by this package.");
  }

  if (!FABRIC_DOMAINS.includes(ref.domain)) {
    throw new Error("Kernel contract domain is not part of the V7 Fabric domain set.");
  }

  if (ref.id !== contractIdFor(ref.domain)) {
    throw new Error("Kernel contract id does not match its domain.");
  }

  return ref;
}

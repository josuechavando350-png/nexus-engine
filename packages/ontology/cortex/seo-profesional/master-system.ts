import type {
  ConnectedExactMatchOptimizationInput,
  ConnectedLandingEvaluation,
  ConnectedOfflineConversionInput,
} from "./connected-system.js";
import type { ExactMatchSynthesizerRunResult } from "./02-cazador-con-lupa/index.js";
import type {
  OfflineConversionUploadOptions,
  QualifiedOfflineConversionEngineResult,
  InvalidTrafficClickInput,
} from "./01-detector-de-trampas/index.js";
import {
  type DomainBirthOutreachRequest,
  type DomainBirthOutreachResult,
} from "./05-emboscador-de-nacimientos/index.js";
import type {
  ProcurementScanResult,
  ProcurementSourceConfig,
} from "./06-infiltrador-corporativo/index.js";
import type {
  GroundedStructuredDataArtifact,
  StructuredKnowledgePublishRequest,
} from "./07-recomendacion-de-dios/index.js";
import type {
  RevivalAssessment,
  RevivalCandidate,
  RevivalEnqueueRequest,
} from "./08-resucitador-de-muertos/index.js";
import {
  assertConnectedSeoProfessionalMasterTopology,
  SEO_PROFESSIONAL_MASTER_CONNECTIONS,
  SEO_PROFESSIONAL_MASTER_STRATEGIES,
} from "./master-topology.js";

export class SeoProfessionalMasterSystemError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SeoProfessionalMasterSystemError";
  }
}

export interface SeoProfessionalCoreIdentity {
  readonly googleAdsCustomerId: string;
  readonly offlineConversionProvider: string;
  readonly canonicalWebsiteOrigin: string;
}

export interface SeoProfessionalCorePort<TDecision, TLocalPresence> {
  snapshot(): SeoProfessionalCoreIdentity;
  assessLanding(input: InvalidTrafficClickInput): Promise<ConnectedLandingEvaluation<TDecision, TLocalPresence>>;
  recordQualifiedConversion(
    input: ConnectedOfflineConversionInput,
    options?: OfflineConversionUploadOptions,
  ): Promise<QualifiedOfflineConversionEngineResult>;
  optimizeExactMatches(input: ConnectedExactMatchOptimizationInput): Promise<ExactMatchSynthesizerRunResult>;
}

export interface DomainBirthOutreachPort {
  identity(): Readonly<{
    strategy: 5;
    provider: "WHATSAPP_CLOUD_API";
    senderWebsiteOrigin: string;
  }>;
  run(input: DomainBirthOutreachRequest): Promise<DomainBirthOutreachResult>;
}

export interface CorporateProcurementPort {
  identity(): Readonly<{
    strategy: 6;
    provider: "PUBLIC_PROCUREMENT_INTELLIGENCE";
    sellerWebsiteOrigin: string;
  }>;
  scan(input: ProcurementSourceConfig): Promise<ProcurementScanResult>;
}

export interface StructuredKnowledgePort {
  identity(): Readonly<{
    strategy: 7;
    provider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS";
    publisherWebsiteOrigin: string;
  }>;
  publish(input: StructuredKnowledgePublishRequest): Promise<GroundedStructuredDataArtifact>;
}

export interface PassiveRevivalIntelligencePort {
  identity(): Readonly<{
    strategy: 8;
    provider: "PASSIVE_TECH_ENRICHMENT_REDIS";
    queue: "REDIS_RESP2_LUA";
    operatorWebsiteOrigin: string;
  }>;
  assess(input: RevivalCandidate): Promise<RevivalAssessment>;
  enqueue(input: RevivalEnqueueRequest): Promise<string>;
}

export interface SeoProfessionalMasterSystemSnapshot {
  readonly googleAdsCustomerId: string;
  readonly offlineConversionProvider: string;
  readonly canonicalWebsiteOrigin: string;
  readonly domainBirthOutreachProvider: "WHATSAPP_CLOUD_API";
  readonly corporateProcurementProvider: "PUBLIC_PROCUREMENT_INTELLIGENCE";
  readonly structuredKnowledgeProvider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS";
  readonly revivalIntelligenceProvider: "PASSIVE_TECH_ENRICHMENT_REDIS";
  readonly revivalQueue: "REDIS_RESP2_LUA";
  readonly strategyNumbers: readonly [1, 2, 3, 4, 5, 6, 7, 8];
  readonly connectionCount: number;
  readonly connected: true;
}

function assertMethod(value: unknown, method: string, label: string): void {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new SeoProfessionalMasterSystemError("INVALID_CONFIG", `${label} is not a usable runtime dependency`);
  }
}

export class SeoProfessionalMasterSystem<TDecision, TLocalPresence> {
  private readonly core: SeoProfessionalCorePort<TDecision, TLocalPresence>;
  private readonly domainBirthOutreach: DomainBirthOutreachPort;
  private readonly corporateProcurement: CorporateProcurementPort;
  private readonly structuredKnowledge: StructuredKnowledgePort;
  private readonly revivalIntelligence: PassiveRevivalIntelligencePort;

  constructor(input: {
    readonly core: SeoProfessionalCorePort<TDecision, TLocalPresence>;
    readonly domainBirthOutreach: DomainBirthOutreachPort;
    readonly corporateProcurement: CorporateProcurementPort;
    readonly structuredKnowledge: StructuredKnowledgePort;
    readonly revivalIntelligence: PassiveRevivalIntelligencePort;
  }) {
    if (!input || typeof input !== "object") throw new SeoProfessionalMasterSystemError("INVALID_CONFIG", "SEO Profesional master system dependencies are required");
    assertConnectedSeoProfessionalMasterTopology();
    assertMethod(input.core, "snapshot", "core");
    assertMethod(input.core, "assessLanding", "core");
    assertMethod(input.core, "recordQualifiedConversion", "core");
    assertMethod(input.core, "optimizeExactMatches", "core");
    assertMethod(input.domainBirthOutreach, "identity", "domainBirthOutreach");
    assertMethod(input.domainBirthOutreach, "run", "domainBirthOutreach");
    assertMethod(input.corporateProcurement, "identity", "corporateProcurement");
    assertMethod(input.corporateProcurement, "scan", "corporateProcurement");
    assertMethod(input.structuredKnowledge, "identity", "structuredKnowledge");
    assertMethod(input.structuredKnowledge, "publish", "structuredKnowledge");
    assertMethod(input.revivalIntelligence, "identity", "revivalIntelligence");
    assertMethod(input.revivalIntelligence, "assess", "revivalIntelligence");
    assertMethod(input.revivalIntelligence, "enqueue", "revivalIntelligence");
    const coreIdentity = input.core.snapshot();
    const outreachIdentity = input.domainBirthOutreach.identity();
    const procurementIdentity = input.corporateProcurement.identity();
    const structuredKnowledgeIdentity = input.structuredKnowledge.identity();
    const revivalIdentity = input.revivalIntelligence.identity();
    if (outreachIdentity.strategy !== 5 || outreachIdentity.provider !== "WHATSAPP_CLOUD_API") {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "domainBirthOutreach must identify SEO strategy #5 on WhatsApp Cloud API");
    }
    if (outreachIdentity.senderWebsiteOrigin !== coreIdentity.canonicalWebsiteOrigin) {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "#5 sender website origin must match the #4 canonical local business origin");
    }
    if (procurementIdentity.strategy !== 6 || procurementIdentity.provider !== "PUBLIC_PROCUREMENT_INTELLIGENCE") {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "corporateProcurement must identify SEO strategy #6 on the public procurement intelligence boundary");
    }
    if (procurementIdentity.sellerWebsiteOrigin !== coreIdentity.canonicalWebsiteOrigin) {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "#6 seller website origin must match the #4 canonical local business origin");
    }
    if (structuredKnowledgeIdentity.strategy !== 7 || structuredKnowledgeIdentity.provider !== "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS") {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "structuredKnowledge must identify SEO strategy #7 on the verified semantic graph rich-results boundary");
    }
    if (structuredKnowledgeIdentity.publisherWebsiteOrigin !== coreIdentity.canonicalWebsiteOrigin) {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "#7 publisher website origin must match the #4 canonical local business origin");
    }
    if (revivalIdentity.strategy !== 8 || revivalIdentity.provider !== "PASSIVE_TECH_ENRICHMENT_REDIS" || revivalIdentity.queue !== "REDIS_RESP2_LUA") {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "revivalIntelligence must identify SEO strategy #8 on the passive technology enrichment Redis boundary");
    }
    if (revivalIdentity.operatorWebsiteOrigin !== coreIdentity.canonicalWebsiteOrigin) {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "#8 operator website origin must match the #4 canonical local business origin");
    }
    this.core = input.core;
    this.domainBirthOutreach = input.domainBirthOutreach;
    this.corporateProcurement = input.corporateProcurement;
    this.structuredKnowledge = input.structuredKnowledge;
    this.revivalIntelligence = input.revivalIntelligence;
  }

  snapshot(): SeoProfessionalMasterSystemSnapshot {
    const core = this.core.snapshot();
    return Object.freeze({
      googleAdsCustomerId: core.googleAdsCustomerId,
      offlineConversionProvider: core.offlineConversionProvider,
      canonicalWebsiteOrigin: core.canonicalWebsiteOrigin,
      domainBirthOutreachProvider: "WHATSAPP_CLOUD_API" as const,
      corporateProcurementProvider: "PUBLIC_PROCUREMENT_INTELLIGENCE" as const,
      structuredKnowledgeProvider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS" as const,
      revivalIntelligenceProvider: "PASSIVE_TECH_ENRICHMENT_REDIS" as const,
      revivalQueue: "REDIS_RESP2_LUA" as const,
      strategyNumbers: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8] as const),
      connectionCount: SEO_PROFESSIONAL_MASTER_CONNECTIONS.length,
      connected: true as const,
    });
  }

  assessLanding(input: InvalidTrafficClickInput): Promise<ConnectedLandingEvaluation<TDecision, TLocalPresence>> {
    return this.core.assessLanding(input);
  }

  recordQualifiedConversion(
    input: ConnectedOfflineConversionInput,
    options?: OfflineConversionUploadOptions,
  ): Promise<QualifiedOfflineConversionEngineResult> {
    return this.core.recordQualifiedConversion(input, options);
  }

  optimizeExactMatches(input: ConnectedExactMatchOptimizationInput): Promise<ExactMatchSynthesizerRunResult> {
    return this.core.optimizeExactMatches(input);
  }

  runDomainBirthOutreach(input: DomainBirthOutreachRequest): Promise<DomainBirthOutreachResult> {
    return this.domainBirthOutreach.run(input);
  }

  scanCorporateProcurement(input: ProcurementSourceConfig): Promise<ProcurementScanResult> {
    return this.corporateProcurement.scan(input);
  }

  publishStructuredKnowledge(input: StructuredKnowledgePublishRequest): Promise<GroundedStructuredDataArtifact> {
    return this.structuredKnowledge.publish(input);
  }

  assessRevivalCandidate(input: RevivalCandidate): Promise<RevivalAssessment> {
    return this.revivalIntelligence.assess(input);
  }

  enqueueRevivalCandidate(input: RevivalEnqueueRequest): Promise<string> {
    return this.revivalIntelligence.enqueue(input);
  }

  topology() {
    return Object.freeze({ strategies: SEO_PROFESSIONAL_MASTER_STRATEGIES, connections: SEO_PROFESSIONAL_MASTER_CONNECTIONS });
  }
}

export {
  ProcurementAsyncWorker,
  PublicProcurementIntelligenceEngine,
  PublicProcurementUrlPolicy,
  SqliteProcurementJobQueue,
} from "./06-infiltrador-corporativo/index.js";
export type {
  ProcurementResultSinkPort,
  ProcurementScanResult as SeoProfessionalProcurementScanResult,
  ProcurementSourceConfig as SeoProfessionalProcurementSourceConfig,
  ProcurementTenantProfile,
  PublicProcurementBrowserPort,
} from "./06-infiltrador-corporativo/index.js";
export {
  CanonicalSemanticGraphProvider,
  VerifiedStructuredKnowledgeEngine,
  VerifiedStructuredKnowledgeRuntime,
  verifyGroundedStructuredDataArtifact,
} from "./07-recomendacion-de-dios/index.js";
export type {
  GoogleRichResultFeature,
  GroundedRichResultRule,
  GroundedStructuredDataArtifact as SeoProfessionalGroundedStructuredDataArtifact,
  RenderedPageEvidence as SeoProfessionalRenderedPageEvidence,
  RenderedPageEvidencePort,
  SemanticGraphProviderPort,
  StructuredKnowledgePublishRequest as SeoProfessionalStructuredKnowledgePublishRequest,
} from "./07-recomendacion-de-dios/index.js";
export {
  NodePinnedHttpsTransport,
  PassivePublicSiteProbe,
  PassiveTechnologyRevivalEngine,
  PassiveTechnologyRevivalRuntime,
  RedisRespScriptClient,
  RedisRevivalJobQueue,
  RevivalAsyncWorker,
  fingerprintPublicTechnology,
} from "./08-resucitador-de-muertos/index.js";
export type {
  DetectedTechnology,
  PassivePublicSiteEvidence as SeoProfessionalPassivePublicSiteEvidence,
  RevivalAssessment as SeoProfessionalRevivalAssessment,
  RevivalAssessmentSinkPort,
  RevivalCandidate as SeoProfessionalRevivalCandidate,
  RevivalEnqueueRequest as SeoProfessionalRevivalEnqueueRequest,
  RevivalQueueJob,
  RevivalTenantProfile,
} from "./08-resucitador-de-muertos/index.js";

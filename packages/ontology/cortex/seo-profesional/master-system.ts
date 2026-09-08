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

export interface SeoProfessionalMasterSystemSnapshot {
  readonly googleAdsCustomerId: string;
  readonly offlineConversionProvider: string;
  readonly canonicalWebsiteOrigin: string;
  readonly domainBirthOutreachProvider: "WHATSAPP_CLOUD_API";
  readonly strategyNumbers: readonly [1, 2, 3, 4, 5];
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

  constructor(input: {
    readonly core: SeoProfessionalCorePort<TDecision, TLocalPresence>;
    readonly domainBirthOutreach: DomainBirthOutreachPort;
  }) {
    if (!input || typeof input !== "object") throw new SeoProfessionalMasterSystemError("INVALID_CONFIG", "SEO Profesional master system dependencies are required");
    assertConnectedSeoProfessionalMasterTopology();
    assertMethod(input.core, "snapshot", "core");
    assertMethod(input.core, "assessLanding", "core");
    assertMethod(input.core, "recordQualifiedConversion", "core");
    assertMethod(input.core, "optimizeExactMatches", "core");
    assertMethod(input.domainBirthOutreach, "identity", "domainBirthOutreach");
    assertMethod(input.domainBirthOutreach, "run", "domainBirthOutreach");
    const coreIdentity = input.core.snapshot();
    const outreachIdentity = input.domainBirthOutreach.identity();
    if (outreachIdentity.strategy !== 5 || outreachIdentity.provider !== "WHATSAPP_CLOUD_API") {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "domainBirthOutreach must identify SEO strategy #5 on WhatsApp Cloud API");
    }
    if (outreachIdentity.senderWebsiteOrigin !== coreIdentity.canonicalWebsiteOrigin) {
      throw new SeoProfessionalMasterSystemError("IDENTITY_MISMATCH", "#5 sender website origin must match the #4 canonical local business origin");
    }
    this.core = input.core;
    this.domainBirthOutreach = input.domainBirthOutreach;
  }

  snapshot(): SeoProfessionalMasterSystemSnapshot {
    const core = this.core.snapshot();
    return Object.freeze({
      googleAdsCustomerId: core.googleAdsCustomerId,
      offlineConversionProvider: core.offlineConversionProvider,
      canonicalWebsiteOrigin: core.canonicalWebsiteOrigin,
      domainBirthOutreachProvider: "WHATSAPP_CLOUD_API" as const,
      strategyNumbers: Object.freeze([1, 2, 3, 4, 5] as const),
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

  topology() {
    return Object.freeze({ strategies: SEO_PROFESSIONAL_MASTER_STRATEGIES, connections: SEO_PROFESSIONAL_MASTER_CONNECTIONS });
  }
}

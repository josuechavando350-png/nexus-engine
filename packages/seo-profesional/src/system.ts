import {
  SeoProfesionalCazadorConLupa as CazadorConLupa,
  SeoProfesionalDetectorDeTrampas as DetectorDeTrampas,
} from "@nexus/ontology";
import {
  personalizeAdContext,
  type AdPersonalizationDecision,
  type AdPersonalizationPolicy,
} from "@nexus/core/cortex/ad-context-edge-personalization";
import {
  assertConnectedSeoProfessionalTopology,
  SEO_PROFESSIONAL_CONNECTIONS,
  SEO_PROFESSIONAL_STRATEGIES,
} from "./topology.js";

type TrafficScorer = InstanceType<typeof DetectorDeTrampas.InvalidTrafficClickScorer>;
type OfflineConversionEngine = InstanceType<typeof DetectorDeTrampas.QualifiedOfflineConversionEngine>;
type ExactMatchEngine = InstanceType<typeof CazadorConLupa.ExactMatchSynthesizerEngine>;

type TrafficInput = Parameters<TrafficScorer["assess"]>[0];
type TrafficAssessment = Awaited<ReturnType<TrafficScorer["assess"]>>;
type OfflineCandidate = Parameters<OfflineConversionEngine["process"]>[0];
type OfflineOptions = Parameters<OfflineConversionEngine["process"]>[1];
type OfflineResult = Awaited<ReturnType<OfflineConversionEngine["process"]>>;
type ExactMatchRunRequest = Parameters<ExactMatchEngine["run"]>[0];
type ExactMatchRunResult = Awaited<ReturnType<ExactMatchEngine["run"]>>;

const CUSTOMER_ID = /^\d{5,20}$/u;

export class SeoProfessionalSystemError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "ATTRIBUTION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SeoProfessionalSystemError";
  }
}

export interface SeoProfessionalSystemDependencies {
  readonly googleAdsCustomerId: string;
  readonly maximumPersonalizationRiskScore: number;
  readonly trafficScorer: TrafficScorer;
  readonly offlineConversions: OfflineConversionEngine;
  readonly exactMatchSynthesizer: ExactMatchEngine;
  readonly personalizationPolicy: AdPersonalizationPolicy;
}

export interface ConnectedLandingEvaluation {
  readonly googleAdsCustomerId: string;
  readonly traffic: TrafficAssessment;
  readonly personalization: AdPersonalizationDecision;
  readonly personalizationSuppressedByTrafficRisk: boolean;
  readonly strategyTrace: readonly [1, 3];
}

export type ConnectedOfflineConversionInput = Omit<OfflineCandidate, "invalidTrafficScore"> & {
  readonly landing: ConnectedLandingEvaluation;
};

export type ConnectedExactMatchOptimizationInput = Omit<ExactMatchRunRequest, "customerId">;

export interface SeoProfessionalSystemSnapshot {
  readonly googleAdsCustomerId: string;
  readonly strategyNumbers: readonly [1, 2, 3];
  readonly connectionCount: number;
  readonly connected: true;
}

function normalizedCustomerId(value: string): string {
  if (typeof value !== "string") throw new SeoProfessionalSystemError("INVALID_CONFIG", "googleAdsCustomerId must be a string");
  const normalized = value.replaceAll("-", "").trim();
  if (!CUSTOMER_ID.test(normalized)) throw new SeoProfessionalSystemError("INVALID_CONFIG", "googleAdsCustomerId is malformed");
  return normalized;
}

function boundedRisk(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", "maximumPersonalizationRiskScore must be an integer from 0 to 1000");
  }
  return value;
}

function withoutAcquisitionContext(value: TrafficInput["url"]): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  url.search = "";
  return url;
}

function assertTrafficAssessmentIntegrity(assessment: TrafficAssessment): void {
  if (!assessment || typeof assessment !== "object") throw new SeoProfessionalSystemError("INVALID_INPUT", "landing traffic assessment is missing");
  const payload = assessment.envelope?.payload;
  if (!payload || payload.assessmentId !== assessment.assessmentId || payload.assessedAt !== assessment.assessedAt || payload.expiresAt !== assessment.expiresAt || payload.riskScore !== assessment.riskScore) {
    throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "landing traffic assessment does not match its signed envelope payload");
  }
}

function assertRuntimeDependency(value: unknown, method: string, label: string): void {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", `${label} is not a usable runtime dependency`);
  }
}

export class ConnectedSeoProfessionalSystem {
  private readonly googleAdsCustomerId: string;
  private readonly maximumPersonalizationRiskScore: number;
  private readonly trafficScorer: TrafficScorer;
  private readonly offlineConversions: OfflineConversionEngine;
  private readonly exactMatchSynthesizer: ExactMatchEngine;
  private readonly personalizationPolicy: AdPersonalizationPolicy;

  constructor(dependencies: SeoProfessionalSystemDependencies) {
    if (!dependencies || typeof dependencies !== "object") throw new SeoProfessionalSystemError("INVALID_CONFIG", "SEO Profesional system dependencies are required");
    assertConnectedSeoProfessionalTopology();
    this.googleAdsCustomerId = normalizedCustomerId(dependencies.googleAdsCustomerId);
    this.maximumPersonalizationRiskScore = boundedRisk(dependencies.maximumPersonalizationRiskScore);
    assertRuntimeDependency(dependencies.trafficScorer, "assess", "trafficScorer");
    assertRuntimeDependency(dependencies.offlineConversions, "process", "offlineConversions");
    assertRuntimeDependency(dependencies.exactMatchSynthesizer, "run", "exactMatchSynthesizer");
    if (!dependencies.personalizationPolicy || typeof dependencies.personalizationPolicy !== "object") {
      throw new SeoProfessionalSystemError("INVALID_CONFIG", "personalizationPolicy is required");
    }
    this.trafficScorer = dependencies.trafficScorer;
    this.offlineConversions = dependencies.offlineConversions;
    this.exactMatchSynthesizer = dependencies.exactMatchSynthesizer;
    this.personalizationPolicy = dependencies.personalizationPolicy;
  }

  snapshot(): SeoProfessionalSystemSnapshot {
    return Object.freeze({
      googleAdsCustomerId: this.googleAdsCustomerId,
      strategyNumbers: Object.freeze([1, 2, 3] as const),
      connectionCount: SEO_PROFESSIONAL_CONNECTIONS.length,
      connected: true as const,
    });
  }

  async assessLanding(input: TrafficInput): Promise<ConnectedLandingEvaluation> {
    const traffic = await this.trafficScorer.assess(input);
    assertTrafficAssessmentIntegrity(traffic);
    const personalizationSuppressedByTrafficRisk = traffic.riskScore > this.maximumPersonalizationRiskScore;
    const personalization = personalizeAdContext(
      personalizationSuppressedByTrafficRisk ? withoutAcquisitionContext(input.url) : input.url,
      this.personalizationPolicy,
    );
    return Object.freeze({
      googleAdsCustomerId: this.googleAdsCustomerId,
      traffic,
      personalization,
      personalizationSuppressedByTrafficRisk,
      strategyTrace: Object.freeze([1, 3] as const),
    });
  }

  async recordQualifiedConversion(
    input: ConnectedOfflineConversionInput,
    options?: OfflineOptions,
  ): Promise<OfflineResult> {
    if (!input || typeof input !== "object") throw new SeoProfessionalSystemError("INVALID_INPUT", "connected offline conversion input is required");
    const landing = input.landing;
    if (!landing || landing.googleAdsCustomerId !== this.googleAdsCustomerId) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "landing belongs to a different Google Ads customer");
    }
    assertTrafficAssessmentIntegrity(landing.traffic);
    if (!landing.traffic.hasGoogleClickId || landing.traffic.googleClickIdKind === null) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "landing has no single verified Google click identifier kind");
    }
    if (!input.clickId || input.clickId.kind !== landing.traffic.googleClickIdKind) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "conversion click identifier kind does not match the landing assessment");
    }

    const candidate: OfflineCandidate = {
      leadId: input.leadId,
      occurredAt: input.occurredAt,
      stage: input.stage,
      conversionValue: input.conversionValue,
      currencyCode: input.currencyCode,
      invalidTrafficScore: landing.traffic.riskScore,
      clickId: input.clickId,
      adUserDataConsent: input.adUserDataConsent,
    };
    return this.offlineConversions.process(candidate, options);
  }

  async optimizeExactMatches(input: ConnectedExactMatchOptimizationInput): Promise<ExactMatchRunResult> {
    if (!input || typeof input !== "object") throw new SeoProfessionalSystemError("INVALID_INPUT", "exact-match optimization input is required");
    const request = {
      ...input,
      customerId: this.googleAdsCustomerId,
    } as ExactMatchRunRequest;
    return this.exactMatchSynthesizer.run(request);
  }

  topology() {
    return Object.freeze({
      strategies: SEO_PROFESSIONAL_STRATEGIES,
      connections: SEO_PROFESSIONAL_CONNECTIONS,
    });
  }
}

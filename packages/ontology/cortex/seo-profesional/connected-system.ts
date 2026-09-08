import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IdentifiedQualifiedOfflineConversionEngine,
  InvalidTrafficClickScorer,
  type GoogleClickId,
  type GoogleClickIdKind,
  type InvalidTrafficAssessment,
  type InvalidTrafficClickInput,
  type OfflineConversionCandidate,
  type OfflineConversionProvider,
  type OfflineConversionUploadOptions,
  type QualifiedOfflineConversionEngineResult,
} from "./01-detector-de-trampas/index.js";
import {
  ExactMatchSynthesizerEngine,
  type ExactMatchSynthesizerRunRequest,
  type ExactMatchSynthesizerRunResult,
} from "./02-cazador-con-lupa/index.js";
import {
  assertConnectedSeoProfessionalTopology,
  SEO_PROFESSIONAL_CONNECTIONS,
  SEO_PROFESSIONAL_STRATEGIES,
} from "./topology.js";

const CUSTOMER_ID = /^\d{5,20}$/u;
const ASSESSMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/u;
const DEFAULT_ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export class SeoProfessionalSystemError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "ATTRIBUTION_MISMATCH" | "ATTRIBUTION_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "SeoProfessionalSystemError";
  }
}

export interface CamaleonWebPort<TDecision> {
  resolve(input: URL | string): TDecision | Promise<TDecision>;
}

export interface LocalPresencePort<TLocalPresence> {
  canonicalWebsiteOrigin(): string;
  snapshot(): TLocalPresence;
}

export interface SeoProfessionalSystemDependencies<TDecision, TLocalPresence> {
  readonly googleAdsCustomerId: string;
  readonly maximumPersonalizationRiskScore: number;
  readonly attributionSecret: string;
  readonly attributionTtlMs?: number;
  readonly now?: () => number;
  readonly trafficScorer: InvalidTrafficClickScorer;
  readonly offlineConversions: IdentifiedQualifiedOfflineConversionEngine;
  readonly exactMatchSynthesizer: ExactMatchSynthesizerEngine;
  readonly camaleonWeb: CamaleonWebPort<TDecision>;
  readonly localPresence: LocalPresencePort<TLocalPresence>;
}

export interface ConnectedAttributionPayload {
  readonly schemaVersion: 1;
  readonly assessmentId: string;
  readonly googleAdsCustomerId: string;
  readonly riskScore: number;
  readonly clickIdKind: GoogleClickIdKind;
  readonly clickIdDigest: `sha256:${string}`;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ConnectedAttributionReceipt {
  readonly payload: ConnectedAttributionPayload;
  readonly signature: `sha256=${string}`;
}

export interface ConnectedLandingEvaluation<TDecision, TLocalPresence> {
  readonly googleAdsCustomerId: string;
  readonly canonicalWebsiteOrigin: string;
  readonly localPresence: TLocalPresence;
  readonly traffic: InvalidTrafficAssessment;
  readonly personalization: TDecision;
  readonly personalizationSuppressedByTrafficRisk: boolean;
  readonly attribution: ConnectedAttributionReceipt | null;
  readonly strategyTrace: readonly [4, 1, 3, 4];
}

export type ConnectedOfflineConversionInput = Omit<OfflineConversionCandidate, "invalidTrafficScore"> & {
  readonly attribution: ConnectedAttributionReceipt;
};

export type ConnectedExactMatchOptimizationInput = Omit<ExactMatchSynthesizerRunRequest, "customerId">;

export interface SeoProfessionalSystemSnapshot {
  readonly googleAdsCustomerId: string;
  readonly offlineConversionProvider: OfflineConversionProvider;
  readonly canonicalWebsiteOrigin: string;
  readonly strategyNumbers: readonly [1, 2, 3, 4];
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

function attributionSecret(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4_096) {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", "attributionSecret must contain 32..4096 characters");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new SeoProfessionalSystemError("INVALID_CONFIG", "attributionSecret contains a control character");
  }
  return value;
}

function boundedAttributionTtl(value: number | undefined): number {
  const resolved = value ?? DEFAULT_ATTRIBUTION_TTL_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 60_000 || resolved > MAX_ATTRIBUTION_TTL_MS) {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", "attributionTtlMs must be between 1 minute and 90 days");
  }
  return resolved;
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new SeoProfessionalSystemError("INVALID_INPUT", "clock returned a non-finite timestamp");
  return value;
}

function withoutAcquisitionContext(value: InvalidTrafficClickInput["url"]): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  url.search = "";
  return url;
}

function absoluteUrl(value: InvalidTrafficClickInput["url"]): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) {
    throw new SeoProfessionalSystemError("INVALID_INPUT", "landing URL is malformed or unsupported");
  }
  return url;
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") throw new SeoProfessionalSystemError("INVALID_CONFIG", "localPresence canonical website origin must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", "localPresence canonical website origin is malformed");
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new SeoProfessionalSystemError("INVALID_CONFIG", "localPresence canonical website origin must be an http(s) origin");
  }
  return url.origin;
}

function assertTrafficAssessmentIntegrity(assessment: InvalidTrafficAssessment): void {
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function clickDigest(secret: string, clickId: GoogleClickId): `sha256:${string}` {
  return `sha256:${createHmac("sha256", secret).update(`click\0${clickId.kind}\0${clickId.value}`, "utf8").digest("hex")}`;
}

function receiptSignature(secret: string, payload: ConnectedAttributionPayload): `sha256=${string}` {
  return `sha256=${createHmac("sha256", secret).update(`receipt\0${canonical(payload)}`, "utf8").digest("hex")}`;
}

function canonicalUtc(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", `${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", `${label} must be canonical UTC`);
  return value;
}

function parseReceiptPayload(value: unknown): ConnectedAttributionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution payload must be a plain object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "assessmentId,clickIdDigest,clickIdKind,expiresAt,googleAdsCustomerId,issuedAt,riskScore,schemaVersion") {
    throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution payload contains missing or unsupported fields");
  }
  if (raw.schemaVersion !== 1) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "unsupported attribution schema version");
  if (typeof raw.assessmentId !== "string" || !ASSESSMENT_ID.test(raw.assessmentId)) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution assessmentId is malformed");
  if (typeof raw.googleAdsCustomerId !== "string" || !CUSTOMER_ID.test(raw.googleAdsCustomerId)) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution customer id is malformed");
  if (!Number.isInteger(raw.riskScore) || (raw.riskScore as number) < 0 || (raw.riskScore as number) > 1_000) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution risk score is malformed");
  if (!(raw.clickIdKind === "gclid" || raw.clickIdKind === "gbraid" || raw.clickIdKind === "wbraid")) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution click id kind is malformed");
  if (typeof raw.clickIdDigest !== "string" || !SHA256.test(raw.clickIdDigest)) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution click digest is malformed");
  const issuedAt = canonicalUtc(raw.issuedAt, "attribution issuedAt");
  const expiresAt = canonicalUtc(raw.expiresAt, "attribution expiresAt");
  return Object.freeze({
    schemaVersion: 1,
    assessmentId: raw.assessmentId,
    googleAdsCustomerId: raw.googleAdsCustomerId,
    riskScore: raw.riskScore as number,
    clickIdKind: raw.clickIdKind,
    clickIdDigest: raw.clickIdDigest as `sha256:${string}`,
    issuedAt,
    expiresAt,
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function extractVerifiedClickId(urlInput: InvalidTrafficClickInput["url"], assessment: InvalidTrafficAssessment): GoogleClickId | null {
  const kind = assessment.googleClickIdKind;
  if (!assessment.hasGoogleClickId || kind === null) return null;
  const values = absoluteUrl(urlInput).searchParams.getAll(kind);
  if (values.length !== 1 || !values[0]) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "verified click identifier is not singular on the landing URL");
  return Object.freeze({ kind, value: values[0] } as GoogleClickId);
}

export class ConnectedSeoProfessionalSystem<TDecision, TLocalPresence> {
  private readonly googleAdsCustomerId: string;
  private readonly offlineConversionProvider: OfflineConversionProvider;
  private readonly canonicalWebsiteOriginValue: string;
  private readonly maximumPersonalizationRiskScore: number;
  private readonly attributionSigningSecret: string;
  private readonly attributionTtlMs: number;
  private readonly now: () => number;
  private readonly trafficScorer: InvalidTrafficClickScorer;
  private readonly offlineConversions: IdentifiedQualifiedOfflineConversionEngine;
  private readonly exactMatchSynthesizer: ExactMatchSynthesizerEngine;
  private readonly camaleonWeb: CamaleonWebPort<TDecision>;
  private readonly localPresence: LocalPresencePort<TLocalPresence>;

  constructor(dependencies: SeoProfessionalSystemDependencies<TDecision, TLocalPresence>) {
    if (!dependencies || typeof dependencies !== "object") throw new SeoProfessionalSystemError("INVALID_CONFIG", "SEO Profesional system dependencies are required");
    assertConnectedSeoProfessionalTopology();
    this.googleAdsCustomerId = normalizedCustomerId(dependencies.googleAdsCustomerId);
    this.maximumPersonalizationRiskScore = boundedRisk(dependencies.maximumPersonalizationRiskScore);
    this.attributionSigningSecret = attributionSecret(dependencies.attributionSecret);
    this.attributionTtlMs = boundedAttributionTtl(dependencies.attributionTtlMs);
    this.now = dependencies.now ?? Date.now;
    assertRuntimeDependency(dependencies.trafficScorer, "assess", "trafficScorer");
    assertRuntimeDependency(dependencies.offlineConversions, "process", "offlineConversions");
    assertRuntimeDependency(dependencies.offlineConversions, "destinationIdentity", "offlineConversions");
    assertRuntimeDependency(dependencies.exactMatchSynthesizer, "run", "exactMatchSynthesizer");
    assertRuntimeDependency(dependencies.camaleonWeb, "resolve", "camaleonWeb");
    assertRuntimeDependency(dependencies.localPresence, "canonicalWebsiteOrigin", "localPresence");
    assertRuntimeDependency(dependencies.localPresence, "snapshot", "localPresence");
    const offlineIdentity = dependencies.offlineConversions.destinationIdentity();
    if (offlineIdentity.googleAdsCustomerId !== this.googleAdsCustomerId) {
      throw new SeoProfessionalSystemError("INVALID_CONFIG", "offline conversion destination must match googleAdsCustomerId");
    }
    this.offlineConversionProvider = offlineIdentity.provider;
    this.canonicalWebsiteOriginValue = canonicalOrigin(dependencies.localPresence.canonicalWebsiteOrigin());
    this.trafficScorer = dependencies.trafficScorer;
    this.offlineConversions = dependencies.offlineConversions;
    this.exactMatchSynthesizer = dependencies.exactMatchSynthesizer;
    this.camaleonWeb = dependencies.camaleonWeb;
    this.localPresence = dependencies.localPresence;
  }

  snapshot(): SeoProfessionalSystemSnapshot {
    return Object.freeze({
      googleAdsCustomerId: this.googleAdsCustomerId,
      offlineConversionProvider: this.offlineConversionProvider,
      canonicalWebsiteOrigin: this.canonicalWebsiteOriginValue,
      strategyNumbers: Object.freeze([1, 2, 3, 4] as const),
      connectionCount: SEO_PROFESSIONAL_CONNECTIONS.length,
      connected: true as const,
    });
  }

  async assessLanding(input: InvalidTrafficClickInput): Promise<ConnectedLandingEvaluation<TDecision, TLocalPresence>> {
    const landingUrl = absoluteUrl(input.url);
    if (landingUrl.origin !== this.canonicalWebsiteOriginValue) {
      throw new SeoProfessionalSystemError("INVALID_INPUT", "landing origin does not match the canonical local business website");
    }
    const localPresence = this.localPresence.snapshot();
    const traffic = await this.trafficScorer.assess(input);
    assertTrafficAssessmentIntegrity(traffic);
    const personalizationSuppressedByTrafficRisk = traffic.riskScore > this.maximumPersonalizationRiskScore;
    const personalization = await this.camaleonWeb.resolve(
      personalizationSuppressedByTrafficRisk ? withoutAcquisitionContext(input.url) : input.url,
    );
    const clickId = extractVerifiedClickId(input.url, traffic);
    const nowMs = currentTime(this.now);
    const attribution = clickId === null ? null : this.createAttributionReceipt(traffic, clickId, nowMs);
    return Object.freeze({
      googleAdsCustomerId: this.googleAdsCustomerId,
      canonicalWebsiteOrigin: this.canonicalWebsiteOriginValue,
      localPresence,
      traffic,
      personalization,
      personalizationSuppressedByTrafficRisk,
      attribution,
      strategyTrace: Object.freeze([4, 1, 3, 4] as const),
    });
  }

  async recordQualifiedConversion(
    input: ConnectedOfflineConversionInput,
    options?: OfflineConversionUploadOptions,
  ): Promise<QualifiedOfflineConversionEngineResult> {
    if (!input || typeof input !== "object") throw new SeoProfessionalSystemError("INVALID_INPUT", "connected offline conversion input is required");
    if (!input.clickId || typeof input.clickId !== "object") throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "conversion click identifier is required");
    const attribution = this.verifyAttributionReceipt(input.attribution, currentTime(this.now));
    if (attribution.googleAdsCustomerId !== this.googleAdsCustomerId) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution belongs to a different Google Ads customer");
    if (input.clickId.kind !== attribution.clickIdKind) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "conversion click identifier kind does not match attribution");
    if (!safeEqual(clickDigest(this.attributionSigningSecret, input.clickId), attribution.clickIdDigest)) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "conversion click identifier does not match attribution");
    }

    const candidate: OfflineConversionCandidate = {
      leadId: input.leadId,
      occurredAt: input.occurredAt,
      stage: input.stage,
      conversionValue: input.conversionValue,
      currencyCode: input.currencyCode,
      invalidTrafficScore: attribution.riskScore,
      clickId: input.clickId,
      adUserDataConsent: input.adUserDataConsent,
    };
    return this.offlineConversions.process(candidate, options);
  }

  async optimizeExactMatches(input: ConnectedExactMatchOptimizationInput): Promise<ExactMatchSynthesizerRunResult> {
    if (!input || typeof input !== "object") throw new SeoProfessionalSystemError("INVALID_INPUT", "exact-match optimization input is required");
    return this.exactMatchSynthesizer.run({
      ...input,
      customerId: this.googleAdsCustomerId,
    });
  }

  topology() {
    return Object.freeze({
      strategies: SEO_PROFESSIONAL_STRATEGIES,
      connections: SEO_PROFESSIONAL_CONNECTIONS,
    });
  }

  private createAttributionReceipt(assessment: InvalidTrafficAssessment, clickId: GoogleClickId, nowMs: number): ConnectedAttributionReceipt {
    const payload: ConnectedAttributionPayload = Object.freeze({
      schemaVersion: 1,
      assessmentId: assessment.assessmentId,
      googleAdsCustomerId: this.googleAdsCustomerId,
      riskScore: assessment.riskScore,
      clickIdKind: clickId.kind,
      clickIdDigest: clickDigest(this.attributionSigningSecret, clickId),
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.attributionTtlMs).toISOString(),
    });
    return Object.freeze({ payload, signature: receiptSignature(this.attributionSigningSecret, payload) });
  }

  private verifyAttributionReceipt(receipt: ConnectedAttributionReceipt, nowMs: number): ConnectedAttributionPayload {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.getPrototypeOf(receipt) !== Object.prototype) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution receipt must be a plain object");
    }
    const raw = receipt as unknown as Record<string, unknown>;
    if (Object.keys(raw).sort().join(",") !== "payload,signature" || typeof raw.signature !== "string" || !SIGNATURE.test(raw.signature)) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution receipt contract is invalid");
    }
    const payload = parseReceiptPayload(raw.payload);
    const expected = receiptSignature(this.attributionSigningSecret, payload);
    if (!safeEqual(expected, raw.signature)) throw new SeoProfessionalSystemError("ATTRIBUTION_MISMATCH", "attribution signature mismatch");
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > this.attributionTtlMs || nowMs < issuedAt || nowMs > expiresAt) {
      throw new SeoProfessionalSystemError("ATTRIBUTION_EXPIRED", "attribution receipt is expired or outside its configured lifetime");
    }
    return payload;
  }
}

import type { DomainDnsSnapshot } from "./dns-intelligence.js";
import type { RdapDomainRecord, RdapLookupResult } from "./rdap-client.js";
import { normalizeDomainName } from "./rdap-client.js";
import {
  buildWhatsAppTemplatePayload,
  type WhatsAppConsentEvidence,
  type WhatsAppSendReceipt,
  type WhatsAppTemplatePayload,
  WhatsAppCloudApiClient,
} from "./whatsapp-cloud.js";

const DEFAULT_MAXIMUM_DOMAIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAXIMUM_SUPPORTED_DOMAIN_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;

export type DomainBirthClassification =
  | "NEWLY_REGISTERED_ACTIVE"
  | "NEWLY_REGISTERED_INACTIVE"
  | "ESTABLISHED"
  | "NOT_REGISTERED"
  | "UNKNOWN_AGE";

export interface RdapDomainLookupPort {
  lookupDomain(domain: string): Promise<RdapLookupResult>;
}

export interface DnsDomainIntelligencePort {
  inspect(domain: string): Promise<DomainDnsSnapshot>;
}

export interface DomainBirthAssessment {
  readonly domain: string;
  readonly classification: DomainBirthClassification;
  readonly ageMs: number | null;
  readonly registeredAt: string | null;
  readonly rdap: RdapDomainRecord | null;
  readonly dns: DomainDnsSnapshot | null;
  readonly eligibleForConsentedOutreach: boolean;
}

export interface DomainBirthIntelligenceConfig {
  readonly rdap: RdapDomainLookupPort;
  readonly dns: DnsDomainIntelligencePort;
  readonly maximumDomainAgeMs?: number;
  readonly requireDnsActivation?: boolean;
  readonly now?: () => number;
}

export class DomainBirthIntelligenceError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "INVALID_REGISTRATION_TIME",
    message: string,
  ) {
    super(message);
    this.name = "DomainBirthIntelligenceError";
  }
}

function runtimeDependency(value: unknown, method: string, label: string): void {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new DomainBirthIntelligenceError("INVALID_CONFIG", `${label} is not a usable runtime dependency`);
  }
}

function domainAgeLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAXIMUM_DOMAIN_AGE_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 60 * 60 * 1_000 || resolved > MAXIMUM_SUPPORTED_DOMAIN_AGE_MS) {
    throw new DomainBirthIntelligenceError("INVALID_CONFIG", "maximumDomainAgeMs must be between 1 hour and 90 days");
  }
  return resolved;
}

export class DomainBirthIntelligenceEngine {
  private readonly rdap: RdapDomainLookupPort;
  private readonly dns: DnsDomainIntelligencePort;
  private readonly maximumDomainAgeMs: number;
  private readonly requireDnsActivation: boolean;
  private readonly now: () => number;

  constructor(config: DomainBirthIntelligenceConfig) {
    if (!config || typeof config !== "object") throw new DomainBirthIntelligenceError("INVALID_CONFIG", "domain birth intelligence config is required");
    runtimeDependency(config.rdap, "lookupDomain", "rdap");
    runtimeDependency(config.dns, "inspect", "dns");
    this.rdap = config.rdap;
    this.dns = config.dns;
    this.maximumDomainAgeMs = domainAgeLimit(config.maximumDomainAgeMs);
    this.requireDnsActivation = config.requireDnsActivation ?? true;
    this.now = config.now ?? Date.now;
  }

  async inspect(input: string): Promise<DomainBirthAssessment> {
    const domain = normalizeDomainName(input);
    const lookup = await this.rdap.lookupDomain(domain);
    if (lookup.status === "NOT_REGISTERED") {
      return Object.freeze({
        domain,
        classification: "NOT_REGISTERED" as const,
        ageMs: null,
        registeredAt: null,
        rdap: null,
        dns: null,
        eligibleForConsentedOutreach: false,
      });
    }

    const rdap = lookup.record;
    const dns = await this.dns.inspect(domain);
    if (rdap.registrationDate === null) {
      return Object.freeze({
        domain,
        classification: "UNKNOWN_AGE" as const,
        ageMs: null,
        registeredAt: null,
        rdap,
        dns,
        eligibleForConsentedOutreach: false,
      });
    }

    const nowMs = this.now();
    const registeredMs = Date.parse(rdap.registrationDate);
    if (!Number.isFinite(nowMs) || !Number.isFinite(registeredMs) || registeredMs > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
      throw new DomainBirthIntelligenceError("INVALID_REGISTRATION_TIME", "RDAP registration time is inconsistent with the local clock");
    }
    const ageMs = Math.max(0, nowMs - registeredMs);
    if (ageMs > this.maximumDomainAgeMs) {
      return Object.freeze({
        domain,
        classification: "ESTABLISHED" as const,
        ageMs,
        registeredAt: rdap.registrationDate,
        rdap,
        dns,
        eligibleForConsentedOutreach: false,
      });
    }
    const active = dns.dnsActive;
    const classification: DomainBirthClassification = active ? "NEWLY_REGISTERED_ACTIVE" : "NEWLY_REGISTERED_INACTIVE";
    return Object.freeze({
      domain,
      classification,
      ageMs,
      registeredAt: rdap.registrationDate,
      rdap,
      dns,
      eligibleForConsentedOutreach: active || !this.requireDnsActivation,
    });
  }
}

export type DomainBirthLeadSource = "FIRST_PARTY_CRM" | "USER_REQUEST" | "PARTNER_OPT_IN";
export type DomainBirthOutreachExecutionMode = "PLAN_ONLY" | "APPLY";

export interface DomainBirthOutreachRequest {
  readonly domain: string;
  readonly recipientE164: string;
  readonly consent: WhatsAppConsentEvidence;
  readonly leadSource: DomainBirthLeadSource;
  readonly landingUrl: string;
  readonly executionMode: DomainBirthOutreachExecutionMode;
}

export type DomainBirthOutreachResult =
  | Readonly<{
      status: "SKIPPED";
      assessment: DomainBirthAssessment;
      reasons: readonly ("DOMAIN_NOT_NEW" | "DNS_NOT_ACTIVE" | "REGISTRATION_AGE_UNKNOWN" | "DOMAIN_NOT_REGISTERED")[];
    }>
  | Readonly<{
      status: "PLANNED";
      assessment: DomainBirthAssessment;
      landingUrl: string;
      payload: WhatsAppTemplatePayload;
    }>
  | Readonly<{
      status: "SENT";
      assessment: DomainBirthAssessment;
      landingUrl: string;
      receipt: WhatsAppSendReceipt;
    }>;

export interface DomainBirthOutreachEngineConfig {
  readonly intelligence: DomainBirthIntelligenceEngine;
  readonly whatsapp: WhatsAppCloudApiClient;
  readonly senderWebsiteOrigin: string;
  readonly templateName: string;
  readonly languageCode: string;
  readonly now?: () => number;
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") throw new DomainBirthIntelligenceError("INVALID_CONFIG", "senderWebsiteOrigin must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainBirthIntelligenceError("INVALID_CONFIG", "senderWebsiteOrigin is malformed");
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new DomainBirthIntelligenceError("INVALID_CONFIG", "senderWebsiteOrigin must be an http(s) origin");
  }
  return url.origin;
}

function canonicalLandingUrl(value: unknown, origin: string): string {
  if (typeof value !== "string") throw new DomainBirthIntelligenceError("INVALID_INPUT", "landingUrl must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainBirthIntelligenceError("INVALID_INPUT", "landingUrl is malformed");
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.origin !== origin || url.hash) {
    throw new DomainBirthIntelligenceError("INVALID_INPUT", "landingUrl must belong to the verified sender website origin");
  }
  return url.href;
}

function leadSource(value: unknown): DomainBirthLeadSource {
  if (value === "FIRST_PARTY_CRM" || value === "USER_REQUEST" || value === "PARTNER_OPT_IN") return value;
  throw new DomainBirthIntelligenceError("INVALID_INPUT", "leadSource must identify an authorized first-party or opted-in source");
}

function skipReasons(assessment: DomainBirthAssessment): readonly ("DOMAIN_NOT_NEW" | "DNS_NOT_ACTIVE" | "REGISTRATION_AGE_UNKNOWN" | "DOMAIN_NOT_REGISTERED")[] {
  if (assessment.classification === "NOT_REGISTERED") return Object.freeze(["DOMAIN_NOT_REGISTERED"] as const);
  if (assessment.classification === "UNKNOWN_AGE") return Object.freeze(["REGISTRATION_AGE_UNKNOWN"] as const);
  if (assessment.classification === "ESTABLISHED") return Object.freeze(["DOMAIN_NOT_NEW"] as const);
  if (assessment.classification === "NEWLY_REGISTERED_INACTIVE") return Object.freeze(["DNS_NOT_ACTIVE"] as const);
  return Object.freeze([]);
}

export class DomainBirthOutreachEngine {
  private readonly intelligence: DomainBirthIntelligenceEngine;
  private readonly whatsapp: WhatsAppCloudApiClient;
  private readonly senderWebsiteOrigin: string;
  private readonly templateName: string;
  private readonly languageCode: string;
  private readonly now: () => number;

  constructor(config: DomainBirthOutreachEngineConfig) {
    if (!config || typeof config !== "object") throw new DomainBirthIntelligenceError("INVALID_CONFIG", "domain birth outreach config is required");
    runtimeDependency(config.intelligence, "inspect", "intelligence");
    runtimeDependency(config.whatsapp, "sendTemplate", "whatsapp");
    this.intelligence = config.intelligence;
    this.whatsapp = config.whatsapp;
    this.senderWebsiteOrigin = canonicalOrigin(config.senderWebsiteOrigin);
    this.templateName = config.templateName;
    this.languageCode = config.languageCode;
    this.now = config.now ?? Date.now;
  }

  identity() {
    return Object.freeze({
      strategy: 5 as const,
      provider: "WHATSAPP_CLOUD_API" as const,
      senderWebsiteOrigin: this.senderWebsiteOrigin,
      whatsapp: this.whatsapp.identity(),
    });
  }

  async run(input: DomainBirthOutreachRequest): Promise<DomainBirthOutreachResult> {
    if (!input || typeof input !== "object") throw new DomainBirthIntelligenceError("INVALID_INPUT", "domain birth outreach input is required");
    leadSource(input.leadSource);
    const landingUrl = canonicalLandingUrl(input.landingUrl, this.senderWebsiteOrigin);
    const assessment = await this.intelligence.inspect(input.domain);
    if (!assessment.eligibleForConsentedOutreach) {
      return Object.freeze({ status: "SKIPPED" as const, assessment, reasons: skipReasons(assessment) });
    }
    const templateInput = {
      recipientE164: input.recipientE164,
      consent: input.consent,
      templateName: this.templateName,
      languageCode: this.languageCode,
      bodyParameters: Object.freeze([assessment.domain, landingUrl]),
    } as const;
    if (input.executionMode === "PLAN_ONLY") {
      return Object.freeze({
        status: "PLANNED" as const,
        assessment,
        landingUrl,
        payload: buildWhatsAppTemplatePayload(templateInput, this.now()),
      });
    }
    if (input.executionMode !== "APPLY") throw new DomainBirthIntelligenceError("INVALID_INPUT", "executionMode must be PLAN_ONLY or APPLY");
    const receipt = await this.whatsapp.sendTemplate(templateInput);
    return Object.freeze({ status: "SENT" as const, assessment, landingUrl, receipt });
  }
}

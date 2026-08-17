import { createHash } from "node:crypto";

export type BusinessEventName = "EXPERIENCE_VIEW" | "CTA_CLICK" | "LEAD_SUBMITTED" | "BOOKING_COMPLETED" | "PURCHASE_COMPLETED" | "QUALIFIED_CONTACT";

export interface BusinessTelemetryConsent {
  analyticsAllowed: boolean;
  basis: "CONSENT" | "CONTRACT" | "LEGITIMATE_INTEREST";
}

export interface BusinessEventInput {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  sourceRevision: string;
  eventName: BusinessEventName;
  occurredAt: string;
  consent: BusinessTelemetryConsent;
  dimensions?: Readonly<Record<string, string>>;
  value?: Readonly<{ amount: number; currency: string }>;
}

export interface BusinessEvent extends BusinessEventInput {
  schemaVersion: 1;
  eventId: `business_${string}`;
}

export interface BusinessTelemetryAggregate {
  authority: "NEXUS_BUSINESS_TELEMETRY";
  tenantId: string;
  projectId: string;
  deploymentId: string;
  sourceRevision: string;
  eventCount: number;
  counts: Readonly<Record<BusinessEventName, number>>;
  conversionRate: number | null;
  totalObservedValue: Readonly<Record<string, number>>;
}

const PII_KEYS = new Set(["email", "e-mail", "phone", "telephone", "name", "full_name", "first_name", "last_name", "ip", "ip_address", "address", "postal_address", "user_agent"]);
const EVENT_NAMES: readonly BusinessEventName[] = ["EXPERIENCE_VIEW", "CTA_CLICK", "LEAD_SUBMITTED", "BOOKING_COMPLETED", "PURCHASE_COMPLETED", "QUALIFIED_CONTACT"];
const CONSENT_BASES: readonly BusinessTelemetryConsent["basis"][] = ["CONSENT", "CONTRACT", "LEGITIMATE_INTEREST"];
const CONVERSION_EVENTS = new Set<BusinessEventName>(["LEAD_SUBMITTED", "BOOKING_COMPLETED", "PURCHASE_COMPLETED", "QUALIFIED_CONTACT"]);

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function canonicalTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertRevision(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error("sourceRevision must be a full lowercase git SHA-1");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function eventId(value: unknown): `business_${string}` {
  return `business_${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function validateDimensions(dimensions: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (!dimensions) return undefined;
  if (typeof dimensions !== "object" || Array.isArray(dimensions)) throw new Error("business telemetry dimensions must be an object");
  const entries = Object.entries(dimensions).map(([key, value]) => {
    const normalizedKey = nonEmpty(key, "dimension key").toLowerCase();
    if (PII_KEYS.has(normalizedKey)) throw new Error(`business telemetry dimension ${key} is prohibited PII`);
    const normalizedValue = nonEmpty(value, `dimension ${key}`);
    if (normalizedValue.length > 160) throw new Error(`dimension ${key} exceeds 160 characters`);
    return [normalizedKey, normalizedValue] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("business telemetry dimension keys must be unique after normalization");
  return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
}

function validateConsent(consent: BusinessTelemetryConsent): Readonly<BusinessTelemetryConsent> {
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) throw new Error("business telemetry consent is required");
  if (consent.analyticsAllowed !== true) throw new Error("business telemetry requires analytics permission");
  if (!CONSENT_BASES.includes(consent.basis)) throw new Error("business telemetry consent basis is invalid");
  return Object.freeze({ analyticsAllowed: true, basis: consent.basis });
}

function canonicalInput(input: BusinessEventInput): BusinessEventInput {
  const tenantId = nonEmpty(input.tenantId, "tenantId");
  const projectId = nonEmpty(input.projectId, "projectId");
  const deploymentId = nonEmpty(input.deploymentId, "deploymentId");
  assertRevision(input.sourceRevision);
  if (!EVENT_NAMES.includes(input.eventName)) throw new Error("unsupported business event name");
  if (!canonicalTimestamp(input.occurredAt)) throw new Error("occurredAt must be canonical ISO-8601 UTC");
  const consent = validateConsent(input.consent);
  const dimensions = validateDimensions(input.dimensions);
  let value = input.value;
  if (value) {
    if (!Number.isFinite(value.amount) || value.amount < 0) throw new Error("business event value amount must be finite and non-negative");
    value = Object.freeze({ amount: value.amount, currency: nonEmpty(value.currency, "value.currency").toUpperCase() });
  }
  return { tenantId, projectId, deploymentId, sourceRevision: input.sourceRevision, eventName: input.eventName, occurredAt: input.occurredAt, consent, dimensions, value };
}

export function createBusinessEvent(input: BusinessEventInput): BusinessEvent {
  const canonical = canonicalInput(input);
  return Object.freeze({ schemaVersion: 1, eventId: eventId(canonical), ...canonical });
}

export function aggregateBusinessTelemetry(events: readonly BusinessEvent[]): BusinessTelemetryAggregate {
  if (!events.length) throw new Error("business telemetry aggregation requires observed events");
  const first = events[0]!;
  const ids = new Set<string>();
  const counts = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])) as Record<BusinessEventName, number>;
  const totalObservedValue: Record<string, number> = {};
  for (const event of events) {
    const payload: BusinessEventInput = {
      tenantId: event.tenantId,
      projectId: event.projectId,
      deploymentId: event.deploymentId,
      sourceRevision: event.sourceRevision,
      eventName: event.eventName,
      occurredAt: event.occurredAt,
      consent: event.consent,
      dimensions: event.dimensions,
      value: event.value,
    };
    const rebuilt = createBusinessEvent(payload);
    if (rebuilt.eventId !== event.eventId) throw new Error(`business event ${event.eventId} failed deterministic integrity verification`);
    if (ids.has(event.eventId)) throw new Error(`duplicate business event ${event.eventId}`);
    ids.add(event.eventId);
    if (event.tenantId !== first.tenantId || event.projectId !== first.projectId || event.deploymentId !== first.deploymentId || event.sourceRevision !== first.sourceRevision) {
      throw new Error("business telemetry aggregation cannot cross tenant/project/deployment/revision boundaries");
    }
    counts[event.eventName] += 1;
    if (event.value) totalObservedValue[event.value.currency] = (totalObservedValue[event.value.currency] ?? 0) + event.value.amount;
  }
  const views = counts.EXPERIENCE_VIEW;
  const conversions = [...CONVERSION_EVENTS].reduce((sum, name) => sum + counts[name], 0);
  return Object.freeze({
    authority: "NEXUS_BUSINESS_TELEMETRY",
    tenantId: first.tenantId,
    projectId: first.projectId,
    deploymentId: first.deploymentId,
    sourceRevision: first.sourceRevision,
    eventCount: events.length,
    counts: Object.freeze({ ...counts }),
    conversionRate: views > 0 ? conversions / views : null,
    totalObservedValue: Object.freeze(Object.fromEntries(Object.entries(totalObservedValue).sort(([a], [b]) => a.localeCompare(b)))),
  });
}

import { describe, expect, it } from "vitest";
import { aggregateBusinessTelemetry, createBusinessEvent } from "./business-telemetry";

const revision = "0123456789abcdef0123456789abcdef01234567";
const base = {
  tenantId: "tenant-a",
  projectId: "project-a",
  deploymentId: "deployment-a",
  sourceRevision: revision,
  occurredAt: "2026-08-17T07:30:00.000Z",
  consent: { analyticsAllowed: true, basis: "CONSENT" as const },
};

describe("business telemetry", () => {
  it("records deterministic business events without performance metrics", () => {
    const event = createBusinessEvent({ ...base, eventName: "CTA_CLICK", dimensions: { placement: "hero" } });
    expect(event.eventId).toMatch(/^business_[a-f0-9]{64}$/);
    expect(createBusinessEvent({ ...base, eventName: "CTA_CLICK", dimensions: { placement: "hero" } }).eventId).toBe(event.eventId);
  });

  it("fails closed when analytics permission is absent", () => {
    expect(() => createBusinessEvent({ ...base, eventName: "EXPERIENCE_VIEW", consent: { analyticsAllowed: false, basis: "CONSENT" } })).toThrow(/analytics permission/);
  });

  it("rejects malformed runtime consent instead of trusting TypeScript-only shapes", () => {
    const truthyString = {
      ...base,
      eventName: "EXPERIENCE_VIEW",
      consent: { analyticsAllowed: "yes", basis: "CONSENT" },
    } as unknown as Parameters<typeof createBusinessEvent>[0];
    const invalidBasis = {
      ...base,
      eventName: "EXPERIENCE_VIEW",
      consent: { analyticsAllowed: true, basis: "UNKNOWN" },
    } as unknown as Parameters<typeof createBusinessEvent>[0];
    expect(() => createBusinessEvent(truthyString)).toThrow(/analytics permission/);
    expect(() => createBusinessEvent(invalidBasis)).toThrow(/consent basis is invalid/);
  });

  it("rejects common and normalized PII dimension aliases without blocking legitimate names", () => {
    for (const key of ["email", "customer_email", "email-address", "phone_number", "client-ip", "user-agent"] as const) {
      expect(() => createBusinessEvent({ ...base, eventName: "LEAD_SUBMITTED", dimensions: { [key]: "sensitive" } })).toThrow(/prohibited PII/);
    }
    expect(() => createBusinessEvent({ ...base, eventName: "CTA_CLICK", dimensions: { campaign_name: "summer-launch" } })).not.toThrow();
  });

  it("aggregates only one tenant/project/deployment/revision scope", () => {
    const view = createBusinessEvent({ ...base, eventName: "EXPERIENCE_VIEW" });
    const lead = createBusinessEvent({ ...base, eventName: "LEAD_SUBMITTED", occurredAt: "2026-08-17T07:31:00.000Z" });
    const aggregate = aggregateBusinessTelemetry([view, lead]);
    expect(aggregate.eventCount).toBe(2);
    expect(aggregate.conversionRate).toBe(1);
    const other = createBusinessEvent({ ...base, projectId: "project-b", eventName: "CTA_CLICK", occurredAt: "2026-08-17T07:32:00.000Z" });
    expect(() => aggregateBusinessTelemetry([view, other])).toThrow(/cannot cross/);
  });

  it("rejects tampered event lineage", () => {
    const event = createBusinessEvent({ ...base, eventName: "PURCHASE_COMPLETED", value: { amount: 99, currency: "mxn" } });
    expect(() => aggregateBusinessTelemetry([{ ...event, sourceRevision: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }])).toThrow(/integrity verification/);
  });

  it("rejects tampered schema versions even when the payload hash still matches", () => {
    const event = createBusinessEvent({ ...base, eventName: "CTA_CLICK" });
    const tampered = { ...event, schemaVersion: 999 } as unknown as typeof event;
    expect(() => aggregateBusinessTelemetry([tampered])).toThrow(/schemaVersion must be exactly 1/);
  });
});

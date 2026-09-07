import test from "node:test";
import assert from "node:assert/strict";
import type { FormSubmission, LeadDestination } from "./index.js";
import {
  AutonomousSalesLeadDestination,
  SqliteSalesAutomationAudit,
  createAutonomousSalesPolicy,
  type AutonomousSalesDependencies,
  type AutonomousSalesPolicy,
  type LocalSalesAssistantInput,
  type SalesRequestedAction,
} from "./autonomous-sales.js";

const LEAD_DIGEST = `sha256:${"a".repeat(64)}` as const;
const CLV_DIGEST = `sha256:${"b".repeat(64)}` as const;
const LLM_DIGEST = `sha256:${"c".repeat(64)}` as const;
const CAP_DIGEST = `sha256:${"d".repeat(64)}` as const;
const CONTACT_HASH = `sha256:${"e".repeat(64)}` as const;

const basePolicy: AutonomousSalesPolicy = {
  version: 1,
  forms: [{
    formId: "form-sales-001",
    companyDomainField: null,
    enrichmentEnabled: false,
    allowedEnrichmentProviderIds: [],
    leadModel: {
      modelId: "lead-model-001",
      modelDigest: LEAD_DIGEST,
      intercept: -1,
      features: [{ source: "FORM", name: "employees", min: 1, max: 100, weight: 4 }],
    },
    clvModel: {
      modelId: "clv-model-001",
      modelDigest: CLV_DIGEST,
      currency: "MXN",
      intercept: 1000,
      minValue: 0,
      maxValue: 100000,
      features: [{ source: "FORM", name: "employees", min: 1, max: 100, weight: 9000 }],
    },
    minLeadScoreForAutonomousFollowUp: 0.5,
    routes: [{ channel: "WHATSAPP", contactField: "phone", capabilityId: "sales-whatsapp-001" }],
    llmBusinessContext: "Follow up about the configured business service. Do not quote price, discount, contract terms or legal commitments.",
  }],
};

function submission(employees = "100"): FormSubmission {
  return Object.freeze({
    submissionId: "submission-0001",
    formId: "form-sales-001",
    submittedAt: "2026-09-07T06:00:00.000Z",
    contactConsent: "GRANTED",
    fields: Object.freeze({ employees, phone: "+525555555555", message: "private free text must not reach the LLM" }),
  });
}

function deps(action: SalesRequestedAction, capture?: { llmInput?: LocalSalesAssistantInput; sends?: number; handoffs?: number; consentReads?: number; capabilityReads?: number }): AutonomousSalesDependencies {
  const primary: LeadDestination = { async deliver() { return { receiptId: "primary-receipt-001" }; } };
  return {
    primaryDestination: primary,
    enrichment: null,
    contactHashSecret: "h".repeat(40),
    readMode: () => "ACTIVE",
    now: () => Date.parse("2026-09-07T06:00:00.000Z"),
    assistant: {
      async draft(input) {
        if (capture) capture.llmInput = input;
        return {
          modelId: "local-model-001",
          modelDigest: LLM_DIGEST,
          classification: "qualified-lead",
          summary: "Qualified business lead.",
          suggestedMessage: "Gracias por contactarnos. ¿Te gustaría continuar la conversación?",
          requestedAction: action,
        };
      },
    },
    consentRegistry: {
      async resolve(contactHash, channel) {
        if (capture) capture.consentReads = (capture.consentReads ?? 0) + 1;
        assert.equal(channel, "WHATSAPP");
        return { decisionId: "consent-decision-001", status: "GRANTED", channel, contactHash, expiresAt: "2026-09-08T06:00:00.000Z" };
      },
    },
    capabilityGate: {
      async read(capabilityId) {
        if (capture) capture.capabilityReads = (capture.capabilityReads ?? 0) + 1;
        return { capabilityId, mode: "ACTIVE", revision: 7, policyDigest: CAP_DIGEST };
      },
    },
    channelDispatcher: {
      async send() {
        if (capture) capture.sends = (capture.sends ?? 0) + 1;
        return { receiptId: "channel-receipt-001" };
      },
    },
    humanHandoff: {
      async handoff() {
        if (capture) capture.handoffs = (capture.handoffs ?? 0) + 1;
        return { receiptId: "handoff-receipt-001" };
      },
    },
  };
}

test("sensitive attributes cannot be configured as lead or CLV features", () => {
  const unsafe: AutonomousSalesPolicy = {
    ...basePolicy,
    forms: [{
      ...basePolicy.forms[0]!,
      leadModel: {
        ...basePolicy.forms[0]!.leadModel,
        features: [{ source: "FORM", name: "age", min: 18, max: 90, weight: 1 }],
      },
    }],
  };
  assert.throws(() => createAutonomousSalesPolicy(unsafe), /invalid or sensitive/);
});

test("low lead score stops after primary delivery without invoking LLM or messaging", async () => {
  const capture: { llmInput?: LocalSalesAssistantInput; sends?: number; handoffs?: number } = {};
  const audit = new SqliteSalesAutomationAudit(":memory:");
  const destination = new AutonomousSalesLeadDestination(basePolicy, audit, deps("FOLLOW_UP", capture));
  try {
    const receipt = await destination.deliver(submission("1"), "form-event-0001");
    assert.equal(receipt.receiptId, "primary-receipt-001");
    assert.equal(capture.llmInput, undefined);
    assert.equal(capture.sends ?? 0, 0);
    assert.equal(capture.handoffs ?? 0, 0);
  } finally { audit.close(); }
});

test("local LLM receives only minimized business context, scores and enrichment", async () => {
  const capture: { llmInput?: LocalSalesAssistantInput; sends?: number; consentReads?: number; capabilityReads?: number } = {};
  const audit = new SqliteSalesAutomationAudit(":memory:");
  const destination = new AutonomousSalesLeadDestination(basePolicy, audit, deps("FOLLOW_UP", capture));
  try {
    await destination.deliver(submission(), "form-event-0002");
    assert.ok(capture.llmInput);
    assert.deepEqual(Object.keys(capture.llmInput!).sort(), ["businessContext", "clvCurrency", "enrichment", "leadScore", "predictedClv"]);
    assert.doesNotMatch(JSON.stringify(capture.llmInput), /private free text|\+5255|message|phone/);
    assert.equal(capture.sends, 1);
    assert.equal(capture.consentReads, 2);
    assert.equal(capture.capabilityReads, 2);
  } finally { audit.close(); }
});

test("pricing, discount and contract-like assistant actions always go to human handoff", async () => {
  for (const action of ["CUSTOM_PRICE", "DISCOUNT", "CONTRACT", "PAYMENT_TERMS", "LEGAL_COMMITMENT"] as const) {
    const capture: { sends?: number; handoffs?: number } = {};
    const audit = new SqliteSalesAutomationAudit(":memory:");
    const destination = new AutonomousSalesLeadDestination(basePolicy, audit, deps(action, capture));
    try {
      const result = await destination.deliver(submission(), `form-event-${action.toLowerCase().replaceAll("_", "-")}`);
      assert.equal(result.receiptId, "handoff-receipt-001");
      assert.equal(capture.handoffs, 1);
      assert.equal(capture.sends ?? 0, 0);
    } finally { audit.close(); }
  }
});

test("consent revocation during final recheck prevents the outbound message", async () => {
  let reads = 0;
  let sends = 0;
  const base = deps("FOLLOW_UP");
  const audit = new SqliteSalesAutomationAudit(":memory:");
  const destination = new AutonomousSalesLeadDestination(basePolicy, audit, {
    ...base,
    consentRegistry: {
      async resolve(contactHash, channel) {
        reads += 1;
        return {
          decisionId: "consent-decision-001",
          status: reads === 1 ? "GRANTED" : "REVOKED",
          channel,
          contactHash,
          expiresAt: "2026-09-08T06:00:00.000Z",
        };
      },
    },
    channelDispatcher: {
      async send() { sends += 1; return { receiptId: "channel-receipt-001" }; },
    },
  });
  try {
    await assert.rejects(() => destination.deliver(submission(), "form-event-0003"), /consent changed/i);
    assert.equal(sends, 0);
  } finally { audit.close(); }
});

test("form without automation policy records null model fields rather than fabricated provenance", async () => {
  const audit = new SqliteSalesAutomationAudit(":memory:");
  const destination = new AutonomousSalesLeadDestination(basePolicy, audit, deps("FOLLOW_UP"));
  const other = { ...submission(), submissionId: "submission-0002", formId: "other-form-0001" };
  try {
    await destination.deliver(other, "form-event-0004");
    const eventId = `sales-${await import("node:crypto").then(({ createHash }) => createHash("sha256").update("form-event-0004").digest("hex").slice(0, 32))}`;
    const record = audit.get(eventId);
    assert.equal(record?.leadModelDigest, null);
    assert.equal(record?.clvModelDigest, null);
    assert.equal(record?.clvCurrency, null);
    assert.equal(record?.status, "NO_AUTOMATION");
  } finally { audit.close(); }
});

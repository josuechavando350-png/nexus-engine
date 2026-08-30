import { describe, expect, it } from "vitest";

import { hash, type GroundedFact, type GroundingContext, type KnowledgeEvidence } from "./chatbot-knowledge-types.js";
import type { KnowledgeGraphReader } from "./chatbot-knowledge-reader.js";
import { FormalGuardrailEngine, inferGuardrailSensitiveClaimClasses } from "./chatbot-guardrails-engine.js";
import { createDefaultGuardrailPolicy, finalizeGuardrailPolicy } from "./chatbot-guardrails-policy.js";
import type { FormalGuardrailPolicy } from "./chatbot-guardrails-types.js";

const NOW = "2026-08-30T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function evidence(options: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence {
  const core = {
    kind: options.kind ?? "FIRST_PARTY",
    source: options.source ?? "client-approved",
    sourceDigest: options.sourceDigest === undefined ? "sha256:abc" : options.sourceDigest,
    excerpt: options.excerpt === undefined ? "Dato aprobado" : options.excerpt,
    observedAt: options.observedAt ?? NOW,
    metadata: options.metadata ?? {},
  };
  return { id: options.id ?? "evidence:1", ...core, digest: hash("kgr", core), revision: options.revision ?? 1 };
}

function fact(options: Partial<GroundedFact> = {}): GroundedFact {
  const core = {
    factId: options.factId ?? "fact:price",
    subjectId: options.subjectId ?? "service:chatbot",
    subjectName: options.subjectName ?? "Chatbot empresarial",
    predicate: options.predicate ?? "base-price-mxn",
    object: options.object ?? ({ kind: "LITERAL", value: 3500 } as const),
    displayValue: options.displayValue ?? "3500",
    evidenceIds: options.evidenceIds ?? ["evidence:1"],
    confidence: options.confidence ?? 1,
    claimClass: options.claimClass ?? "PRICE",
    validFrom: options.validFrom ?? null,
    validUntil: options.validUntil ?? null,
  };
  return { ...core, digest: hash("kground", core) };
}

function grounding(
  facts: readonly GroundedFact[] = [fact()],
  evidenceItems: readonly KnowledgeEvidence[] = [evidence()],
  status: GroundingContext["status"] = "SUPPORTED",
): GroundingContext {
  const core = { status, facts, evidence: evidenceItems, conflicts: [], matchedEntityIds: ["service:chatbot"], instructions: [] };
  return { ...core, digest: hash("kgcontext", core) };
}

function reader(context: GroundingContext): KnowledgeGraphReader {
  return { grounding: async () => context } as unknown as KnowledgeGraphReader;
}

function engine(context: GroundingContext): FormalGuardrailEngine {
  return new FormalGuardrailEngine(reader(context), createDefaultGuardrailPolicy(), () => NOW_MS);
}

function policyInput(policy: FormalGuardrailPolicy): Omit<FormalGuardrailPolicy, "digest"> {
  return {
    policyId: policy.policyId,
    version: policy.version,
    locale: policy.locale,
    maxSegments: policy.maxSegments,
    maxResponseChars: policy.maxResponseChars,
    allowHistoricalGrounding: policy.allowHistoricalGrounding,
    claimPolicies: policy.claimPolicies,
    copy: policy.copy,
    templates: policy.templates,
  };
}

describe("formal chatbot guardrails", () => {
  it("recognizes sensitive commercial intents independently of the model", () => {
    expect(inferGuardrailSensitiveClaimClasses("¿Cuánto cuesta y tienen descuento?"))
      .toEqual(["PRICE", "PROMOTION"]);
    expect(inferGuardrailSensitiveClaimClasses("¿Son $3500?")).toEqual(["PRICE"]);
  });

  it("deep-freezes policy internals so async evaluation cannot observe policy mutation", () => {
    const policy = createDefaultGuardrailPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.claimPolicies)).toBe(true);
    expect(Object.isFrozen(policy.claimPolicies.PRICE)).toBe(true);
    expect(Object.isFrozen(policy.claimPolicies.PRICE.allowedEvidenceKinds)).toBe(true);
    expect(Object.isFrozen(policy.copy)).toBe(true);
    expect(Object.isFrozen(policy.templates)).toBe(true);
    expect(() => (policy.claimPolicies.PRICE.allowedEvidenceKinds as string[]).push("CUSTOMER_PROVIDED")).toThrow(TypeError);
  });

  it("canonicalizes set-like policy arrays before hashing", () => {
    const policy = createDefaultGuardrailPolicy();
    const core = policyInput(policy);
    const price = core.claimPolicies.PRICE;
    const equivalent = finalizeGuardrailPolicy({
      ...core,
      claimPolicies: {
        ...core.claimPolicies,
        PRICE: { ...price, allowedEvidenceKinds: [...price.allowedEvidenceKinds].reverse() },
      },
    });
    expect(equivalent.digest).toBe(policy.digest);
  });

  it("allows a supported price only through an approved fact template", async () => {
    const guardrails = engine(grounding());
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es el precio?" });
    expect(prepared.envelope.disposition).toBe("ALLOW");
    expect(prepared.envelope.allowedFactIds).toEqual(["fact:price"]);
    const response = guardrails.render({ planId: "plan:price", segments: [{ kind: "FACT", factId: "fact:price", templateId: "es.price" }] }, prepared);
    expect(response.text).toContain("3500");
    expect(() => guardrails.verifyOutbound(response, prepared)).not.toThrow();
  });

  it("rejects high-risk price claims backed only by customer-provided evidence", async () => {
    const prepared = await engine(grounding([fact()], [evidence({ kind: "CUSTOMER_PROVIDED" })]))
      .prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es el precio?" });
    expect(prepared.envelope.disposition).toBe("ESCALATE");
    expect(prepared.envelope.rejectedFacts[0]?.reasons).toContain("UNAPPROVED_EVIDENCE_KIND");
  });

  it("rejects high-risk evidence without a source digest", async () => {
    const prepared = await engine(grounding([fact()], [evidence({ sourceDigest: null })]))
      .prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es el precio?" });
    expect(prepared.envelope.rejectedFacts[0]?.reasons).toContain("MISSING_SOURCE_DIGEST");
  });

  it("requires stronger provenance for critical credential claims", async () => {
    const credential = fact({ claimClass: "CREDENTIAL", predicate: "professional-license", displayValue: "ABC123" });
    const prepared = await engine(grounding([credential], [evidence({ kind: "WEBSITE" })]))
      .prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es su cédula?" });
    expect(prepared.envelope.rejectedFacts[0]?.reasons).toContain("MISSING_REQUIRED_ANY_EVIDENCE_KIND");
  });

  it("can require all configured provenance kinds, not only one of them", async () => {
    const base = createDefaultGuardrailPolicy();
    const core = policyInput(base);
    const policy = finalizeGuardrailPolicy({
      ...core,
      claimPolicies: {
        ...core.claimPolicies,
        CREDENTIAL: {
          ...core.claimPolicies.CREDENTIAL,
          requiredAnyEvidenceKinds: undefined,
          requiredAllEvidenceKinds: ["FIRST_PARTY", "OPERATOR_APPROVED"],
        },
      },
    });
    const credential = fact({ claimClass: "CREDENTIAL", predicate: "professional-license", displayValue: "ABC123" });
    const guardrails = new FormalGuardrailEngine(reader(grounding([credential], [evidence({ kind: "FIRST_PARTY" })])), policy, () => NOW_MS);
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es su cédula?" });
    expect(prepared.envelope.rejectedFacts[0]?.reasons).toContain("MISSING_REQUIRED_ALL_EVIDENCE_KIND");
  });

  it("does not turn partial support into a high-risk price commitment", async () => {
    const prepared = await engine(grounding([fact({ confidence: 0.95 })], [evidence()], "PARTIALLY_SUPPORTED"))
      .prepare({ businessEntityId: "business:client", userMessage: "¿Cuánto cuesta?" });
    expect(prepared.envelope.disposition).toBe("ESCALATE");
    expect(prepared.envelope.rejectedFacts[0]?.reasons).toContain("PARTIAL_SUPPORT_NOT_ALLOWED");
  });

  it("forces qualified wording for partially supported low-risk facts", async () => {
    const general = fact({ factId: "fact:general", claimClass: "GENERAL", predicate: "service-description", displayValue: "Atención por chat", confidence: 0.78 });
    const guardrails = engine(grounding([general], [evidence()], "PARTIALLY_SUPPORTED"));
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "Háblame del servicio" });
    expect(prepared.envelope.disposition).toBe("QUALIFY");
    expect(() => guardrails.render({ planId: "plan:wrong", segments: [{ kind: "FACT", factId: "fact:general", templateId: "es.general" }] }, prepared)).toThrow(/qualification/i);
    const response = guardrails.render({ planId: "plan:qualified", segments: [{ kind: "FACT", factId: "fact:general", templateId: "es.general-qualified" }] }, prepared);
    expect(response.text).toContain("Según la información disponible");
  });

  it("requires escalation when the user asks for a sensitive class that is absent", async () => {
    const general = fact({ factId: "fact:general", claimClass: "GENERAL", predicate: "service-description", displayValue: "Atención por chat" });
    const prepared = await engine(grounding([general], [evidence()]))
      .prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es el precio?" });
    expect(prepared.envelope.requiredEscalation).toBe(true);
    expect(prepared.envelope.requestedClaimClasses).toEqual(["PRICE"]);
  });

  it("suppresses all factual output for unsupported grounding", async () => {
    const guardrails = engine(grounding([], [], "UNSUPPORTED"));
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "¿Cuál es el precio?" });
    expect(prepared.envelope.suppressFacts).toBe(true);
    expect(() => guardrails.render({ planId: "plan:no-escalation", segments: [{ kind: "COPY", copyId: "es.ask-clarify" }] }, prepared)).toThrow(/omitted a requested sensitive claim without escalating/i);
    const response = guardrails.render({ planId: "plan:escalate", segments: [{ kind: "COPY", copyId: "es.escalate-verify" }] }, prepared);
    expect(response.text).toContain("confirmarlo");
  });

  it("rejects stale and future evidence instead of silently trusting timestamps", async () => {
    const stale = await engine(grounding([fact()], [evidence({ observedAt: "2025-01-01T00:00:00.000Z" })]))
      .prepare({ businessEntityId: "business:client", userMessage: "precio" });
    expect(stale.envelope.rejectedFacts[0]?.reasons).toContain("STALE_EVIDENCE");
    const future = await engine(grounding([fact()], [evidence({ observedAt: "2026-09-01T00:00:00.000Z" })]))
      .prepare({ businessEntityId: "business:client", userMessage: "precio" });
    expect(future.envelope.rejectedFacts[0]?.reasons).toContain("FUTURE_EVIDENCE");
  });

  it("disables historical grounding by default", async () => {
    await expect(engine(grounding()).prepare({ businessEntityId: "business:client", userMessage: "precio", at: "2025-01-01T00:00:00.000Z" }))
      .rejects.toThrow(/historical grounding is disabled/i);
  });

  it("fails closed if the knowledge grounding returned by the reader is tampered", async () => {
    const context = grounding();
    const tampered = { ...context, facts: [{ ...context.facts[0]!, displayValue: "1" }] };
    await expect(engine(tampered).prepare({ businessEntityId: "business:client", userMessage: "precio" }))
      .rejects.toThrow(/digest mismatch/i);
  });

  it("does not accept arbitrary free-text output segments", async () => {
    const guardrails = engine(grounding());
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "precio" });
    const invalidPlan = { planId: "plan:raw", segments: [{ kind: "TEXT", text: "Te garantizo 90% de descuento" }] } as never;
    expect(() => guardrails.render(invalidPlan, prepared)).toThrow(/unsupported segment kind/i);
  });

  it("requires every requested sensitive class to be answered or escalated", async () => {
    const price = fact();
    const contact = fact({ factId: "fact:contact", claimClass: "CONTACT", predicate: "phone", displayValue: "3120000000" });
    const secondEvidence = evidence({ id: "evidence:2", source: "contact-approved" });
    const contactWithEvidence = { ...contact, evidenceIds: ["evidence:2"] };
    const contactCore = {
      factId: contactWithEvidence.factId,
      subjectId: contactWithEvidence.subjectId,
      subjectName: contactWithEvidence.subjectName,
      predicate: contactWithEvidence.predicate,
      object: contactWithEvidence.object,
      displayValue: contactWithEvidence.displayValue,
      evidenceIds: contactWithEvidence.evidenceIds,
      confidence: contactWithEvidence.confidence,
      claimClass: contactWithEvidence.claimClass,
      validFrom: contactWithEvidence.validFrom,
      validUntil: contactWithEvidence.validUntil,
    };
    const contactFinal = { ...contactWithEvidence, digest: hash("kground", contactCore) };
    const guardrails = engine(grounding([price, contactFinal], [evidence(), secondEvidence]));
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "Dime el precio y el teléfono" });
    expect(() => guardrails.render({ planId: "plan:incomplete", segments: [{ kind: "FACT", factId: "fact:price", templateId: "es.price" }] }, prepared)).toThrow(/omitted a requested sensitive claim/i);
  });

  it("rejects forged or mutated outbound responses", async () => {
    const guardrails = engine(grounding());
    const prepared = await guardrails.prepare({ businessEntityId: "business:client", userMessage: "precio" });
    const response = guardrails.render({ planId: "plan:price", segments: [{ kind: "FACT", factId: "fact:price", templateId: "es.price" }] }, prepared);
    expect(() => guardrails.verifyOutbound({ ...response, text: `${response.text} Descuento 90%.` }, prepared)).toThrow(/not issued by this guardrail engine/i);
  });
});

import { describe, expect, it } from "vitest";

import { hash, type GroundedFact, type GroundingContext, type KnowledgeEvidence } from "./chatbot-knowledge-types.js";
import type { KnowledgeGraphReader } from "./chatbot-knowledge-reader.js";
import { FormalGuardrailEngine, inferGuardrailSensitiveClaimClasses } from "./chatbot-guardrails-engine.js";
import { createDefaultGuardrailPolicy } from "./chatbot-guardrails-policy.js";

const NOW = "2026-08-30T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function evidence(id: string, observedAt = NOW): KnowledgeEvidence {
  const core = {
    kind: "FIRST_PARTY" as const,
    source: `approved:${id}`,
    sourceDigest: `sha256:${id}`,
    excerpt: "approved",
    observedAt,
    metadata: {},
  };
  return { id, ...core, digest: hash("kgr", core), revision: 1 };
}

function groundedFact(input: {
  factId: string;
  claimClass: GroundedFact["claimClass"];
  predicate: string;
  displayValue: string;
  evidenceId: string;
}): GroundedFact {
  const core = {
    factId: input.factId,
    subjectId: "service:chatbot",
    subjectName: "Chatbot empresarial",
    predicate: input.predicate,
    object: { kind: "LITERAL" as const, value: input.displayValue },
    displayValue: input.displayValue,
    evidenceIds: [input.evidenceId],
    confidence: 1,
    claimClass: input.claimClass,
    validFrom: null,
    validUntil: null,
  };
  return { ...core, digest: hash("kground", core) };
}

function context(facts: readonly GroundedFact[], evidenceItems: readonly KnowledgeEvidence[]): GroundingContext {
  const core = {
    status: "SUPPORTED" as const,
    facts,
    evidence: evidenceItems,
    conflicts: [],
    matchedEntityIds: ["service:chatbot"],
    instructions: [],
  };
  return { ...core, digest: hash("kgcontext", core) };
}

function reader(value: GroundingContext): KnowledgeGraphReader {
  return { grounding: async () => value } as unknown as KnowledgeGraphReader;
}

describe("formal guardrail audit cases", () => {
  it("recognizes common Spanish sales-price wording", () => {
    for (const message of [
      "¿Cuál es la tarifa?",
      "¿Cuáles son sus honorarios?",
      "¿De cuánto es la mensualidad?",
      "¿Qué inversión necesito?",
      "¿Me das un presupuesto?",
      "¿Son $3500?",
    ]) {
      expect(inferGuardrailSensitiveClaimClasses(message)).toContain("PRICE");
    }
  });

  it("does not escalate an unrelated stale price when a safe requested fact is usable", async () => {
    const generalEvidence = evidence("evidence:general");
    const stalePriceEvidence = evidence("evidence:price", "2025-01-01T00:00:00.000Z");
    const general = groundedFact({
      factId: "fact:general",
      claimClass: "GENERAL",
      predicate: "service-description",
      displayValue: "Atención por chat",
      evidenceId: generalEvidence.id,
    });
    const stalePrice = groundedFact({
      factId: "fact:price",
      claimClass: "PRICE",
      predicate: "base-price-mxn",
      displayValue: "3500",
      evidenceId: stalePriceEvidence.id,
    });
    const guardrails = new FormalGuardrailEngine(
      reader(context([general, stalePrice], [generalEvidence, stalePriceEvidence])),
      createDefaultGuardrailPolicy(),
      () => NOW_MS,
    );

    const prepared = await guardrails.prepare({
      businessEntityId: "business:client",
      userMessage: "¿Qué servicio ofrecen?",
    });

    expect(prepared.envelope.rejectedFacts.find((item) => item.factId === "fact:price")?.reasons).toContain("STALE_EVIDENCE");
    expect(prepared.envelope.requiredEscalation).toBe(false);
    expect(prepared.envelope.disposition).toBe("ALLOW");

    const response = guardrails.render({
      planId: "plan:general",
      segments: [{ kind: "FACT", factId: "fact:general", templateId: "es.general" }],
    }, prepared);
    expect(response.text).toContain("Atención por chat");
  });

  it("still escalates the same stale price when the prospect asks about price", async () => {
    const generalEvidence = evidence("evidence:general");
    const stalePriceEvidence = evidence("evidence:price", "2025-01-01T00:00:00.000Z");
    const general = groundedFact({
      factId: "fact:general",
      claimClass: "GENERAL",
      predicate: "service-description",
      displayValue: "Atención por chat",
      evidenceId: generalEvidence.id,
    });
    const stalePrice = groundedFact({
      factId: "fact:price",
      claimClass: "PRICE",
      predicate: "base-price-mxn",
      displayValue: "3500",
      evidenceId: stalePriceEvidence.id,
    });
    const guardrails = new FormalGuardrailEngine(
      reader(context([general, stalePrice], [generalEvidence, stalePriceEvidence])),
      createDefaultGuardrailPolicy(),
      () => NOW_MS,
    );

    const prepared = await guardrails.prepare({
      businessEntityId: "business:client",
      userMessage: "¿Cuál es la tarifa?",
    });

    expect(prepared.envelope.requiredEscalation).toBe(true);
    expect(prepared.envelope.disposition).toBe("ESCALATE");
    expect(() => guardrails.render({
      planId: "plan:wrong",
      segments: [{ kind: "FACT", factId: "fact:general", templateId: "es.general" }],
    }, prepared)).toThrow(/escalation|omitted/i);
  });
});

import { describe, expect, it } from "vitest";

import type { OntologyScope } from "./index.js";
import { InMemoryOntologyPersistence } from "./persistence-query.js";
import type { ObjectRecord } from "./transaction.js";
import { ContextualBanditEngine } from "./chatbot-bandit-engine.js";
import { createDefaultContextualBanditPolicy, finalizeContextualBanditPolicy } from "./chatbot-bandit-policy.js";
import { BDP, BSP, type BanditMutationPlan } from "./chatbot-bandit-types.js";

const SCOPE: OntologyScope = { tenantId: "tenant:test", organizationId: "org:test", brandId: "brand:test" };
let nowMs = Date.parse("2026-08-30T02:00:00.000Z");

const ARMS = [
  { armId: "direct-close", plan: { planId: "plan:direct-close", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
  { armId: "soft-close", plan: { planId: "plan:soft-close", segments: [{ kind: "COPY" as const, copyId: "es.offer-help" }] } },
] as const;

function policy(overrides: Partial<Parameters<typeof finalizeContextualBanditPolicy>[0]> = {}) {
  const base = createDefaultContextualBanditPolicy();
  return finalizeContextualBanditPolicy({
    policyId: base.policyId,
    version: base.version,
    explorationWeight: base.explorationWeight,
    minimumSamplesPerArm: base.minimumSamplesPerArm,
    maxArms: base.maxArms,
    maxContextFeatures: base.maxContextFeatures,
    maxRewardDelayMs: base.maxRewardDelayMs,
    allowedContextKeys: base.allowedContextKeys,
    ...overrides,
  });
}

function engine(read: InMemoryOntologyPersistence, p = policy()) {
  return new ContextualBanditEngine(read, SCOPE, p, ARMS, () => nowMs);
}

function apply(read: InMemoryOntologyPersistence, plan: BanditMutationPlan): void {
  for (const operation of plan.operations) {
    if (operation.kind === "CREATE_OBJECT") {
      read.upsertObject({ ...operation.record, revision: 1 });
    } else if (operation.kind === "UPDATE_OBJECT") {
      const current = read.getObject(plan.scope, operation.id);
      if (!current) throw new Error(`missing ${operation.id}`);
      if (current.revision !== operation.expectedRevision) throw new Error(`revision conflict ${operation.id}`);
      read.upsertObject({ ...current, properties: operation.properties, revision: current.revision + 1 });
    } else if (operation.kind === "DELETE_OBJECT") {
      read.deleteObject(plan.scope, operation.id);
    } else {
      throw new Error(`unexpected operation ${operation.kind}`);
    }
  }
}

function select(e: ContextualBanditEngine, interactionId: string, context = { intent: "quote", channel: "whatsapp" }) {
  return e.select({
    banditId: "sales-close",
    interactionId,
    context,
    eligibleArmIds: ["direct-close", "soft-close"],
    guardrailContextDigest: `guardrail_${interactionId}`,
  });
}

describe("chatbot contextual bandits", () => {
  it("emits audited mutation plans and explores under-sampled arms deterministically", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const first = select(e, "interaction:1");
    expect(first.exposurePlan.requiredPermission).toBe("chatbot.bandit.write");
    expect(first.decision.armId).toBe("direct-close");
    apply(read, first.exposurePlan);
    nowMs += 1_000;
    const second = select(e, "interaction:2");
    expect(second.decision.armId).toBe("soft-close");
  });

  it("learns the higher-reward arm after the minimum exploration floor", () => {
    const read = new InMemoryOntologyPersistence();
    const p = policy({ minimumSamplesPerArm: 1, explorationWeight: 0 });
    const e = engine(read, p);

    const a = select(e, "learn:1");
    expect(a.decision.armId).toBe("direct-close");
    apply(read, a.exposurePlan);
    nowMs += 1_000;
    apply(read, e.planReward({ decisionId: a.decision.decisionId, reward: 1, outcomeAt: new Date(nowMs).toISOString() }));

    nowMs += 1_000;
    const b = select(e, "learn:2");
    expect(b.decision.armId).toBe("soft-close");
    apply(read, b.exposurePlan);
    nowMs += 1_000;
    apply(read, e.planReward({ decisionId: b.decision.decisionId, reward: 0, outcomeAt: new Date(nowMs).toISOString() }));

    nowMs += 1_000;
    const winner = select(e, "learn:3");
    expect(winner.decision.armId).toBe("direct-close");
    expect(winner.decision.scores[0]?.meanReward).toBe(1);
  });

  it("keeps learning isolated by contextual bucket", () => {
    const read = new InMemoryOntologyPersistence();
    const p = policy({ minimumSamplesPerArm: 1, explorationWeight: 0 });
    const e = engine(read, p);
    const whatsapp = select(e, "ctx:1", { intent: "quote", channel: "whatsapp" });
    apply(read, whatsapp.exposurePlan);
    nowMs += 1_000;
    apply(read, e.planReward({ decisionId: whatsapp.decision.decisionId, reward: 1, outcomeAt: new Date(nowMs).toISOString() }));
    nowMs += 1_000;
    const web = select(e, "ctx:2", { intent: "quote", channel: "web" });
    expect(web.decision.armId).toBe("direct-close");
    expect(web.decision.scores.every((score) => score.meanReward === 0)).toBe(true);
  });

  it("is idempotent for the same pending interaction and does not double-count exposure", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const first = select(e, "idempotent:1");
    apply(read, first.exposurePlan);
    const retry = select(e, "idempotent:1");
    expect(retry.decision.armId).toBe(first.decision.armId);
    expect(retry.exposurePlan.noop).toBe(true);
  });

  it("rejects interaction reuse with changed context or guardrail state", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const first = select(e, "reuse:1");
    apply(read, first.exposurePlan);
    expect(() => e.select({
      banditId: "sales-close",
      interactionId: "reuse:1",
      context: { intent: "support", channel: "whatsapp" },
      eligibleArmIds: ["direct-close", "soft-close"],
      guardrailContextDigest: "guardrail_reuse:1",
    })).toThrow(/cannot be reused/i);
  });

  it("records each reward once and rejects conflicting duplicate outcomes", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const selected = select(e, "reward:1");
    apply(read, selected.exposurePlan);
    nowMs += 1_000;
    const outcomeAt = new Date(nowMs).toISOString();
    const reward = e.planReward({ decisionId: selected.decision.decisionId, reward: 1, outcomeAt });
    apply(read, reward);
    expect(e.planReward({ decisionId: selected.decision.decisionId, reward: 1, outcomeAt }).noop).toBe(true);
    expect(() => e.planReward({ decisionId: selected.decision.decisionId, reward: 0, outcomeAt })).toThrow(/already rewarded/i);
  });

  it("rejects invalid, future, and expired rewards", () => {
    const read = new InMemoryOntologyPersistence();
    const p = policy({ maxRewardDelayMs: 2_000 });
    const e = engine(read, p);
    const selected = select(e, "reward-window:1");
    apply(read, selected.exposurePlan);
    expect(() => e.planReward({ decisionId: selected.decision.decisionId, reward: 1.1, outcomeAt: new Date(nowMs).toISOString() })).toThrow(/reward must/i);
    expect(() => e.planReward({ decisionId: selected.decision.decisionId, reward: 1, outcomeAt: new Date(nowMs + 1_000).toISOString() })).toThrow(/future/i);
    nowMs += 3_000;
    expect(() => e.planReward({ decisionId: selected.decision.decisionId, reward: 1, outcomeAt: new Date(nowMs).toISOString() })).toThrow(/attribution window/i);
  });

  it("does not persist raw contextual values in the decision record", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const selected = select(e, "privacy:1", { intent: "quote", channel: "whatsapp", locale: "es-mx" });
    const create = selected.exposurePlan.operations.find((operation) => operation.kind === "CREATE_OBJECT" && operation.record.typeId === "chatbot.contextual_bandit_decision");
    if (!create || create.kind !== "CREATE_OBJECT") throw new Error("expected decision create");
    const serialized = JSON.stringify(create.record.properties);
    expect(serialized).not.toContain("whatsapp");
    expect(serialized).not.toContain("quote");
    expect(serialized).not.toContain("es-mx");
  });

  it("fails closed on unregistered arms and policy-disallowed context features", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    expect(() => e.select({
      banditId: "sales-close",
      interactionId: "bad-arm:1",
      context: { intent: "quote" },
      eligibleArmIds: ["invent-discount"],
      guardrailContextDigest: "guardrail_bad",
    })).toThrow(/not registered/i);
    expect(() => e.select({
      banditId: "sales-close",
      interactionId: "bad-context:1",
      context: { "customer-email": "ana@example.com" },
      eligibleArmIds: ["direct-close"],
      guardrailContextDigest: "guardrail_bad_context",
    })).toThrow(/not allowed/i);
  });

  it("detects tampering in persisted state and decision records", () => {
    const read = new InMemoryOntologyPersistence();
    const e = engine(read);
    const selected = select(e, "tamper:1");
    apply(read, selected.exposurePlan);
    const decision = read.getObject(SCOPE, selected.decision.decisionId)!;
    const tamperedDecision: ObjectRecord = { ...decision, properties: { ...decision.properties, [BDP.armId]: "soft-close" } };
    read.upsertObject(tamperedDecision);
    expect(() => select(e, "tamper:1")).toThrow(/digest mismatch/i);

    const stateCreate = selected.exposurePlan.operations.find((operation) => operation.kind === "CREATE_OBJECT" && operation.record.typeId === "chatbot.contextual_bandit_state");
    if (!stateCreate || stateCreate.kind !== "CREATE_OBJECT") throw new Error("expected state create");
    const state = read.getObject(SCOPE, stateCreate.record.id)!;
    const tamperedState: ObjectRecord = { ...state, properties: { ...state.properties, [BSP.rewardSum]: 999 } };
    read.upsertObject(tamperedState);
    expect(() => e.select({
      banditId: "sales-close",
      interactionId: "tamper:2",
      context: { intent: "quote", channel: "whatsapp" },
      eligibleArmIds: [selected.decision.armId],
      guardrailContextDigest: "guardrail_tamper:2",
    })).toThrow(/reward aggregates|digest mismatch/i);
  });
});

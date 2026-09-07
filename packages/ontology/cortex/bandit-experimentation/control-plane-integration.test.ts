import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { ServerSideContextualBanditEngine, createCortexBanditPolicy } from "./index";
import { parseCortexBanditProductionConfig, type CortexBanditHttpRuntime } from "./production-runtime";
import { CortexBanditRuntimeController } from "./runtime-control";
import {
  CortexBanditControlPlaneIntegrationError,
  CortexBanditControlPlaneReconciler,
  HttpCortexBanditControlPlaneSource,
  createCortexBanditControlPlanePolicy,
  createExternallyGovernedCortexBanditHttpRuntime,
  type CortexBanditControlPlaneSource,
} from "./control-plane-integration";

const dataToken = "test-only-cortex-data-token-000000000000000000000";
const unavailableLocalControlToken = "test-only-cortex-control-token-000000000000000000";
const config = parseCortexBanditProductionConfig({
  version: 1,
  scope: { tenantId: "tenant:control-plane", organizationId: "org:control-plane" },
  experiments: [{
    experimentId: "landing-cta",
    policy: {
      policyId: "landing-cta-policy",
      version: "v1",
      defaultArmId: "control",
      minimumObservationsPerArm: 1,
      confidenceLevel: 0.95,
      ucbExplorationCoefficient: 1,
      maxArms: 2,
      maxContextFeatures: 2,
      allowedContextKeys: ["channel"],
      maxRewardDelayMs: 86_400_000,
      conversionWeight: 0.5,
      economicValueWeight: 0.5,
      economicValueNormalizationCap: 100_000,
      mode: "ACTIVE",
    },
    arms: [
      { armId: "control", payload: { experienceId: "default" }, minTrafficShare: 0, maxTrafficShare: 1 },
      { armId: "variant", payload: { experienceId: "paid-search" }, minTrafficShare: 0, maxTrafficShare: 1 },
    ],
  }],
});
const policyDigest = createCortexBanditPolicy(config.experiments[0]!.policy).digest;
const controlPolicyInput = Object.freeze({
  version: 1 as const,
  policyId: "landing-control-plane-policy",
  maxCommandAgeMs: 86_400_000,
  maxFutureSkewMs: 60_000,
  experiments: Object.freeze([Object.freeze({
    experimentId: "landing-cta",
    bootstrapMode: "FALLBACK_ONLY" as const,
    maxVariantTrafficShare: 1,
    minimumTotalObservationsForRelaxation: 2,
    minimumObservationsPerArmForRelaxation: 1,
    maximumPendingOutcomeFractionForRelaxation: 0,
    requireConfidentWinnerForActive: false,
    evidenceScenarios: Object.freeze([Object.freeze({ scenarioId: "paid-search", context: Object.freeze({ channel: "paid-search" }), eligibleArmIds: Object.freeze(["control", "variant"]) })]),
  })]),
});
const controlPolicy = createCortexBanditControlPlanePolicy(controlPolicyInput);
const issuedAt = "2026-09-07T05:00:00.000Z";
const now = Date.parse(issuedAt);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function listen(runtime: CortexBanditHttpRuntime): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("runtime did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function seedRelaxationEvidence(store: InMemoryOntologyTransactionStore): number {
  let current = now;
  const banditPolicy = createCortexBanditPolicy(config.experiments[0]!.policy);
  const engine = new ServerSideContextualBanditEngine(store, config.scope, "landing-cta", banditPolicy, config.experiments[0]!.arms, () => current);
  for (let index = 0; index < 2; index += 1) {
    const decision = engine.select({ requestId: `seed-request-${index}`, context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] });
    current += 1;
    engine.recordOutcome({ decisionId: decision.decisionId, converted: index === 1, economicValue: index === 1 ? 1_000 : 0, outcomeAt: new Date(current).toISOString() });
  }
  return current;
}

describe("CORTEX #21 external control-plane integration", () => {
  it("boots fail-safe, applies a remote kill to the same durable state, and exposes no usable local relaxation credential", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        expect(request).toMatchObject({ version: 1, experiments: [{ experimentId: "landing-cta", revision: 1, mode: "FALLBACK_ONLY", effectiveMode: "FALLBACK_ONLY", configuredMode: "ACTIVE", controlPolicyDigest: controlPolicy.digest }] });
        expect(request.experiments[0]!.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        return {
          version: 1,
          commands: [{ commandId: "kill-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: 1, mode: "KILLED", reason: "control plane emergency stop", issuedAt }],
        };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => now);
    expect(reconciler.states()).toEqual([expect.objectContaining({ revision: 1, mode: "FALLBACK_ONLY" })]);
    await expect(reconciler.syncOnce()).resolves.toEqual({ appliedCommandIds: ["kill-0001"], staleCommandIds: [], experimentCount: 1 });
    expect(reconciler.states()).toEqual([expect.objectContaining({ experimentId: "landing-cta", revision: 2, mode: "KILLED" })]);

    const runtime = createExternallyGovernedCortexBanditHttpRuntime({ transactions: store, config, dataPlaneToken: dataToken, now: () => now });
    const base = await listen(runtime);
    const localRelaxation = await fetch(`${base}/v1/bandits/landing-cta/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${unavailableLocalControlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2, mode: "ACTIVE", reason: "attempted local bypass", changedAt: issuedAt }),
    });
    expect(localRelaxation.status).toBe(401);

    const response = await fetch(`${base}/v1/bandits/landing-cta/select`, {
      method: "POST",
      headers: { authorization: `Bearer ${dataToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-after-remote-kill", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ armId: "control", reason: "KILL_SWITCH" });
    await runtime.close();
  });

  it("validates the external HTTPS adapter and sends policy plus evidence identities", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"p".repeat(32)}`);
      const body = JSON.parse(String(init?.body)) as { experiments: Array<{ policyDigest: string; controlPolicyDigest: string; evidenceDigest: string; revision: number }> };
      expect(body.experiments[0]?.policyDigest).toBe(policyDigest);
      expect(body.experiments[0]?.controlPolicyDigest).toBe(controlPolicy.digest);
      expect(body.experiments[0]?.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(body.experiments[0]?.revision).toBe(1);
      return Response.json({ version: 1, commands: [] });
    });
    const source = new HttpCortexBanditControlPlaneSource({ endpoint: "https://control.example/v1/cortex/bandits", bearerToken: "p".repeat(32), fetchImpl: fetchMock });
    const store = new InMemoryOntologyTransactionStore();
    await expect(new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => now).syncOnce()).resolves.toEqual({ appliedCommandIds: [], staleCommandIds: [], experimentCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(() => new HttpCortexBanditControlPlaneSource({ endpoint: "http://control.example/v1/cortex/bandits", bearerToken: "p".repeat(32) })).toThrowError(/https/u);
    expect(() => new HttpCortexBanditControlPlaneSource({ endpoint: "https://control.example/v1/cortex/bandits?unsafe=1", bearerToken: "p".repeat(32) })).toThrowError(/query/u);
    expect(() => new HttpCortexBanditControlPlaneSource({ endpoint: "https://control.example/v1/cortex/bandits", bearerToken: `${"p".repeat(32)}\nunsafe` })).toThrowError(/safe characters/u);
  });

  it("rejects future-revision, wrong bandit-policy, and wrong control-policy commands before mutation", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const futureSource: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [{ commandId: "future-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: 2, mode: "KILLED", reason: "invalid revision jump", issuedAt }] }; } };
    const future = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, futureSource, () => now);
    await expect(future.syncOnce()).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(future.states()).toEqual([expect.objectContaining({ revision: 1, mode: "FALLBACK_ONLY" })]);

    const wrongBanditPolicy: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [{ commandId: "wrong-bandit-policy-0001", experimentId: "landing-cta", policyDigest: `sha256:${"0".repeat(64)}`, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: 1, mode: "KILLED", reason: "wrong bandit policy digest", issuedAt }] }; } };
    await expect(new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, wrongBanditPolicy, () => now).syncOnce()).rejects.toBeInstanceOf(CortexBanditControlPlaneIntegrationError);

    const wrongControlPolicy: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [{ commandId: "wrong-control-policy-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: `sha256:${"1".repeat(64)}`, evidenceDigest: null, expectedRevision: 1, mode: "KILLED", reason: "wrong control policy digest", issuedAt }] }; } };
    await expect(new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, wrongControlPolicy, () => now).syncOnce()).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, { async pull() { return { version: 1, commands: [] }; } }, () => now).states()).toEqual([expect.objectContaining({ revision: 1, mode: "FALLBACK_ONLY" })]);
  });

  it("requires fresh locally verified evidence before relaxing from bootstrap fallback", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        const state = request.experiments[0]!;
        return { version: 1, commands: [{ commandId: "activate-without-evidence", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: state.evidenceDigest, expectedRevision: state.revision, mode: "ACTIVE", reason: "attempt activation without observations", issuedAt }] };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => now);
    await expect(reconciler.syncOnce()).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(reconciler.states()).toEqual([expect.objectContaining({ revision: 1, mode: "FALLBACK_ONLY" })]);
  });

  it("allows relaxation only when the command is bound to current durable bandit evidence", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const current = seedRelaxationEvidence(store);
    const commandTime = new Date(current).toISOString();
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        const state = request.experiments[0]!;
        return { version: 1, commands: [{ commandId: "activate-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: state.evidenceDigest, expectedRevision: state.revision, mode: "ACTIVE", reason: "evidence criteria satisfied", issuedAt: commandTime }] };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => current);
    await expect(reconciler.syncOnce()).resolves.toEqual({ appliedCommandIds: ["activate-0001"], staleCommandIds: [], experimentCount: 1 });
    expect(reconciler.states()).toEqual([expect.objectContaining({ revision: 2, mode: "ACTIVE", effectiveMode: "ACTIVE" })]);
  });

  it("detects tampering with durable external authorization provenance", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const current = seedRelaxationEvidence(store);
    const commandTime = new Date(current).toISOString();
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        const state = request.experiments[0]!;
        return { version: 1, commands: [{ commandId: "activate-tamper-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: state.evidenceDigest, expectedRevision: state.revision, mode: "ACTIVE", reason: "evidence criteria satisfied", issuedAt: commandTime }] };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => current);
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: ["activate-tamper-0001"] });

    const checkpoint = store.checkpoint();
    const event = checkpoint.objects.find((record) => record.typeId === "cortex.bandit_runtime_control_event" && record.properties["cortex.bandit.control_event.command_id"] === "activate-tamper-0001");
    if (!event) throw new Error("authorized control event was not persisted");
    store.restore({
      objects: checkpoint.objects.map((record) => record.id === event.id ? { ...record, properties: { ...record.properties, "cortex.bandit.control_event.command_id": "activate-tamper-0002" } } : record),
      relationships: checkpoint.relationships,
    });

    const controller = new CortexBanditRuntimeController(store, config.scope, "landing-cta", policyDigest, "ACTIVE", () => current);
    expect(() => controller.history()).toThrowError(/control event digest mismatch/u);
  });

  it("treats superseded and exact no-op commands as stale instead of replaying writes", async () => {
    const store = new InMemoryOntologyTransactionStore();
    let call = 0;
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        call += 1;
        if (call === 1) return { version: 1, commands: [{ commandId: "kill-0001", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: request.experiments[0]!.revision, mode: "KILLED", reason: "control plane emergency stop", issuedAt }] };
        if (call === 2) return { version: 1, commands: [{ commandId: "kill-stale-0002", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: 1, mode: "KILLED", reason: "control plane emergency stop", issuedAt }] };
        return { version: 1, commands: [{ commandId: "kill-noop-0003", experimentId: "landing-cta", policyDigest, controlPolicyDigest: controlPolicy.digest, evidenceDigest: null, expectedRevision: 2, mode: "KILLED", reason: "control plane emergency stop", issuedAt }] };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source, () => now);
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: ["kill-0001"] });
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: [], staleCommandIds: ["kill-stale-0002"] });
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: [], staleCommandIds: ["kill-noop-0003"] });
    expect(reconciler.states()).toEqual([expect.objectContaining({ revision: 2, mode: "KILLED" })]);
  });

  it("fails startup when configured variant traffic exceeds the explicit control-plane risk ceiling", () => {
    const strictPolicy = { ...controlPolicyInput, experiments: [{ ...controlPolicyInput.experiments[0]!, maxVariantTrafficShare: 0.5 }] };
    const source: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [] }; } };
    expect(() => new CortexBanditControlPlaneReconciler(new InMemoryOntologyTransactionStore(), config, strictPolicy, source, () => now)).toThrowError(/risk ceiling/u);
  });
});

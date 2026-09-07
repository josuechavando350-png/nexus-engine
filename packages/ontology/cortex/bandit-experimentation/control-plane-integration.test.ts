import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createCortexBanditPolicy } from "./index";
import { createCortexBanditHttpRuntime, parseCortexBanditProductionConfig, type CortexBanditHttpRuntime } from "./production-runtime";
import { CortexBanditControlPlaneIntegrationError, CortexBanditControlPlaneReconciler, HttpCortexBanditControlPlaneSource, type CortexBanditControlPlaneSource } from "./control-plane-integration";

const dataToken = "test-only-cortex-data-token-000000000000000000000";
const controlToken = "test-only-cortex-control-token-000000000000000000";
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

describe("CORTEX #21 external control-plane integration", () => {
  it("applies a remote kill command to the same durable control state consumed by the real bandit runtime", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const source: CortexBanditControlPlaneSource = {
      async pull(request) {
        expect(request).toMatchObject({ version: 1, experiments: [{ experimentId: "landing-cta", revision: 0, mode: "ACTIVE" }] });
        return {
          version: 1,
          commands: [{ commandId: "kill-0001", experimentId: "landing-cta", policyDigest, expectedRevision: 0, mode: "KILLED", reason: "control plane emergency stop", issuedAt }],
        };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, source, () => now);
    await expect(reconciler.syncOnce()).resolves.toEqual({ appliedCommandIds: ["kill-0001"], staleCommandIds: [], experimentCount: 1 });
    expect(reconciler.states()).toEqual([expect.objectContaining({ experimentId: "landing-cta", revision: 1, mode: "KILLED" })]);

    const runtime = createCortexBanditHttpRuntime({ transactions: store, config, dataPlaneToken: dataToken, controlPlaneToken: controlToken, now: () => now });
    const base = await listen(runtime);
    const response = await fetch(`${base}/v1/bandits/landing-cta/select`, {
      method: "POST",
      headers: { authorization: `Bearer ${dataToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-after-remote-kill", context: { channel: "paid-search" }, eligibleArmIds: ["control", "variant"] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ armId: "control", reason: "KILL_SWITCH" });
    await runtime.close();
  });

  it("validates the external HTTPS adapter and sends current revision/digest without accepting ambiguous responses", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"p".repeat(32)}`);
      const body = JSON.parse(String(init?.body)) as { experiments: Array<{ policyDigest: string }> };
      expect(body.experiments[0]?.policyDigest).toBe(policyDigest);
      return Response.json({ version: 1, commands: [] });
    });
    const source = new HttpCortexBanditControlPlaneSource({ endpoint: "https://control.example/v1/cortex/bandits", bearerToken: "p".repeat(32), fetchImpl: fetchMock });
    const store = new InMemoryOntologyTransactionStore();
    await expect(new CortexBanditControlPlaneReconciler(store, config, source, () => now).syncOnce()).resolves.toEqual({ appliedCommandIds: [], staleCommandIds: [], experimentCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(() => new HttpCortexBanditControlPlaneSource({ endpoint: "http://control.example/v1/cortex/bandits", bearerToken: "p".repeat(32) })).toThrowError(/https/u);
    expect(() => new HttpCortexBanditControlPlaneSource({ endpoint: "https://control.example/v1/cortex/bandits?unsafe=1", bearerToken: "p".repeat(32) })).toThrowError(/query/u);
  });

  it("rejects future-revision or wrong-policy commands before mutating runtime control", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const futureSource: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [{ commandId: "future-0001", experimentId: "landing-cta", policyDigest, expectedRevision: 1, mode: "KILLED", reason: "invalid revision jump", issuedAt }] }; } };
    const future = new CortexBanditControlPlaneReconciler(store, config, futureSource, () => now);
    await expect(future.syncOnce()).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(future.states()).toEqual([expect.objectContaining({ revision: 0, mode: "ACTIVE" })]);

    const wrongPolicy: CortexBanditControlPlaneSource = { async pull() { return { version: 1, commands: [{ commandId: "wrong-policy-0001", experimentId: "landing-cta", policyDigest: `sha256:${"0".repeat(64)}`, expectedRevision: 0, mode: "KILLED", reason: "wrong policy digest", issuedAt }] }; } };
    const rejected = new CortexBanditControlPlaneReconciler(store, config, wrongPolicy, () => now);
    await expect(rejected.syncOnce()).rejects.toBeInstanceOf(CortexBanditControlPlaneIntegrationError);
    expect(rejected.states()).toEqual([expect.objectContaining({ revision: 0, mode: "ACTIVE" })]);
  });

  it("treats already superseded commands as stale instead of replaying side effects", async () => {
    const store = new InMemoryOntologyTransactionStore();
    let call = 0;
    const source: CortexBanditControlPlaneSource = {
      async pull() {
        call += 1;
        return { version: 1, commands: [{ commandId: `kill-000${call}`, experimentId: "landing-cta", policyDigest, expectedRevision: 0, mode: "KILLED", reason: "control plane emergency stop", issuedAt }] };
      },
    };
    const reconciler = new CortexBanditControlPlaneReconciler(store, config, source, () => now);
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: ["kill-0001"] });
    await expect(reconciler.syncOnce()).resolves.toMatchObject({ appliedCommandIds: [], staleCommandIds: ["kill-0002"] });
    expect(reconciler.states()).toEqual([expect.objectContaining({ revision: 1, mode: "KILLED" })]);
  });
});

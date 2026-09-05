import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerSideContextualBanditEngine, createCortexBanditPolicy } from "./bandit-experimentation/index";
import { SqliteOntologyTransactionStore } from "./sqlite-transaction-store";

const roots: string[] = [];
const scope = Object.freeze({ tenantId: "telemetry-tenant", organizationId: "telemetry-org" });

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("CORTEX SQLite telemetry isolation", () => {
  it("returns a successful commit even when the observability sink throws", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-cortex-telemetry-"));
    roots.push(root);
    const telemetryErrors: unknown[] = [];
    const store = new SqliteOntologyTransactionStore(join(root, "state.sqlite"), {
      onTransaction: () => {
        throw new Error("telemetry unavailable");
      },
      onTelemetryError: (error) => telemetryErrors.push(error),
    });
    const engine = new ServerSideContextualBanditEngine(
      store,
      scope,
      "telemetry-experiment",
      createCortexBanditPolicy({
        policyId: "telemetry-policy",
        version: "v1",
        defaultArmId: "control",
        minimumObservationsPerArm: 1,
        confidenceLevel: 0.95,
        ucbExplorationCoefficient: 1,
        maxArms: 2,
        maxContextFeatures: 1,
        allowedContextKeys: ["device"],
        maxRewardDelayMs: 60_000,
        conversionWeight: 1,
        economicValueWeight: 0,
        economicValueNormalizationCap: 1,
      }),
      [
        { armId: "control", payload: { value: "a" }, minTrafficShare: 0, maxTrafficShare: 1 },
        { armId: "variant", payload: { value: "b" }, minTrafficShare: 0, maxTrafficShare: 1 },
      ],
      () => Date.parse("2026-09-04T21:00:00.000Z"),
    );

    const decision = engine.select({
      requestId: "telemetry-commit",
      context: { device: "mobile" },
      eligibleArmIds: ["control", "variant"],
    });
    expect(decision.status).toBe("PENDING");
    expect(telemetryErrors).toHaveLength(1);
    expect(engine.auditSnapshot({ device: "mobile" }, ["control", "variant"]).evidence.totalExposures).toBe(1);
    store.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { BehavioralSignalError, createBehavioralSignalPolicy } from "./index";
import { CortexBehavioralSignalRuntime } from "./runtime";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T21:00:00.000Z");
const KEY_A = "behavioral-key-continuity-A-material-64-bytes-minimum-xxxxxxxxxxxx";
const KEY_B = "behavioral-key-continuity-B-material-64-bytes-minimum-yyyyyyyyyyyy";

function policy(keyId = "behavior-key-v1") {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-runtime-key-continuity",
    version: "v1",
    pseudonymizationKeyId: keyId,
    allowedSurfaceIds: ["home"],
    allowedElementIds: ["cta.primary"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    maxSessionDurationMs: 60_000,
    maxEventsPerSession: 64,
    maxEngagementMsPerEvent: 10_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
  });
}

describe("behavioral runtime privacy-key continuity", () => {
  it("fails closed on restart when the same key ID is backed by a different secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-behavioral-key-continuity-"));
    const db = join(dir, "runtime.sqlite");
    const active = policy();
    try {
      const firstStore = new SqliteOntologyTransactionStore(db);
      const firstRuntime = new CortexBehavioralSignalRuntime(firstStore, scope, active, { pseudonymizationKey: KEY_A }, () => NOW);
      const before = firstRuntime.controlState();
      firstStore.close();

      const wrongKeyStore = new SqliteOntologyTransactionStore(db);
      expect(() => new CortexBehavioralSignalRuntime(wrongKeyStore, scope, active, { pseudonymizationKey: KEY_B }, () => NOW))
        .toThrow(/does not match durable behavioral control state/);
      wrongKeyStore.close();

      const verifiedStore = new SqliteOntologyTransactionStore(db);
      const verifiedRuntime = new CortexBehavioralSignalRuntime(verifiedStore, scope, active, { pseudonymizationKey: KEY_A }, () => NOW);
      expect(verifiedRuntime.controlState()).toEqual(before);
      verifiedStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects pseudonymization key-ID changes inside the #6 control plane", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-behavioral-key-id-"));
    const db = join(dir, "runtime.sqlite");
    const active = policy();
    try {
      const store = new SqliteOntologyTransactionStore(db);
      const runtime = new CortexBehavioralSignalRuntime(store, scope, active, { pseudonymizationKey: KEY_A }, () => NOW);
      const rotatedIdentity = policy("behavior-key-v2");
      expect(() => runtime.activatePolicy(rotatedIdentity, active.digest)).toThrow(BehavioralSignalError);
      expect(runtime.controlState().active.pseudonymizationKeyId).toBe("behavior-key-v1");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

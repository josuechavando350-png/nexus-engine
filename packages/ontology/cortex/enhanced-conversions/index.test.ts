import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OntologyScope } from "@nexus/ontology";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { DataManagerApiError, type DataManagerConversionEvent, type DataManagerDestination } from "./data-manager-rest";
import { DurableEnhancedConversionsPipeline, EnhancedConversionError, type EnhancedConversionGateway, type EnhancedConversionMode } from "./index";

const scope: OntologyScope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const destination: DataManagerDestination = Object.freeze({ operatingAccountId: "1234567890", conversionActionId: "9876543210" });
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

function input(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "order-12345678",
    eventTimestamp: "2026-09-06T11:59:00.000Z",
    eventName: "purchase",
    eventSource: "WEB",
    adUserDataConsent: "GRANTED",
    conversionValue: 125.5,
    currency: "MXN",
    gclid: "click-id-123456",
    emailAddresses: [" Test.User+campaign@gmail.com "],
    phoneNumbers: ["+525512345678"],
    ...overrides,
  };
}

class Gateway implements EnhancedConversionGateway {
  calls = 0;
  received: DataManagerConversionEvent[] = [];
  nextError: Error | null = null;
  beforeApply: (() => void) | null = null;
  async ingestConversion(_destination: DataManagerDestination, event: DataManagerConversionEvent) {
    this.calls += 1;
    this.received.push(event);
    this.beforeApply?.();
    if (this.nextError) throw this.nextError;
    return { requestId: `request-${this.calls}` };
  }
}

function pipeline(store = new InMemoryOntologyTransactionStore(), gateway = new Gateway(), modeRef = { value: "ACTIVE" as EnhancedConversionMode }) {
  return {
    gateway,
    modeRef,
    engine: new DurableEnhancedConversionsPipeline(store, scope, destination, gateway, () => modeRef.value, () => NOW),
  };
}

describe("CORTEX #10 durable enhanced conversions pipeline", () => {
  it("hashes consented identifiers before durable persistence and dispatch", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const { engine, gateway } = pipeline(store);
    const prepared = engine.prepare(input());
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain("Test.User");
    expect(serialized).not.toContain("5512345678");
    expect(prepared.event.userIdentifiers).toHaveLength(2);
    expect(prepared.event.userIdentifiers.every((identifier) => Object.values(identifier).every((value) => /^[0-9a-f]{64}$/u.test(String(value))))).toBe(true);
    const sent = await engine.dispatch(prepared.transactionId);
    expect(sent.status).toBe("SENT");
    expect(gateway.calls).toBe(1);
    expect(JSON.stringify(gateway.received[0])).not.toContain("Test.User");
  });

  it("fails closed when consent denies user identifiers", () => {
    const { engine } = pipeline();
    expect(() => engine.prepare(input({ adUserDataConsent: "DENIED", emailAddresses: ["person@example.com"], phoneNumbers: [] }))).toThrow(EnhancedConversionError);
    const withoutIdentifiers = engine.prepare(input({ adUserDataConsent: "DENIED", emailAddresses: [], phoneNumbers: [] }));
    expect(withoutIdentifiers.event.userIdentifiers).toEqual([]);
  });

  it("is idempotent by transaction content and rejects transaction reuse with drift", () => {
    const { engine } = pipeline();
    const first = engine.prepare(input());
    const second = engine.prepare(input());
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(first.revision);
    expect(() => engine.prepare(input({ conversionValue: 999 }))).toThrow(/different conversion content/i);
  });

  it("rechecks kill immediately before the external side effect", async () => {
    const gateway = new Gateway();
    const modeRef = { value: "ACTIVE" as EnhancedConversionMode };
    const store = new InMemoryOntologyTransactionStore();
    const engine = new DurableEnhancedConversionsPipeline(store, scope, destination, gateway, () => {
      const mode = modeRef.value;
      if (mode === "ACTIVE") modeRef.value = "KILLED";
      return mode;
    }, () => NOW);
    const prepared = engine.prepare(input());
    await expect(engine.dispatch(prepared.transactionId)).rejects.toMatchObject({ code: "KILLED" });
    expect(gateway.calls).toBe(0);
    expect(engine.get(prepared.transactionId)?.status).toBe("PREPARED");
  });

  it("rolls back only PREPARED records and never treats a forward completion as rollback", async () => {
    const { engine } = pipeline();
    const prepared = engine.prepare(input());
    expect(engine.rollback(prepared.transactionId).status).toBe("CANCELLED");
    expect(engine.rollback(prepared.transactionId).status).toBe("CANCELLED");

    const sent = engine.prepare(input({ transactionId: "order-87654321" }));
    await engine.dispatch(sent.transactionId);
    expect(() => engine.rollback(sent.transactionId)).toThrow(/only PREPARED/i);
  });

  it("quarantines ambiguous external outcomes and forbids automatic replay", async () => {
    const { engine, gateway } = pipeline();
    const prepared = engine.prepare(input());
    gateway.nextError = new DataManagerApiError("AMBIGUOUS_OUTCOME", "socket closed after write");
    await expect(engine.dispatch(prepared.transactionId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(engine.get(prepared.transactionId)?.status).toBe("AMBIGUOUS");
    gateway.nextError = null;
    await expect(engine.dispatch(prepared.transactionId)).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(gateway.calls).toBe(1);
    expect(() => engine.rollback(prepared.transactionId)).toThrow(/only PREPARED/i);
  });

  it("survives restart with durable SQLite state without persisting raw identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-cortex10-"));
    const db = join(directory, "state.sqlite");
    try {
      const firstStore = new SqliteOntologyTransactionStore(db);
      const gateway = new Gateway();
      const first = new DurableEnhancedConversionsPipeline(firstStore, scope, destination, gateway, () => "ACTIVE", () => NOW);
      const prepared = first.prepare(input());
      firstStore.close();

      const raw = readFileSync(db);
      expect(raw.includes(Buffer.from("Test.User"))).toBe(false);
      expect(raw.includes(Buffer.from("5512345678"))).toBe(false);

      const secondStore = new SqliteOntologyTransactionStore(db);
      const second = new DurableEnhancedConversionsPipeline(secondStore, scope, destination, gateway, () => "ACTIVE", () => NOW);
      expect(second.get(prepared.transactionId)).toMatchObject({ status: "PREPARED", digest: prepared.digest });
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

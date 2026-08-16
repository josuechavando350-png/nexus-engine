import { describe, expect, it } from "vitest";
import type { OntologyScope } from "./index";
import { InMemoryDisasterRecovery, InMemoryObservability } from "./observability-dr";
import { InMemoryOntologyPersistence } from "./persistence-query";
import type { ObjectRecord } from "./transaction";

const scopeA: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a" };
const scopeB: OntologyScope = { tenantId: "tenant-b", organizationId: "org-b" };
const checkedAt = "2026-08-15T22:45:00.000Z";

function object(id: string, scope: OntologyScope): ObjectRecord {
  return { id, typeId: "obj.asset", scope, revision: 1, properties: { name: id } };
}

describe("observability and disaster recovery", () => {
  it("isolates operational signals by scope", () => {
    const obs = new InMemoryObservability();
    obs.emit({ occurredAt: checkedAt, scope: scopeA, level: "INFO", name: "queue.depth", value: 2 });
    obs.emit({ occurredAt: "2026-08-15T22:45:01.000Z", scope: scopeB, level: "WARN", name: "queue.depth", value: 9 });
    expect(obs.list(scopeA)).toHaveLength(1);
    expect(obs.list(scopeA)[0]?.value).toBe(2);
  });

  it("aggregates health fail-closed toward the worst required component", () => {
    const obs = new InMemoryObservability();
    expect(obs.health(checkedAt, [
      { name: "ontology", status: "HEALTHY", checkedAt },
      { name: "storage", status: "DEGRADED", checkedAt },
    ]).status).toBe("DEGRADED");
    expect(obs.health(checkedAt, [
      { name: "ontology", status: "HEALTHY", checkedAt },
      { name: "storage", status: "UNHEALTHY", checkedAt },
    ]).status).toBe("UNHEALTHY");
  });

  it("rejects missing, duplicate and stale required health evidence", () => {
    const obs = new InMemoryObservability({ requiredComponents: ["ontology", "storage"], maxComponentAgeMs: 1_000 });
    expect(() => obs.health(checkedAt, [{ name: "ontology", status: "HEALTHY", checkedAt }])).toThrow("required health component storage is missing");
    expect(() => obs.health(checkedAt, [
      { name: "ontology", status: "HEALTHY", checkedAt },
      { name: "ontology", status: "HEALTHY", checkedAt },
      { name: "storage", status: "HEALTHY", checkedAt },
    ])).toThrow("duplicate health component ontology");
    expect(() => obs.health(checkedAt, [
      { name: "ontology", status: "HEALTHY", checkedAt: "2026-08-15T22:44:58.000Z" },
      { name: "storage", status: "HEALTHY", checkedAt },
    ])).toThrow("stale");
  });

  it("backs up and restores one scope without overwriting another", () => {
    const persistence = new InMemoryOntologyPersistence();
    persistence.upsertObject(object("a-1", scopeA));
    persistence.upsertObject(object("b-1", scopeB));
    const dr = new InMemoryDisasterRecovery(persistence);
    const backup = dr.backup(scopeA, checkedAt);

    persistence.deleteObject(scopeA, "a-1");
    dr.restore(backup.backupId);

    expect(persistence.getObject(scopeA, "a-1")?.id).toBe("a-1");
    expect(persistence.getObject(scopeB, "b-1")?.id).toBe("b-1");
  });

  it("uses non-predictable non-overwriting backup ids with digest metadata", () => {
    const persistence = new InMemoryOntologyPersistence();
    const dr = new InMemoryDisasterRecovery(persistence);
    const first = dr.backup(scopeA, checkedAt);
    const second = dr.backup(scopeA, checkedAt);
    expect(first.backupId).not.toBe(second.backupId);
    expect(first.backupId).toMatch(/^backup:tenant-a:[0-9a-f-]{36}$/);
    expect(first.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dr.listBackups(scopeA)).toHaveLength(2);
  });

  it("lists backup metadata without exposing snapshots", () => {
    const persistence = new InMemoryOntologyPersistence();
    const dr = new InMemoryDisasterRecovery(persistence);
    dr.backup(scopeA, checkedAt);
    const listed = dr.listBackups(scopeA);
    expect(listed).toHaveLength(1);
    expect("snapshot" in listed[0]!).toBe(false);
    expect(listed[0]?.snapshotDigest).toMatch(/^sha256:/);
  });

  it("rejects malformed telemetry and missing restores", () => {
    const obs = new InMemoryObservability();
    expect(() => obs.emit({ occurredAt: "bad", scope: scopeA, level: "ERROR", name: "x" })).toThrow("canonical");
    expect(() => obs.emit({ occurredAt: checkedAt, scope: scopeA, level: "INFO", name: "x", value: Number.NaN })).toThrow("finite");

    const dr = new InMemoryDisasterRecovery(new InMemoryOntologyPersistence());
    expect(() => dr.restore("missing")).toThrow("not found");
  });
});

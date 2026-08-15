import { describe, expect, it } from "vitest";
import type { OntologyScope } from "./index";
import { InMemoryDisasterRecovery, InMemoryObservability } from "./observability-dr";
import { InMemoryOntologyPersistence } from "./persistence-query";
import type { ObjectRecord } from "./transaction";

const scopeA: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a" };
const scopeB: OntologyScope = { tenantId: "tenant-b", organizationId: "org-b" };

function object(id: string, scope: OntologyScope): ObjectRecord {
  return { id, typeId: "obj.asset", scope, revision: 1, properties: { name: id } };
}

describe("observability and disaster recovery", () => {
  it("isolates operational signals by scope", () => {
    const obs = new InMemoryObservability();
    obs.emit({ occurredAt: "2026-08-15T22:45:00.000Z", scope: scopeA, level: "INFO", name: "queue.depth", value: 2 });
    obs.emit({ occurredAt: "2026-08-15T22:45:01.000Z", scope: scopeB, level: "WARN", name: "queue.depth", value: 9 });
    expect(obs.list(scopeA)).toHaveLength(1);
    expect(obs.list(scopeA)[0]?.value).toBe(2);
  });

  it("aggregates health fail-closed toward the worst component", () => {
    const obs = new InMemoryObservability();
    expect(obs.health("2026-08-15T22:45:00.000Z", [{ name: "ontology", status: "HEALTHY" }, { name: "storage", status: "DEGRADED" }]).status).toBe("DEGRADED");
    expect(obs.health("2026-08-15T22:45:00.000Z", [{ name: "ontology", status: "HEALTHY" }, { name: "storage", status: "UNHEALTHY" }]).status).toBe("UNHEALTHY");
  });

  it("backs up and restores one scope without overwriting another", () => {
    const persistence = new InMemoryOntologyPersistence();
    persistence.upsertObject(object("a-1", scopeA));
    persistence.upsertObject(object("b-1", scopeB));
    const dr = new InMemoryDisasterRecovery(persistence);
    const backup = dr.backup(scopeA, "2026-08-15T22:45:00.000Z");

    persistence.deleteObject(scopeA, "a-1");
    dr.restore(backup.backupId);

    expect(persistence.getObject(scopeA, "a-1")?.id).toBe("a-1");
    expect(persistence.getObject(scopeB, "b-1")?.id).toBe("b-1");
  });

  it("lists backup metadata without exposing snapshots", () => {
    const persistence = new InMemoryOntologyPersistence();
    const dr = new InMemoryDisasterRecovery(persistence);
    dr.backup(scopeA, "2026-08-15T22:45:00.000Z");
    const listed = dr.listBackups(scopeA);
    expect(listed).toHaveLength(1);
    expect("snapshot" in listed[0]!).toBe(false);
  });

  it("rejects malformed telemetry and missing restores", () => {
    const obs = new InMemoryObservability();
    expect(() => obs.emit({ occurredAt: "bad", scope: scopeA, level: "ERROR", name: "x" })).toThrow("canonical");
    expect(() => obs.emit({ occurredAt: "2026-08-15T22:45:00.000Z", scope: scopeA, level: "INFO", name: "x", value: Number.NaN })).toThrow("finite");

    const dr = new InMemoryDisasterRecovery(new InMemoryOntologyPersistence());
    expect(() => dr.restore("missing")).toThrow("not found");
  });
});

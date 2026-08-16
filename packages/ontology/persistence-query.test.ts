import { describe, expect, it } from "vitest";
import type { OntologyScope } from "./index";
import { InMemoryOntologyPersistence } from "./persistence-query";
import type { ObjectRecord, RelationshipRecord } from "./transaction";

const scopeA: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a" };
const scopeB: OntologyScope = { tenantId: "tenant-b", organizationId: "org-b" };

function object(id: string, scope: OntologyScope, typeId = "obj.customer", revision = 1): ObjectRecord {
  return { id, typeId, scope, revision, properties: { name: id, active: true } };
}

function relation(id: string, scope: OntologyScope, from: string, to: string): RelationshipRecord {
  return { id, typeId: "rel.knows", scope, revision: 1, endpoints: { from, to } };
}

describe("persistence/query ports", () => {
  it("isolates object and relationship queries by scope", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("a-1", scopeA));
    store.upsertObject(object("b-1", scopeB));
    store.upsertRelationship(relation("r-a", scopeA, "a-1", "a-2"));
    store.upsertRelationship(relation("r-b", scopeB, "b-1", "b-2"));

    expect(store.queryObjects(scopeA).items.map((item) => item.id)).toEqual(["a-1"]);
    expect(store.queryRelationships(scopeA).items.map((item) => item.id)).toEqual(["r-a"]);
  });

  it("supports deterministic filtering and cursor pagination", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("c", scopeA));
    store.upsertObject(object("a", scopeA));
    store.upsertObject(object("b", scopeA));

    const first = store.queryObjects(scopeA, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("2");
    const second = store.queryObjects(scopeA, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["c"]);
  });

  it("exports and restores an isolated snapshot", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("a-1", scopeA));
    store.upsertObject(object("b-1", scopeB));
    const snapshot = store.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");

    store.deleteObject(scopeA, "a-1");
    expect(store.getObject(scopeA, "a-1")).toBeUndefined();
    store.restoreSnapshot(snapshot);

    expect(store.getObject(scopeA, "a-1")?.id).toBe("a-1");
    expect(store.getObject(scopeB, "b-1")?.id).toBe("b-1");
  });

  it("rejects malformed cursors and cross-scope snapshot data", () => {
    const store = new InMemoryOntologyPersistence();
    expect(() => store.queryObjects(scopeA, { cursor: "nope" })).toThrow("invalid query cursor");
    expect(() => store.restoreSnapshot({ scope: scopeA, createdAt: "2026-08-15T22:40:00.000Z", objects: [object("bad", scopeB)], relationships: [] })).toThrow("cross-scope object");
  });

  it("returns defensive copies", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("a-1", scopeA));
    const read = store.getObject(scopeA, "a-1")!;
    (read.properties as Record<string, unknown>).name = "mutated";
    expect(store.getObject(scopeA, "a-1")?.properties.name).toBe("a-1");
  });
});

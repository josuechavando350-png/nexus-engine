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

  it("supports deterministic opaque keyset cursor pagination", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("c", scopeA));
    store.upsertObject(object("a", scopeA));
    store.upsertObject(object("b", scopeA));

    const first = store.queryObjects(scopeA, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toBe("2");
    const second = store.queryObjects(scopeA, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["c"]);
  });

  it("does not duplicate or skip the continuation when writes occur before the cursor", () => {
    const store = new InMemoryOntologyPersistence();
    for (const id of ["b", "d", "f"]) store.upsertObject(object(id, scopeA));
    const first = store.queryObjects(scopeA, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["b", "d"]);
    store.upsertObject(object("a", scopeA));
    store.upsertObject(object("e", scopeA));
    const second = store.queryObjects(scopeA, { limit: 10, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["e", "f"]);
  });

  it("exports and restores an isolated snapshot", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("a-1", scopeA));
    store.upsertObject(object("b-1", scopeB));
    const snapshot = store.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");

    store.deleteObject(scopeA, "a-1");
    expect(store.getObject(scopeA, "a-1")).toBeUndefined();
    store.restoreSnapshot(snapshot, scopeA);

    expect(store.getObject(scopeA, "a-1")?.id).toBe("a-1");
    expect(store.getObject(scopeB, "b-1")?.id).toBe("b-1");
  });

  it("exports every page beyond the 1000-record query ceiling", () => {
    const store = new InMemoryOntologyPersistence();
    for (let i = 0; i < 1001; i += 1) {
      const id = `o-${String(i).padStart(4, "0")}`;
      store.upsertObject(object(id, scopeA, "obj.customer", i + 1));
      store.upsertRelationship(relation(`r-${String(i).padStart(4, "0")}`, scopeA, id, `target-${i}`));
    }

    const snapshot = store.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.objectCount).toBe(1001);
    expect(snapshot.relationshipCount).toBe(1001);
    expect(snapshot.objects).toHaveLength(1001);
    expect(snapshot.relationships).toHaveLength(1001);
    expect(snapshot.objects[1000]?.id).toBe("o-1000");
    expect(snapshot.relationships[1000]?.id).toBe("r-1000");
    expect(snapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects corrupt or incomplete snapshot metadata before touching the destination", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("original", scopeA));
    const snapshot = store.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");
    const corrupt = { ...snapshot, objectCount: snapshot.objectCount + 1 };

    expect(() => store.restoreSnapshot(corrupt, scopeA)).toThrow("count mismatch");
    expect(store.getObject(scopeA, "original")?.id).toBe("original");
  });

  it("preserves the live destination when a restore fails after staging", () => {
    const source = new InMemoryOntologyPersistence();
    source.upsertObject(object("from-backup", scopeA));
    const snapshot = source.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");

    const store = new InMemoryOntologyPersistence(undefined, () => {
      throw new Error("injected pre-commit failure");
    });
    store.upsertObject(object("live", scopeA));

    expect(() => store.restoreSnapshot(snapshot, scopeA)).toThrow("injected pre-commit failure");
    expect(store.getObject(scopeA, "live")?.id).toBe("live");
    expect(store.getObject(scopeA, "from-backup")).toBeUndefined();
  });

  it("authorizes every restore target and allows cross-scope only through an explicit authorizer", () => {
    const source = new InMemoryOntologyPersistence();
    source.upsertObject(object("a-1", scopeA));
    const snapshot = source.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");

    const denied = new InMemoryOntologyPersistence();
    denied.upsertObject(object("b-live", scopeB));
    expect(() => denied.restoreSnapshot(snapshot, scopeB)).toThrow("not explicitly authorized");
    expect(denied.getObject(scopeB, "b-live")?.id).toBe("b-live");
    expect(denied.getObject(scopeB, "a-1")).toBeUndefined();

    let checkedTarget: OntologyScope | undefined;
    const allowed = new InMemoryOntologyPersistence({ authorizeRestore: (sourceScope, targetScope) => {
      checkedTarget = { ...targetScope };
      return sourceScope.tenantId === "tenant-a" && targetScope.tenantId === "tenant-b";
    } });
    allowed.restoreSnapshot(snapshot, scopeB);
    expect(checkedTarget).toEqual(scopeB);
    expect(allowed.getObject(scopeB, "a-1")?.scope).toEqual(scopeB);
  });

  it("rejects malformed cursors and cross-scope snapshot data", () => {
    const store = new InMemoryOntologyPersistence();
    expect(() => store.queryObjects(scopeA, { cursor: "nope" })).toThrow("invalid query cursor");
    const snapshot = store.exportSnapshot(scopeA, "2026-08-15T22:40:00.000Z");
    const forged = { ...snapshot, objects: [object("bad", scopeB)] };
    expect(() => store.restoreSnapshot(forged, scopeA)).toThrow();
  });

  it("returns defensive copies", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject(object("a-1", scopeA));
    const read = store.getObject(scopeA, "a-1")!;
    (read.properties as Record<string, unknown>).name = "mutated";
    expect(store.getObject(scopeA, "a-1")?.properties.name).toBe("a-1");
  });
});

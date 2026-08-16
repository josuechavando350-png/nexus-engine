import { describe, expect, it } from "vitest";
import { InMemoryOntologyPersistence } from "../persistence-query";

const scope = { tenantId: "tenant-h07", organizationId: "org-h07", brandId: "brand-h07" } as const;

describe("H-07 real ontology state lifecycle", () => {
  it("exports, removes, restores and verifies tenant-scoped state through the production persistence API", () => {
    const store = new InMemoryOntologyPersistence();
    store.upsertObject({
      id: "customer-1",
      typeId: "obj.customer",
      scope,
      revision: 1,
      properties: { name: "Ada" },
    });
    store.upsertObject({
      id: "customer-2",
      typeId: "obj.customer",
      scope,
      revision: 1,
      properties: { name: "Grace" },
    });
    store.upsertRelationship({
      id: "peer-1",
      typeId: "rel.peer",
      scope,
      revision: 1,
      endpoints: { left: "customer-1", right: "customer-2" },
    });

    const backup = store.exportSnapshot(scope, "2026-08-16T00:00:00.000Z");
    expect(backup.objectCount).toBe(2);
    expect(backup.relationshipCount).toBe(1);
    expect(backup.digest).toMatch(/^sha256:/);

    // Offboard the scoped live records only after a complete verified export.
    store.deleteRelationship(scope, "peer-1");
    store.deleteObject(scope, "customer-1");
    store.deleteObject(scope, "customer-2");
    expect(store.queryObjects(scope).items).toHaveLength(0);
    expect(store.queryRelationships(scope).items).toHaveLength(0);

    // Restore through the real restore API, which validates digest, watermark,
    // counts, scope authorization and staged state before commit.
    store.restoreSnapshot(backup, scope);
    expect(store.queryObjects(scope).items.map((item) => item.id)).toEqual(["customer-1", "customer-2"]);
    expect(store.queryRelationships(scope).items.map((item) => item.id)).toEqual(["peer-1"]);

    const restored = store.exportSnapshot(scope, "2026-08-16T00:00:00.000Z");
    expect(restored.digest).toBe(backup.digest);
  });
});

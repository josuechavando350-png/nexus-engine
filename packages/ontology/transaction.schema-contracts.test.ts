import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryOntologyTransactionStore, OntologyTransactionError } from "./transaction";

function schema() {
  const input: SchemaVersion = {
    version: "10.0.0-h06",
    scope: { tenantId: "tenant-a", organizationId: "org-a" },
    properties: [
      { id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: true, immutable: false },
      { id: "prop.age", name: "age", valueKind: "NUMBER", cardinality: "OPTIONAL", unique: false, immutable: false },
      { id: "prop.active", name: "active", valueKind: "BOOLEAN", cardinality: "OPTIONAL", unique: false, immutable: false },
      { id: "prop.created", name: "created", valueKind: "DATETIME", cardinality: "OPTIONAL", unique: false, immutable: false },
      { id: "prop.meta", name: "meta", valueKind: "JSON", cardinality: "OPTIONAL", unique: false, immutable: false },
      { id: "prop.code", name: "code", valueKind: "STRING", cardinality: "OPTIONAL", unique: false, immutable: true },
      { id: "prop.derived", name: "derived", valueKind: "STRING", cardinality: "OPTIONAL", unique: false, immutable: false, derived: true },
    ],
    interfaces: [],
    objects: [{ id: "obj.customer", name: "Customer", propertyIds: ["prop.name", "prop.age", "prop.active", "prop.created", "prop.meta", "prop.code", "prop.derived"], interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(input);
}

function create(store: InMemoryOntologyTransactionStore, active: ReturnType<typeof schema>, id: string, properties: Record<string, any>) {
  return store.transact(active.scope, active, [{
    kind: "CREATE_OBJECT",
    record: { id, typeId: "obj.customer", scope: active.scope, properties },
  }]);
}

describe("H-06 executable schema write contracts", () => {
  it("rejects a create missing a required property without partial mutation", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    expect(() => create(store, active, "c-1", { "prop.age": 42 })).toThrow(OntologyTransactionError);
    expect(store.getObject(active.scope, "c-1")).toBeUndefined();
  });

  it("enforces scalar kinds and canonical UTC datetime on create and update", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    expect(() => create(store, active, "bad", { "prop.name": "Ada", "prop.age": "42" })).toThrow(/requires NUMBER/);
    create(store, active, "c-1", { "prop.name": "Ada", "prop.age": 42, "prop.created": "2026-08-16T06:00:00.000Z" });
    expect(() => store.transact(active.scope, active, [{ kind: "UPDATE_OBJECT", id: "c-1", expectedRevision: 1, properties: { "prop.created": "2026-08-16 06:00:00" } }])).toThrow(/requires DATETIME/);
    expect(store.getObject(active.scope, "c-1")?.revision).toBe(1);
  });

  it("enforces unique properties inside the ontology scope", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    create(store, active, "c-1", { "prop.name": "Ada" });
    expect(() => create(store, active, "c-2", { "prop.name": "Ada" })).toThrow(/must be unique/);
    expect(store.getObject(active.scope, "c-2")).toBeUndefined();
  });

  it("rejects direct writes to derived properties", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    expect(() => create(store, active, "c-1", { "prop.name": "Ada", "prop.derived": "forged" })).toThrow(/derived/);
    expect(store.getObject(active.scope, "c-1")).toBeUndefined();
  });

  it("keeps immutable properties immutable and accepts structured JSON", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    create(store, active, "c-1", { "prop.name": "Ada", "prop.code": "A-1", "prop.meta": { nested: [1, true, null, "ok"] } });
    expect(store.getObject(active.scope, "c-1")?.properties["prop.meta"]).toEqual({ nested: [1, true, null, "ok"] });
    expect(() => store.transact(active.scope, active, [{ kind: "UPDATE_OBJECT", id: "c-1", expectedRevision: 1, properties: { "prop.code": "A-2" } }])).toThrow(/immutable/);
    expect(store.getObject(active.scope, "c-1")?.properties["prop.code"]).toBe("A-1");
  });

  it("validates the post-update object so required fields cannot become null", () => {
    const active = schema();
    const store = new InMemoryOntologyTransactionStore();
    create(store, active, "c-1", { "prop.name": "Ada" });
    expect(() => store.transact(active.scope, active, [{ kind: "UPDATE_OBJECT", id: "c-1", expectedRevision: 1, properties: { "prop.name": null } }])).toThrow(/required property/);
    expect(store.getObject(active.scope, "c-1")?.revision).toBe(1);
  });
});

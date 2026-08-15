import { describe, expect, it } from "vitest";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryOntologyTransactionStore } from "./transaction";

function schema(): SchemaVersion {
  return {
    version: "10.2.0",
    scope: { tenantId: "tenant-a", organizationId: "org-a" },
    properties: [
      { id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: "prop.external", name: "external", valueKind: "STRING", cardinality: "OPTIONAL", unique: true, immutable: true }
    ],
    interfaces: [],
    objects: [
      { id: "obj.customer", name: "Customer", propertyIds: ["prop.name", "prop.external"], interfaceIds: [] },
      { id: "obj.order", name: "Order", propertyIds: ["prop.name"], interfaceIds: [] }
    ],
    relationships: [{ id: "rel.customer-order", name: "CustomerOrder", roles: [
      { name: "customer", endpointTypeIds: ["obj.customer"] },
      { name: "order", endpointTypeIds: ["obj.order"] }
    ] }],
    actions: [], functions: [], events: []
  };
}

const scope = { tenantId: "tenant-a", organizationId: "org-a" } as const;

describe("ontology transaction store", () => {
  it("commits object and relationship changes atomically", () => {
    const store = new InMemoryOntologyTransactionStore();
    const validated = validateSchema(schema());
    const result = store.transact(scope, validated, [
      { kind: "CREATE_OBJECT", record: { id: "c1", typeId: "obj.customer", scope, properties: { "prop.name": "Ada" } } },
      { kind: "CREATE_OBJECT", record: { id: "o1", typeId: "obj.order", scope, properties: { "prop.name": "Order" } } },
      { kind: "CREATE_RELATIONSHIP", record: { id: "r1", typeId: "rel.customer-order", scope, endpoints: { customer: "c1", order: "o1" } } }
    ]);
    expect(result.committed).toBe(true);
    expect(store.getRelationship(scope, "r1")?.revision).toBe(1);
  });

  it("rolls back the full transaction when a later operation fails", () => {
    const store = new InMemoryOntologyTransactionStore();
    const validated = validateSchema(schema());
    expect(() => store.transact(scope, validated, [
      { kind: "CREATE_OBJECT", record: { id: "c1", typeId: "obj.customer", scope, properties: { "prop.name": "Ada" } } },
      { kind: "CREATE_RELATIONSHIP", record: { id: "r1", typeId: "rel.customer-order", scope, endpoints: { customer: "c1", order: "missing" } } }
    ])).toThrow("not found");
    expect(store.getObject(scope, "c1")).toBeUndefined();
  });

  it("enforces optimistic concurrency and immutable properties", () => {
    const store = new InMemoryOntologyTransactionStore();
    const validated = validateSchema(schema());
    store.transact(scope, validated, [{ kind: "CREATE_OBJECT", record: { id: "c1", typeId: "obj.customer", scope, properties: { "prop.name": "Ada", "prop.external": "ext-1" } } }]);
    expect(() => store.transact(scope, validated, [{ kind: "UPDATE_OBJECT", id: "c1", expectedRevision: 0, properties: { "prop.name": "Grace" } }])).toThrow("revision conflict");
    expect(() => store.transact(scope, validated, [{ kind: "UPDATE_OBJECT", id: "c1", expectedRevision: 1, properties: { "prop.external": "ext-2" } }])).toThrow("immutable");
  });

  it("rejects cross-scope writes and invalid relationship endpoints", () => {
    const store = new InMemoryOntologyTransactionStore();
    const validated = validateSchema(schema());
    const foreign = { tenantId: "tenant-b", organizationId: "org-a" };
    expect(() => store.transact(scope, validated, [{ kind: "CREATE_OBJECT", record: { id: "x", typeId: "obj.customer", scope: foreign, properties: { "prop.name": "X" } } }])).toThrow("scope mismatch");
    store.transact(scope, validated, [
      { kind: "CREATE_OBJECT", record: { id: "c1", typeId: "obj.customer", scope, properties: { "prop.name": "Ada" } } },
      { kind: "CREATE_OBJECT", record: { id: "c2", typeId: "obj.customer", scope, properties: { "prop.name": "Grace" } } }
    ]);
    expect(() => store.transact(scope, validated, [{ kind: "CREATE_RELATIONSHIP", record: { id: "bad", typeId: "rel.customer-order", scope, endpoints: { customer: "c1", order: "c2" } } }])).toThrow("invalid for role");
  });
});

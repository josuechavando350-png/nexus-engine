import { describe, expect, it } from "vitest";
import { composeSchemas, OntologyValidationError, validateSchema, type SchemaVersion } from "./index";

function schema(): SchemaVersion {
  return {
    version: "10.0.0",
    scope: { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" },
    properties: [
      { id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: "prop.amount", name: "amount", valueKind: "NUMBER", cardinality: "OPTIONAL", unique: false, immutable: false }
    ],
    interfaces: [{ id: "iface.identifiable", name: "Identifiable", propertyIds: ["prop.name"] }],
    objects: [
      { id: "obj.customer", name: "Customer", propertyIds: ["prop.name"], interfaceIds: ["iface.identifiable"] },
      { id: "obj.order", name: "Order", propertyIds: ["prop.amount"], interfaceIds: [] }
    ],
    relationships: [{ id: "rel.customer_order", name: "CustomerOrder", roles: [
      { name: "customer", endpointTypeIds: ["obj.customer"] },
      { name: "order", endpointTypeIds: ["obj.order"] }
    ] }],
    events: [{ id: "event.order_created", name: "OrderCreated", propertyIds: ["prop.amount"] }],
    actions: [{
      id: "action.create_order", name: "CreateOrder", targetTypeId: "obj.customer", inputPropertyIds: ["prop.amount"],
      permission: "orders:create", preconditionRefs: ["customer.active"], effectRefs: ["order.create"], emittedEventTypeIds: ["event.order_created"]
    }],
    functions: [{ id: "fn.order_total", name: "OrderTotal", inputPropertyIds: ["prop.amount"], outputPropertyIds: ["prop.amount"], derivedRefs: ["sum"] }]
  };
}

describe("ontology kernel", () => {
  it("creates deterministic SHA-256 schema identities independent of top-level definition order", () => {
    const a = schema();
    const b = schema();
    const reordered: SchemaVersion = { ...b, objects: [...b.objects].reverse(), properties: [...b.properties].reverse() };
    const first = validateSchema(a);
    const second = validateSchema(reordered);
    expect(first.schemaId).toBe(second.schemaId);
    expect(first.schemaId).toMatch(/^schema_[a-f0-9]{64}$/);
  });

  it("rejects undeclared references", () => {
    const base = schema();
    const invalid: SchemaVersion = { ...base, objects: [{ ...base.objects[0]!, propertyIds: ["prop.missing"] }, base.objects[1]!] };
    expect(() => validateSchema(invalid)).toThrowError(OntologyValidationError);
  });

  it("rejects relationships with duplicate or insufficient roles", () => {
    const base = schema();
    const duplicate: SchemaVersion = { ...base, relationships: [{ ...base.relationships[0]!, roles: [
      { name: "side", endpointTypeIds: ["obj.customer"] }, { name: "side", endpointTypeIds: ["obj.order"] }
    ] }] };
    expect(() => validateSchema(duplicate)).toThrow("duplicate role");

    const single: SchemaVersion = { ...base, relationships: [{ ...base.relationships[0]!, roles: [{ name: "only", endpointTypeIds: ["obj.customer"] }] }] };
    expect(() => validateSchema(single)).toThrow("at least two roles");
  });

  it("fails closed when an action has no explicit permission", () => {
    const base = schema();
    const invalid: SchemaVersion = { ...base, actions: [{ ...base.actions[0]!, permission: "" }] };
    expect(() => validateSchema(invalid)).toThrow("permission must be non-empty");
  });

  it("rejects mutation semantics on FunctionType", () => {
    const base = schema();
    const invalid: SchemaVersion = { ...base, functions: [{ ...base.functions[0]!, mutationEffects: ["order.delete"] }] };
    expect(() => validateSchema(invalid)).toThrow("cannot declare mutation effects");
  });

  it("rejects non-finite numeric defaults and conflicting immutable/derived semantics", () => {
    const base = schema();
    const nonFinite: SchemaVersion = { ...base, properties: [{ ...base.properties[0]!, defaultValue: Number.NaN }, base.properties[1]!] };
    expect(() => validateSchema(nonFinite)).toThrow("must be finite");

    const conflicting: SchemaVersion = { ...base, properties: [{ ...base.properties[0]!, immutable: true, derived: true }, base.properties[1]!] };
    expect(() => validateSchema(conflicting)).toThrow("cannot be immutable and derived");
  });

  it("forbids cross-scope composition", () => {
    const a = validateSchema(schema());
    const other = schema();
    const b = validateSchema({ ...other, scope: { ...other.scope, tenantId: "tenant-b" } });
    expect(() => composeSchemas([a, b])).toThrow("cross-scope");
  });
});

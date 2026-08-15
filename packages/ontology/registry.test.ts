import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "./index";
import { InMemorySchemaRegistry } from "./registry";

function schema(version: string, tenantId = "tenant-a"): SchemaVersion {
  return {
    version,
    scope: { tenantId, organizationId: "org-a" },
    properties: [{ id: "prop.name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false }],
    interfaces: [],
    objects: [{ id: "obj.customer", name: "Customer", propertyIds: ["prop.name"], interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: []
  };
}

describe("schema registry", () => {
  it("registers monotonic schema history per scope", () => {
    const registry = new InMemorySchemaRegistry();
    const first = registry.register(schema("10.0.0"));
    const second = registry.register(schema("10.1.0"), first.schemaId);
    expect(registry.getLatest(first.scope)?.schemaId).toBe(second.schemaId);
    expect(registry.list(first.scope).map((item) => item.version)).toEqual(["10.0.0", "10.1.0"]);
  });

  it("rejects stale-parent registrations and downgrades", () => {
    const registry = new InMemorySchemaRegistry();
    const first = registry.register(schema("10.0.0"));
    const second = registry.register(schema("10.1.0"), first.schemaId);
    expect(() => registry.register(schema("10.2.0"), first.schemaId)).toThrow("extend the latest");
    expect(() => registry.register(schema("10.0.1"), second.schemaId)).toThrow("increase monotonically");
  });

  it("isolates histories by scope", () => {
    const registry = new InMemorySchemaRegistry();
    const a = registry.register(schema("10.0.0", "tenant-a"));
    const b = registry.register(schema("10.0.0", "tenant-b"));
    expect(registry.list(a.scope)).toHaveLength(1);
    expect(registry.list(b.scope)).toHaveLength(1);
    expect(a.schemaId).not.toBe(b.schemaId);
  });

  it("builds deterministic explicit migration plans", () => {
    const registry = new InMemorySchemaRegistry();
    const first = registry.register(schema("10.0.0"));
    const nextSchema = schema("10.1.0");
    nextSchema.properties = [...nextSchema.properties, { id: "prop.email", name: "email", valueKind: "STRING", cardinality: "OPTIONAL", unique: true, immutable: false }];
    nextSchema.objects = [{ ...nextSchema.objects[0]!, propertyIds: ["prop.name", "prop.email"] }];
    const second = registry.register(nextSchema, first.schemaId);
    const steps = [{ description: "Add optional unique email property", safety: "SAFE" as const, reversible: true }];
    const a = registry.planMigration(first.schemaId, second.schemaId, steps);
    const b = registry.planMigration(first.schemaId, second.schemaId, steps);
    expect(a.migrationId).toBe(b.migrationId);
    expect(a.steps[0]?.id).toMatch(/^migration-step_[a-f0-9]{64}$/);
  });

  it("rejects cross-scope and empty migration plans", () => {
    const registry = new InMemorySchemaRegistry();
    const a = registry.register(schema("10.0.0", "tenant-a"));
    const b = registry.register(schema("10.0.0", "tenant-b"));
    expect(() => registry.planMigration(a.schemaId, b.schemaId, [{ description: "bad", safety: "BREAKING", reversible: false }])).toThrow("cross-scope");

    const second = registry.register(schema("10.1.0", "tenant-a"), a.schemaId);
    expect(() => registry.planMigration(a.schemaId, second.schemaId, [])).toThrow("at least one explicit step");
  });
});

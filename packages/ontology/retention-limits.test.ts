import { describe, expect, it } from "vitest";
import { validateSchema, type OntologyScope, type SchemaVersion } from "./index";
import { InMemoryAuditTrail } from "./auth-audit";
import { InMemoryEventStream, InMemoryWorkflowEngine } from "./events-workflows";
import { InMemorySchemaRegistry } from "./registry";
import { InMemoryOntologyTransactionStore } from "./transaction";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a" };

function schema(version = "10.0.0"): SchemaVersion {
  return {
    version,
    scope,
    properties: [],
    interfaces: [],
    objects: [{ id: "obj.item", name: "Item", propertyIds: [], interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
}

describe("M-08 bounded in-memory retention", () => {
  it("fails closed when schema history reaches its configured ceiling", () => {
    const registry = new InMemorySchemaRegistry({ maxSchemas: 10, maxVersionsPerScope: 1 });
    const first = registry.register(schema("10.0.0"));
    expect(() => registry.register(schema("10.1.0"), first.schemaId)).toThrow("schema history capacity exceeded");
    expect(registry.getLatest(scope)?.schemaId).toBe(first.schemaId);
  });

  it("fails closed instead of silently growing audit history", () => {
    const audit = new InMemoryAuditTrail(1);
    audit.append({
      occurredAt: "2026-08-16T07:00:00.000Z",
      principalId: "user-a",
      scope,
      actionId: "action.read",
      decision: "DENY",
      reason: "test",
      risk: "LOW",
      policyVersion: "v1",
    });
    expect(() => audit.append({
      occurredAt: "2026-08-16T07:00:01.000Z",
      principalId: "user-a",
      scope,
      actionId: "action.read",
      decision: "DENY",
      reason: "test-2",
      risk: "LOW",
      policyVersion: "v1",
    })).toThrow("audit retention capacity exceeded");
    expect(audit.list(scope)).toHaveLength(1);
    expect(audit.verify(scope)).toBe(true);
  });

  it("applies event backpressure without corrupting the existing stream", () => {
    const events = new InMemoryEventStream({ maxEventsPerScope: 1 });
    const input = {
      eventTypeId: "event.test",
      scope,
      occurredAt: "2026-08-16T07:00:00.000Z",
      correlationId: "corr-1",
      payload: {},
    };
    events.append(input);
    expect(() => events.append({ ...input, occurredAt: "2026-08-16T07:00:01.000Z", correlationId: "corr-2" })).toThrow("event stream capacity exceeded");
    expect(events.list(scope)).toHaveLength(1);
  });

  it("bounds workflow definitions and instances", () => {
    const engine = new InMemoryWorkflowEngine({ maxDefinitions: 1, maxInstances: 1 });
    engine.register({
      workflowId: "wf.one",
      initialState: "START",
      terminalStates: ["DONE"],
      transitions: [{ from: "START", eventTypeId: "event.done", to: "DONE" }],
    });
    expect(() => engine.register({
      workflowId: "wf.two",
      initialState: "START",
      terminalStates: ["DONE"],
      transitions: [{ from: "START", eventTypeId: "event.done", to: "DONE" }],
    })).toThrow("workflow definition capacity exceeded");
    engine.start(scope, "wf.one", "corr-1");
    expect(() => engine.start(scope, "wf.one", "corr-2")).toThrow("workflow instance capacity exceeded");
  });

  it("keeps object writes atomic when the per-scope capacity would be exceeded", () => {
    const store = new InMemoryOntologyTransactionStore({ maxObjectsPerScope: 1, maxRelationshipsPerScope: 1 });
    const validated = validateSchema(schema());
    store.transact(scope, validated, [{
      kind: "CREATE_OBJECT",
      record: { id: "one", typeId: "obj.item", scope, properties: {} },
    }]);
    expect(() => store.transact(scope, validated, [{
      kind: "CREATE_OBJECT",
      record: { id: "two", typeId: "obj.item", scope, properties: {} },
    }])).toThrow("object capacity exceeded");
    expect(store.getObject(scope, "one")?.id).toBe("one");
    expect(store.getObject(scope, "two")).toBeUndefined();
  });
});

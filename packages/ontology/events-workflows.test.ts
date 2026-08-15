import { describe, expect, it } from "vitest";
import { InMemoryEventStream, InMemoryWorkflowEngine } from "./events-workflows";

const scope = { tenantId: "tenant-a", organizationId: "org-a" };

describe("events and workflows", () => {
  it("appends deterministic scoped events with monotonic sequence", () => {
    const stream = new InMemoryEventStream();
    const first = stream.append({ eventTypeId: "event.created", scope, occurredAt: "2026-08-15T22:00:00.000Z", correlationId: "corr-1", payload: { id: "x" } });
    const second = stream.append({ eventTypeId: "event.updated", scope, occurredAt: "2026-08-15T22:00:01.000Z", correlationId: "corr-1", causationId: first.eventId, payload: { id: "x" } });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.eventId).toMatch(/^event-record_[a-f0-9]{64}$/);
    expect(stream.list(scope, "corr-1")).toHaveLength(2);
  });

  it("rejects non-canonical timestamps", () => {
    const stream = new InMemoryEventStream();
    expect(() => stream.append({ eventTypeId: "event.created", scope, occurredAt: "2026-08-15T16:00:00-06:00", correlationId: "corr-1", payload: {} })).toThrow("canonical UTC");
  });

  it("executes deterministic workflow transitions", () => {
    const stream = new InMemoryEventStream();
    const engine = new InMemoryWorkflowEngine();
    engine.register({ workflowId: "order-fulfillment", initialState: "NEW", terminalStates: ["DONE"], transitions: [{ from: "NEW", eventTypeId: "event.approved", to: "APPROVED" }, { from: "APPROVED", eventTypeId: "event.fulfilled", to: "DONE" }] });
    const instance = engine.start(scope, "order-fulfillment", "corr-1");
    const approved = stream.append({ eventTypeId: "event.approved", scope, occurredAt: "2026-08-15T22:00:00.000Z", correlationId: "corr-1", payload: {} });
    const afterApproval = engine.apply(scope, instance.instanceId, approved, 1);
    const fulfilled = stream.append({ eventTypeId: "event.fulfilled", scope, occurredAt: "2026-08-15T22:00:01.000Z", correlationId: "corr-1", causationId: approved.eventId, payload: {} });
    const done = engine.apply(scope, instance.instanceId, fulfilled, 2);
    expect(afterApproval.state).toBe("APPROVED");
    expect(done.status).toBe("COMPLETED");
  });

  it("rejects cross-scope, stale revision, invalid correlation and invalid transitions", () => {
    const stream = new InMemoryEventStream();
    const engine = new InMemoryWorkflowEngine();
    engine.register({ workflowId: "wf", initialState: "A", terminalStates: ["B"], transitions: [{ from: "A", eventTypeId: "event.go", to: "B" }] });
    const instance = engine.start(scope, "wf", "corr-1");
    const wrongScope = { tenantId: "tenant-b", organizationId: "org-a" };
    const event = stream.append({ eventTypeId: "event.go", scope, occurredAt: "2026-08-15T22:00:00.000Z", correlationId: "corr-1", payload: {} });
    expect(() => engine.apply(wrongScope, instance.instanceId, event, 1)).toThrow("cross-scope");
    expect(() => engine.apply(scope, instance.instanceId, event, 2)).toThrow("revision conflict");
    const badCorrelation = stream.append({ eventTypeId: "event.go", scope, occurredAt: "2026-08-15T22:00:01.000Z", correlationId: "corr-2", payload: {} });
    expect(() => engine.apply(scope, instance.instanceId, badCorrelation, 1)).toThrow("correlation");
    const badTransition = stream.append({ eventTypeId: "event.other", scope, occurredAt: "2026-08-15T22:00:02.000Z", correlationId: "corr-1", payload: {} });
    expect(() => engine.apply(scope, instance.instanceId, badTransition, 1)).toThrow("not valid");
  });
});

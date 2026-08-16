import { ontologyId, type OntologyScope } from "./index";

export interface DomainEvent {
  readonly eventId: string;
  readonly eventTypeId: string;
  readonly scope: OntologyScope;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly sequence: number;
}

export interface EventStreamPort {
  append(input: Omit<DomainEvent, "eventId" | "sequence">): DomainEvent;
  list(scope: OntologyScope, correlationId?: string): readonly DomainEvent[];
}

export type WorkflowStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface WorkflowTransition {
  readonly from: string;
  readonly eventTypeId: string;
  readonly to: string;
}

export interface WorkflowDefinition {
  readonly workflowId: string;
  readonly initialState: string;
  readonly terminalStates: readonly string[];
  readonly transitions: readonly WorkflowTransition[];
}

export interface WorkflowInstance {
  readonly instanceId: string;
  readonly workflowId: string;
  readonly scope: OntologyScope;
  readonly correlationId: string;
  readonly state: string;
  readonly status: WorkflowStatus;
  readonly revision: number;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function assertUtc(value: string): void {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || d.toISOString() !== value) throw new Error("occurredAt must be canonical UTC");
}

export class InMemoryEventStream implements EventStreamPort {
  private readonly histories = new Map<string, DomainEvent[]>();

  append(input: Omit<DomainEvent, "eventId" | "sequence">): DomainEvent {
    assertUtc(input.occurredAt);
    if (!input.eventTypeId.trim()) throw new Error("eventTypeId must be non-empty");
    if (!input.correlationId.trim()) throw new Error("correlationId must be non-empty");
    const key = scopeKey(input.scope);
    const history = this.histories.get(key) ?? [];
    const sequence = history.length + 1;
    const body = { ...input, sequence };
    const event: DomainEvent = { ...body, eventId: ontologyId("event-record", body) };
    this.histories.set(key, [...history, event]);
    return event;
  }

  list(scope: OntologyScope, correlationId?: string): readonly DomainEvent[] {
    const values = this.histories.get(scopeKey(scope)) ?? [];
    return correlationId ? values.filter((event) => event.correlationId === correlationId) : [...values];
  }
}

export class InMemoryWorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly instances = new Map<string, WorkflowInstance>();

  register(definition: WorkflowDefinition): void {
    if (!definition.workflowId.trim() || !definition.initialState.trim()) throw new Error("workflow definition is invalid");
    if (definition.transitions.length === 0) throw new Error("workflow requires transitions");
    this.definitions.set(definition.workflowId, definition);
  }

  start(scope: OntologyScope, workflowId: string, correlationId: string): WorkflowInstance {
    const def = this.definitions.get(workflowId);
    if (!def) throw new Error(`workflow ${workflowId} is not registered`);
    const instanceId = ontologyId("workflow-instance", { scope, workflowId, correlationId });
    const existing = this.instances.get(instanceId);
    if (existing) return existing;
    const instance: WorkflowInstance = { instanceId, workflowId, scope, correlationId, state: def.initialState, status: def.terminalStates.includes(def.initialState) ? "COMPLETED" : "RUNNING", revision: 1 };
    this.instances.set(instanceId, instance);
    return instance;
  }

  apply(scope: OntologyScope, instanceId: string, event: DomainEvent, expectedRevision: number): WorkflowInstance {
    const current = this.instances.get(instanceId);
    if (!current) throw new Error("workflow instance not found");
    if (!sameScope(scope, current.scope) || !sameScope(scope, event.scope)) throw new Error("cross-scope workflow execution is forbidden");
    if (current.correlationId !== event.correlationId) throw new Error("event correlation does not match workflow");
    if (current.revision !== expectedRevision) throw new Error("workflow revision conflict");
    if (current.status !== "RUNNING") throw new Error("terminal workflow cannot transition");
    const def = this.definitions.get(current.workflowId)!;
    const transition = def.transitions.find((item) => item.from === current.state && item.eventTypeId === event.eventTypeId);
    if (!transition) throw new Error("event is not valid for current workflow state");
    const next: WorkflowInstance = { ...current, state: transition.to, status: def.terminalStates.includes(transition.to) ? "COMPLETED" : "RUNNING", revision: current.revision + 1 };
    this.instances.set(instanceId, next);
    return next;
  }

  get(scope: OntologyScope, instanceId: string): WorkflowInstance | undefined {
    const instance = this.instances.get(instanceId);
    return instance && sameScope(scope, instance.scope) ? { ...instance } : undefined;
  }
}

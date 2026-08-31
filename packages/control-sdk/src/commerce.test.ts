import { describe, expect, it } from "vitest";
import {
  CommerceControlError,
  GovernedCommerceEngine,
  GovernedCommerceRuntime,
  type CommerceExecutor,
  type CommerceExecutorRequest,
  type CommercePrincipal,
} from "./commerce.js";

const preparedAt = "2026-08-31T15:10:00.000Z";
const approvedAt = "2026-08-31T15:11:00.000Z";
const executionAt = "2026-08-31T15:12:00.000Z";
const expiresAt = "2026-08-31T15:20:00.000Z";
const payloadDigest = "a".repeat(64);
const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;
const operator: CommercePrincipal = {
  principalId: "operator-a",
  tenantId: "tenant-a",
  permissions: ["commerce:prepare", "commerce:approve", "commerce:execute", "commerce:read"],
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    scope,
    action: "CREATE_ORDER" as const,
    idempotencyKey: "checkout-1",
    orderRef: "order-1",
    currency: "MXN",
    amountMinor: 12_500,
    payloadDigest,
    ...overrides,
  };
}

function engine(executor: CommerceExecutor, timeout = 15_000, clock = executionAt) {
  return new GovernedCommerceEngine(executor, timeout, () => clock);
}

class RecordingExecutor implements CommerceExecutor {
  readonly requests: CommerceExecutorRequest[] = [];
  constructor(
    private readonly result: { outcome: "COMMITTED" | "REJECTED"; externalReference?: string; rejectionCode?: string } = { outcome: "COMMITTED", externalReference: "provider-order-1" },
    private readonly available: "AVAILABLE" | "UNAVAILABLE" = "AVAILABLE",
  ) {}
  availability() { return this.available; }
  async execute(input: CommerceExecutorRequest, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    this.requests.push(input);
    return this.result;
  }
}

describe("governed agentic commerce", () => {
  it("requires exact human approval before an executor can receive the action", async () => {
    const executor = new RecordingExecutor();
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(executor.requests).toHaveLength(0);
    const approved = control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    const committed = await control.execute(operator, "tenant-a", tx.transactionId);
    expect(committed.state).toBe("COMMITTED");
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.approvalDigest).toBe(approved.approval?.approvalDigest);
    expect(control.verifyAuditChain("tenant-a")).toBe(true);
  });

  it("is idempotent for retries and never executes the same committed action twice", async () => {
    const executor = new RecordingExecutor();
    const control = engine(executor);
    const first = control.prepare(operator, request(), preparedAt);
    expect(control.prepare(operator, request(), "2026-08-31T15:10:30.000Z")).toBe(first);
    control.decideApproval(operator, "tenant-a", first.transactionId, "GRANTED", approvedAt, expiresAt);
    const committed = await control.execute(operator, "tenant-a", first.transactionId);
    expect(await control.execute(operator, "tenant-a", first.transactionId)).toBe(committed);
    expect(executor.requests).toHaveLength(1);
  });

  it("rejects idempotency-key reuse with a different exact action", () => {
    const control = engine(new RecordingExecutor());
    control.prepare(operator, request(), preparedAt);
    expect(() => control.prepare(operator, request({ amountMinor: 20_000 }), preparedAt)).toThrowError(CommerceControlError);
  });

  it("fails closed across tenant boundaries without revealing transaction existence", async () => {
    const executor = new RecordingExecutor();
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    const other: CommercePrincipal = { principalId: "operator-b", tenantId: "tenant-b", permissions: ["commerce:prepare", "commerce:approve", "commerce:execute", "commerce:read"] };
    expect(() => control.getTransaction(other, "tenant-b", tx.transactionId)).toThrow(/not found/u);
    await expect(control.execute(other, "tenant-b", tx.transactionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(executor.requests).toHaveLength(0);
  });

  it("denial is terminal and cannot be bypassed by execution permission", async () => {
    const executor = new RecordingExecutor();
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "DENIED", approvedAt, expiresAt);
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(executor.requests).toHaveLength(0);
  });

  it("uses trusted runtime time for approval expiry and cannot be backdated by a caller", async () => {
    const executor = new RecordingExecutor();
    const control = engine(executor, 15_000, executionAt);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, "2026-08-31T15:11:30.000Z");
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(executor.requests).toHaveLength(0);
  });

  it("reports unavailable executor honestly without fabricating provider execution", async () => {
    const executor = new RecordingExecutor({ outcome: "COMMITTED" }, "UNAVAILABLE");
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    const result = await control.execute(operator, "tenant-a", tx.transactionId);
    expect(result.state).toBe("UNAVAILABLE");
    expect(result.failureCode).toBe("EXECUTOR_UNAVAILABLE");
    expect(executor.requests).toHaveLength(0);
  });

  it("blocks automatic replay when transport fails after execution begins", async () => {
    let calls = 0;
    const executor: CommerceExecutor = {
      availability: () => "AVAILABLE",
      execute: async () => { calls += 1; throw new Error("transport dropped"); },
    };
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("coalesces concurrent execution so the external action runs once", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const executor: CommerceExecutor = {
      availability: () => "AVAILABLE",
      execute: async () => { calls += 1; await wait; return { outcome: "COMMITTED", externalReference: "provider-order-1" }; },
    };
    const control = engine(executor);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    const first = control.execute(operator, "tenant-a", tx.transactionId);
    const second = control.execute(operator, "tenant-a", tx.transactionId);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe("COMMITTED");
    expect(b.transactionId).toBe(a.transactionId);
    expect(calls).toBe(1);
  });

  it("enforces a hard timeout even when an executor ignores AbortSignal", async () => {
    let calls = 0;
    const executor: CommerceExecutor = {
      availability: () => "AVAILABLE",
      execute: async () => { calls += 1; return await new Promise(() => {}); },
    };
    const control = engine(executor, 5);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("treats cancellation after dispatch as OUTCOME_UNKNOWN and blocks replay", async () => {
    let calls = 0;
    const executor: CommerceExecutor = {
      availability: () => "AVAILABLE",
      execute: async () => { calls += 1; return await new Promise(() => {}); },
    };
    const control = engine(executor, 5_000);
    const tx = control.prepare(operator, request(), preparedAt);
    control.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", approvedAt, expiresAt);
    const controller = new AbortController();
    const execution = control.execute(operator, "tenant-a", tx.transactionId, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("operator cancelled"));
    await expect(execution).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(control.execute(operator, "tenant-a", tx.transactionId)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("runtime consumer routes preparation, approval and execution through one governed engine", async () => {
    const executor = new RecordingExecutor();
    const runtime = new GovernedCommerceRuntime(engine(executor));
    const tx = runtime.prepare(operator, request(), preparedAt);
    runtime.approve(operator, "tenant-a", tx.transactionId, approvedAt, expiresAt);
    expect((await runtime.execute(operator, "tenant-a", tx.transactionId)).state).toBe("COMMITTED");
    expect(executor.requests).toHaveLength(1);
  });

  it("rejects request and principal field smuggling plus unbounded monetary input", () => {
    const control = engine(new RecordingExecutor());
    expect(() => control.prepare(operator, request({ execute: true }) as never, preparedAt)).toThrow(/unknown commerce request field/u);
    expect(() => control.prepare(operator, request({ amountMinor: Number.MAX_SAFE_INTEGER }) as never, preparedAt)).toThrow(/amountMinor/u);
    const smuggled = { ...operator, admin: true } as never;
    expect(() => control.prepare(smuggled, request(), preparedAt)).toThrow(/unknown commerce principal field/u);
  });
});

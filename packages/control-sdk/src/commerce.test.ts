import { describe, expect, it } from "vitest";
import {
  CommerceControlError,
  GovernedCommerceEngine,
  GovernedCommerceRuntime,
  type CommerceExecutor,
  type CommerceExecutorRequest,
  type CommercePrincipal,
} from "./commerce.js";

const now = "2026-08-31T15:10:00.000Z";
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
    amountMinor: 125_00,
    payloadDigest,
    ...overrides,
  };
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
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, now)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(executor.requests).toHaveLength(0);

    const approved = engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    expect(approved.approval?.actionDigest).toBe(tx.actionDigest);
    const committed = await engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z");
    expect(committed.state).toBe("COMMITTED");
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.approvalDigest).toBe(approved.approval?.approvalDigest);
    expect(engine.verifyAuditChain("tenant-a")).toBe(true);
  });

  it("is idempotent for retries and never executes the same committed action twice", async () => {
    const executor = new RecordingExecutor();
    const engine = new GovernedCommerceEngine(executor);
    const first = engine.prepare(operator, request(), now);
    const retry = engine.prepare(operator, request(), "2026-08-31T15:10:30.000Z");
    expect(retry).toBe(first);
    engine.decideApproval(operator, "tenant-a", first.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    const committed = await engine.execute(operator, "tenant-a", first.transactionId, "2026-08-31T15:12:00.000Z");
    const secondExecution = await engine.execute(operator, "tenant-a", first.transactionId, "2026-08-31T15:13:00.000Z");
    expect(secondExecution).toBe(committed);
    expect(executor.requests).toHaveLength(1);
  });

  it("rejects idempotency-key reuse with a different exact action", () => {
    const engine = new GovernedCommerceEngine(new RecordingExecutor());
    engine.prepare(operator, request(), now);
    expect(() => engine.prepare(operator, request({ amountMinor: 200_00 }), now)).toThrowError(CommerceControlError);
  });

  it("fails closed across tenant boundaries without revealing transaction existence", async () => {
    const executor = new RecordingExecutor();
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    const other: CommercePrincipal = { principalId: "operator-b", tenantId: "tenant-b", permissions: ["commerce:prepare", "commerce:approve", "commerce:execute", "commerce:read"] };
    expect(() => engine.getTransaction(other, "tenant-b", tx.transactionId)).toThrow(/not found/u);
    await expect(engine.execute(other, "tenant-b", tx.transactionId, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(executor.requests).toHaveLength(0);
  });

  it("denial is terminal and cannot be bypassed by the execution permission", async () => {
    const executor = new RecordingExecutor();
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "DENIED", "2026-08-31T15:11:00.000Z", expiresAt);
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z")).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(executor.requests).toHaveLength(0);
  });

  it("rejects expired approval without calling the executor", async () => {
    const executor = new RecordingExecutor();
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", "2026-08-31T15:11:30.000Z");
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z")).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(executor.requests).toHaveLength(0);
  });

  it("reports unavailable executor honestly without fabricating provider execution", async () => {
    const executor = new RecordingExecutor({ outcome: "COMMITTED" }, "UNAVAILABLE");
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    const result = await engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z");
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
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:13:00.000Z")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
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
    const engine = new GovernedCommerceEngine(executor);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    const first = engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z");
    const second = engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe("COMMITTED");
    expect(b.transactionId).toBe(a.transactionId);
    expect(calls).toBe(1);
  });

  it("turns timeout/cancellation after dispatch into OUTCOME_UNKNOWN instead of retrying", async () => {
    const executor: CommerceExecutor = {
      availability: () => "AVAILABLE",
      execute: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    };
    const engine = new GovernedCommerceEngine(executor, 5);
    const tx = engine.prepare(operator, request(), now);
    engine.decideApproval(operator, "tenant-a", tx.transactionId, "GRANTED", "2026-08-31T15:11:00.000Z", expiresAt);
    await expect(engine.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("runtime consumer routes preparation, approval and execution through the same governed engine", async () => {
    const executor = new RecordingExecutor();
    const runtime = new GovernedCommerceRuntime(new GovernedCommerceEngine(executor));
    const tx = runtime.prepare(operator, request(), now);
    runtime.approve(operator, "tenant-a", tx.transactionId, "2026-08-31T15:11:00.000Z", expiresAt);
    const committed = await runtime.execute(operator, "tenant-a", tx.transactionId, "2026-08-31T15:12:00.000Z");
    expect(committed.state).toBe("COMMITTED");
    expect(executor.requests).toHaveLength(1);
  });

  it("rejects unknown request fields and invalid bounded monetary input", () => {
    const engine = new GovernedCommerceEngine(new RecordingExecutor());
    expect(() => engine.prepare(operator, request({ execute: true }) as never, now)).toThrow(/unknown commerce request field/u);
    expect(() => engine.prepare(operator, request({ amountMinor: Number.MAX_SAFE_INTEGER }) as never, now)).toThrow(/amountMinor/u);
  });
});

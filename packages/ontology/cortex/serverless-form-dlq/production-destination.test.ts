import { describe, expect, it, vi } from "vitest";
import type { LeadDestination } from "./index";
import { KillGuardedLeadDestination } from "./production-destination";
import { Cortex20WorkerError } from "./production-worker";

const submission = {
  submissionId: "submission-00000001",
  formId: "contact-form-0001",
  submittedAt: "2026-09-06T00:00:00.000Z",
  contactConsent: "GRANTED",
  fields: { name: "Cliente" },
} as const;

describe("CORTEX #20 final lead destination guard", () => {
  it("delegates only while durable control is ACTIVE", async () => {
    const delegate: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const guarded = new KillGuardedLeadDestination(delegate, () => "ACTIVE");
    await expect(guarded.deliver(submission, "form-accepted-00000001")).resolves.toEqual({ receiptId: "receipt-00000001" });
    expect(delegate.deliver).toHaveBeenCalledTimes(1);
  });

  it("fails closed at the final boundary and never invokes the downstream side effect when killed", async () => {
    const delegate: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const guarded = new KillGuardedLeadDestination(delegate, () => "KILLED");
    await expect(guarded.deliver(submission, "form-accepted-00000001")).rejects.toMatchObject({ code: "KILLED" } satisfies Partial<Cortex20WorkerError>);
    expect(delegate.deliver).not.toHaveBeenCalled();
  });

  it("fails closed when durable control cannot be read", async () => {
    const delegate: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const guarded = new KillGuardedLeadDestination(delegate, () => { throw new Error("control unavailable"); });
    await expect(guarded.deliver(submission, "form-accepted-00000001")).rejects.toMatchObject({ code: "KILLED" } satisfies Partial<Cortex20WorkerError>);
    expect(delegate.deliver).not.toHaveBeenCalled();
  });
});

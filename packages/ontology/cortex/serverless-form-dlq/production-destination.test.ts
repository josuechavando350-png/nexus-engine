import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchLeadDestination, type LeadDestination } from "./index";
import { KillGuardedLeadDestination } from "./production-destination";
import { Cortex20WorkerError } from "./production-worker";

const submission = {
  submissionId: "submission-00000001",
  formId: "contact-form-0001",
  submittedAt: "2026-09-06T00:00:00.000Z",
  contactConsent: "GRANTED",
  fields: { name: "Cliente" },
} as const;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CORTEX #20 real lead destination adapter", () => {
  it("sends the stable idempotency key and accepts only a bounded receipt identity", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://crm.example/v1/leads"); expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
      const headers = init?.headers as Record<string, string>; expect(headers["idempotency-key"]).toBe("form-accepted-00000001");
      return new Response(null, { status: 200, headers: { "x-request-id": "receipt-00000001" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const destination = new FetchLeadDestination(new URL("https://crm.example/v1/leads"), "d".repeat(32), 1_000);
    await expect(destination.deliver(submission, "form-accepted-00000001")).resolves.toEqual({ receiptId: "receipt-00000001" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an ambiguous destination response without a receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const destination = new FetchLeadDestination(new URL("https://crm.example/v1/leads"), "d".repeat(32), 1_000);
    await expect(destination.deliver(submission, "form-accepted-00000001")).rejects.toThrowError(/receipt is invalid/u);
  });
});

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

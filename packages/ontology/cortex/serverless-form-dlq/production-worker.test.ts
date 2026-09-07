import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex20Error, encryptSubmission, type LeadDestination } from "./index";
import { Cortex20ProductionWorker, HttpCortex17FormEventClient } from "./production-worker";

const dirs: string[] = [];
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex20-prod-worker-")); dirs.push(dir); return join(dir, "worker.sqlite"); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const key = randomBytes(32).toString("base64");
const submission = { submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-06T00:00:00.000Z", contactConsent: "GRANTED", fields: { name: "Cliente", email: "client@example.invalid", message: "Necesito información" } } as const;
const acceptedEvent = {
  stream: "forms.accepted",
  eventId: "form-accepted-00000001",
  occurredAt: submission.submittedAt,
  sequence: 1,
  payload: { submissionIdHash: `sha256:${"a".repeat(64)}`, formId: submission.formId, encrypted: encryptSubmission(submission, key, "form-key-0001") },
} as const;

function responseForEvent(event: typeof acceptedEvent): Response { return Response.json({ events: [event] }); }

describe("CORTEX #20 production worker over CORTEX #17 HTTP boundary", () => {
  it("delivers a decrypted lead with idempotency and commits the remote offset only after destination success", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/events" && (!init?.method || init.method === "GET")) return responseForEvent(acceptedEvent);
      if (url.pathname === "/v1/offsets" && init?.method === "POST") return Response.json({ sequence: 1 });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const destination: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const client = new HttpCortex17FormEventClient(new URL("https://events.example/"), "r".repeat(32), "w".repeat(32), 1000);
    const worker = new Cortex20ProductionWorker({ databasePath: database(), eventClient: client, destination, encryptionKeyBase64: key, encryptionKeyId: "form-key-0001", consumerId: "form-worker-00000001", maxAttempts: 3, baseRetryDelayMs: 100, readMode: () => "ACTIVE" });
    const result = await worker.runOnce();
    expect(result).toEqual({ processed: 1, delivered: 1, dlq: 0, deferred: 0, offset: 1 });
    expect(destination.deliver).toHaveBeenCalledWith(expect.objectContaining({ submissionId: submission.submissionId }), acceptedEvent.eventId);
    const offsetCall = fetchMock.mock.calls.find(([input, init]) => new URL(String(input)).pathname === "/v1/offsets" && init?.method === "POST");
    expect(offsetCall).toBeDefined();
    worker.close();
  });

  it("persists retry timing locally and emits encrypted DLQ through #17 after max attempts", async () => {
    const appended: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/events" && (!init?.method || init.method === "GET")) return responseForEvent(acceptedEvent);
      if (url.pathname === "/v1/events" && init?.method === "POST") {
        const event = JSON.parse(String(init.body)) as { stream: string; eventId: string; occurredAt: string; payload: unknown };
        appended.push(event);
        return Response.json({ ...event, sequence: 2 }, { status: 201 });
      }
      if (url.pathname === "/v1/offsets" && init?.method === "POST") return Response.json({ sequence: 1 });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const destination: LeadDestination = { deliver: vi.fn(async () => { throw new Cortex20Error("DESTINATION_FAILURE", "downstream unavailable"); }) };
    let now = Date.parse("2026-09-06T00:10:00.000Z");
    const client = new HttpCortex17FormEventClient(new URL("https://events.example/"), "r".repeat(32), "w".repeat(32), 1000);
    const worker = new Cortex20ProductionWorker({ databasePath: database(), eventClient: client, destination, encryptionKeyBase64: key, encryptionKeyId: "form-key-0001", consumerId: "form-worker-00000002", maxAttempts: 2, baseRetryDelayMs: 100, readMode: () => "ACTIVE", now: () => now });
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 0, deferred: 0, offset: 0 });
    expect(await worker.runOnce()).toEqual({ processed: 0, delivered: 0, dlq: 0, deferred: 1, offset: 0 });
    now += 100;
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 1, deferred: 0, offset: 1 });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ stream: "forms.dlq", eventId: expect.stringMatching(/^dlq-/u) });
    expect(JSON.stringify(appended[0])).not.toContain(submission.fields.email);
    expect(JSON.stringify(appended[0])).not.toContain(submission.fields.message);
    worker.close();
  });

  it("survives restart with retry timing and local offset intact", async () => {
    const db = database(); let now = Date.parse("2026-09-06T00:20:00.000Z");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/events" && (!init?.method || init.method === "GET")) {
        const after = Number(url.searchParams.get("after") ?? "0");
        return Response.json({ events: after >= 1 ? [] : [acceptedEvent] });
      }
      if (url.pathname === "/v1/offsets" && init?.method === "POST") return Response.json({ sequence: 1 });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let deliveries = 0;
    const destination: LeadDestination = { deliver: vi.fn(async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Cortex20Error("DESTINATION_FAILURE", "ambiguous downstream failure");
      return { receiptId: "receipt-00000001" };
    }) };
    const makeWorker = () => new Cortex20ProductionWorker({
      databasePath: db,
      eventClient: new HttpCortex17FormEventClient(new URL("https://events.example/"), "r".repeat(32), "w".repeat(32), 1000),
      destination,
      encryptionKeyBase64: key,
      encryptionKeyId: "form-key-0001",
      consumerId: "form-worker-00000004",
      maxAttempts: 3,
      baseRetryDelayMs: 100,
      readMode: () => "ACTIVE",
      now: () => now,
    });
    let worker = makeWorker();
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 0, dlq: 0, deferred: 0, offset: 0 });
    worker.close();

    worker = makeWorker();
    expect(await worker.runOnce()).toEqual({ processed: 0, delivered: 0, dlq: 0, deferred: 1, offset: 0 });
    expect(deliveries).toBe(1);
    now += 100;
    expect(await worker.runOnce()).toEqual({ processed: 1, delivered: 1, dlq: 0, deferred: 0, offset: 1 });
    worker.close();

    worker = makeWorker();
    expect(await worker.runOnce()).toEqual({ processed: 0, delivered: 0, dlq: 0, deferred: 0, offset: 1 });
    expect(deliveries).toBe(2);
    worker.close();
  });

  it("performs no remote reads or deliveries while KILLED", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const destination: LeadDestination = { deliver: vi.fn(async () => ({ receiptId: "receipt-00000001" })) };
    const client = new HttpCortex17FormEventClient(new URL("https://events.example/"), "r".repeat(32), "w".repeat(32), 1000);
    const worker = new Cortex20ProductionWorker({ databasePath: database(), eventClient: client, destination, encryptionKeyBase64: key, encryptionKeyId: "form-key-0001", consumerId: "form-worker-00000003", maxAttempts: 2, baseRetryDelayMs: 100, readMode: () => "KILLED" });
    expect(await worker.runOnce()).toEqual({ processed: 0, delivered: 0, dlq: 0, deferred: 0, offset: 0 });
    expect(fetchMock).not.toHaveBeenCalled(); expect(destination.deliver).not.toHaveBeenCalled();
    worker.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSubmission, type FormSubmission } from "../serverless-form-dlq/index";
import { Cortex20ProductionWorker, HttpCortex17FormEventClient } from "../serverless-form-dlq/production-worker";
import type { RelayGateway } from "../webhook-relay/index";
import { PymeConsentAwareLeadDestination } from "./consent-aware-relay";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry } from "./consent-registry";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("CORTEX #20 -> #31 PyME durable lead delivery", () => {
  it("keeps an accepted encrypted lead pending through a provider outage and commits the offset only after retry succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-form-relay-")); dirs.push(dir);
    let now = Date.parse("2026-09-08T04:00:00.000Z");
    const registry = new SqlitePymeConsentRegistry(join(dir, "state.sqlite"), () => now);
    const subject = createPymeConsentSubjectId("PHONE", "+525512345678");
    registry.grant({ subjectId: subject, channel: "WHATSAPP", purpose: "lead_followup", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "form-consent-020031", decidedAt: "2026-09-08T03:59:00.000Z" });

    let providerCalls = 0;
    const gateway: RelayGateway = {
      async send() {
        providerCalls += 1;
        if (providerCalls === 1) throw new Error("provider temporarily unavailable");
        return { requestId: "provider-request-020031" };
      },
    };
    const destination = new PymeConsentAwareLeadDestination({
      databasePath: join(dir, "state.sqlite"), registry, gateway, channel: "WHATSAPP", purpose: "lead_followup", subjectField: "phone", subjectKind: "PHONE", allowedFields: ["name", "phone"], modeProvider: () => "ACTIVE", idempotencyContract: "EVENT_ID_IDEMPOTENT", now: () => now,
    });

    const submission: FormSubmission = Object.freeze({ submissionId: "submission-020031", formId: "contact-form-020031", submittedAt: "2026-09-08T03:59:30.000Z", contactConsent: "GRANTED", fields: Object.freeze({ name: "Ada", phone: "+525512345678" }) });
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSubmission(submission, key, "lead-key-020031");
    const accepted = { stream: "forms.accepted", eventId: "accepted-event-020031", occurredAt: submission.submittedAt, payload: { encrypted }, sequence: 1 };
    let committedOffset = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/events" && (init?.method ?? "GET") === "GET") {
        const after = Number(url.searchParams.get("after") ?? "0");
        return new Response(JSON.stringify({ events: after < 1 ? [accepted] : [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/v1/offsets" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { sequence: number };
        committedOffset = body.sequence;
        return new Response(JSON.stringify({ sequence: body.sequence }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected event service request ${init?.method ?? "GET"} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const eventClient = new HttpCortex17FormEventClient(new URL("https://events.example/"), "r".repeat(32), "w".repeat(32), 1_000);
    const worker = new Cortex20ProductionWorker({ databasePath: join(dir, "worker.sqlite"), eventClient, destination, encryptionKeyBase64: key, encryptionKeyId: "lead-key-020031", consumerId: "pyme-relay-worker-020031", maxAttempts: 3, baseRetryDelayMs: 100, readMode: () => "ACTIVE", now: () => now });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ processed: 1, delivered: 0, offset: 0 });
    expect(providerCalls).toBe(1);
    expect(committedOffset).toBe(0);

    now += 101;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ processed: 1, delivered: 1, offset: 1 });
    expect(providerCalls).toBe(2);
    expect(committedOffset).toBe(1);

    worker.close(); destination.close(); registry.close();
  });
});

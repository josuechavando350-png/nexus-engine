import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormSubmission } from "../serverless-form-dlq/index";
import type { RelayGateway, RelayInput } from "../webhook-relay/index";
import { PymeConsentAwareLeadDestination } from "./consent-aware-relay";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry } from "./consent-registry";

const dirs: string[] = [];
const NOW = Date.parse("2026-09-08T03:15:00.000Z");
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-relay-")); dirs.push(dir);
  const registry = new SqlitePymeConsentRegistry(join(dir, "state.sqlite"), () => NOW);
  const subject = createPymeConsentSubjectId("PHONE", "+525512345678");
  registry.grant({ subjectId: subject, channel: "WHATSAPP", purpose: "lead_followup", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "form-consent-0001", decidedAt: "2026-09-08T03:10:00.000Z" });
  const received: RelayInput[] = [];
  const gateway: RelayGateway = {
    send: vi.fn(async (event) => { received.push(event); return { requestId: "provider-request-0001" }; }),
  };
  let mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE";
  const destination = new PymeConsentAwareLeadDestination({
    databasePath: join(dir, "state.sqlite"), registry, gateway, channel: "WHATSAPP", purpose: "lead_followup", subjectField: "phone", subjectKind: "PHONE", allowedFields: ["name", "phone"], modeProvider: () => mode, idempotencyContract: "EVENT_ID_IDEMPOTENT", now: () => NOW,
  });
  const submission: FormSubmission = Object.freeze({ submissionId: "submission-00000001", formId: "contact-form-0001", submittedAt: "2026-09-08T03:12:00.000Z", contactConsent: "GRANTED", fields: Object.freeze({ name: "Ada", phone: "+525512345678", internalNote: "must-not-leave-cortex" }) });
  return { dir, registry, subject, gateway, received, destination, submission, setMode: (value: typeof mode) => { mode = value; } };
}

describe("CORTEX #31 PyME consent-aware relay", () => {
  it("sends only allowlisted lead fields and deduplicates exact event-id replays", async () => {
    const h = harness();
    await expect(h.destination.deliver(h.submission, "accepted-event-0001")).resolves.toEqual({ receiptId: "provider-request-0001" });
    await expect(h.destination.deliver(h.submission, "accepted-event-0001")).resolves.toEqual({ receiptId: "provider-request-0001" });
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.received[0]?.data).toEqual({ submissionId: "submission-00000001", formId: "contact-form-0001", fields: { name: "Ada", phone: "+525512345678" } });
    expect(JSON.stringify(h.received[0])).not.toContain("internalNote");
    h.destination.close(); h.registry.close();
  });

  it("returns provider failures to #20 for retry and safely reuses the same event id", async () => {
    const h = harness();
    let calls = 0;
    (h.gateway.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider outage");
      return { requestId: "provider-request-0002" };
    });
    await expect(h.destination.deliver(h.submission, "accepted-event-0002")).rejects.toMatchObject({ code: "DESTINATION_FAILURE" });
    await expect(h.destination.deliver(h.submission, "accepted-event-0002")).resolves.toEqual({ receiptId: "provider-request-0002" });
    expect(h.gateway.send).toHaveBeenCalledTimes(2);
    h.destination.close(); h.registry.close();
  });

  it("suppresses WhatsApp after opt-out without calling the provider", async () => {
    const h = harness();
    h.registry.revoke({ subjectId: h.subject, channel: "WHATSAPP", purpose: "lead_followup", expectedRevision: 1, reasonCode: "OPT_OUT", sourceRef: "privacy-center-0001", decidedAt: "2026-09-08T03:13:00.000Z" });
    await expect(h.destination.deliver(h.submission, "accepted-event-0003")).resolves.toMatchObject({ receiptId: expect.stringMatching(/^suppressed-/u) });
    expect(h.gateway.send).not.toHaveBeenCalled();
    expect(h.registry.auditTrail(h.subject).some((entry) => entry.outcome === "SUPPRESSED")).toBe(true);
    h.destination.close(); h.registry.close();
  });

  it("fails closed when the PyME capability gate is killed", async () => {
    const h = harness(); h.setMode("KILLED");
    await expect(h.destination.deliver(h.submission, "accepted-event-0004")).rejects.toMatchObject({ code: "DESTINATION_FAILURE" });
    expect(h.gateway.send).not.toHaveBeenCalled();
    h.destination.close(); h.registry.close();
  });
});

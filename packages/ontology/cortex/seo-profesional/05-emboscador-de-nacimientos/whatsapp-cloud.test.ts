import { describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppTemplatePayload,
  WhatsAppCloudApiClient,
  type WhatsAppConsentEvidence,
} from "./whatsapp-cloud.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const RECIPIENT = "+525512345678";

function consent(recipientE164 = RECIPIENT): WhatsAppConsentEvidence {
  return {
    status: "OPTED_IN",
    purpose: "DOMAIN_BIRTH_OUTREACH",
    recipientE164,
    capturedAt: "2026-09-01T10:00:00.000Z",
    source: "first-party contact form",
    proofId: "consent-proof-00000001",
  };
}

describe("WhatsApp Cloud API", () => {
  it("sends only a template payload to the official phone-number messages endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        contacts: [{ input: RECIPIENT, wa_id: "525512345678" }],
        messages: [{ id: "wamid.HBgMNTI1NTEyMzQ1Njc4FQIAERgS" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
      fetchImpl,
      now: () => NOW,
    });
    const receipt = await client.sendTemplate({
      recipientE164: RECIPIENT,
      consent: consent(),
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
      bodyParameters: ["example.com", "https://example.test/domain-intelligence"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/123456789012345/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "525512345678",
      type: "template",
      template: {
        name: "new_domain_welcome",
        language: { code: "es_MX" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: "example.com" },
            { type: "text", text: "https://example.test/domain-intelligence" },
          ],
        }],
      },
    });
    expect(receipt).toEqual({
      provider: "WHATSAPP_CLOUD_API",
      messageId: "wamid.HBgMNTI1NTEyMzQ1Njc4FQIAERgS",
      recipientWaId: "525512345678",
      graphApiVersion: "v26.0",
    });
  });

  it("rejects mismatched, out-of-scope, future, or withdrawn opt-in before any mutation", () => {
    const base = {
      recipientE164: RECIPIENT,
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
    };
    expect(() => buildWhatsAppTemplatePayload({ ...base, consent: consent("+525500000000") }, NOW)).toThrow(/different recipient/u);
    const wrongPurpose = { ...consent(), purpose: "GENERAL_MARKETING" } as unknown as WhatsAppConsentEvidence;
    expect(() => buildWhatsAppTemplatePayload({ ...base, consent: wrongPurpose }, NOW)).toThrow(/does not cover domain-birth outreach/u);
    expect(() => buildWhatsAppTemplatePayload({ ...base, consent: { ...consent(), capturedAt: "2026-09-09T00:00:00.000Z" } }, NOW)).toThrow(/future/u);
    expect(() => buildWhatsAppTemplatePayload({ ...base, consent: { ...consent(), withdrawnAt: "2026-09-08T11:00:00.000Z" } }, NOW)).toThrow(/withdrawn/u);
  });

  it("does not blindly retry or misclassify an ambiguous 5xx even when the provider body is malformed", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("not-json", { status: 503 }));
    const client = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
      fetchImpl,
      now: () => NOW,
    });
    await expect(client.sendTemplate({
      recipientE164: RECIPIENT,
      consent: consent(),
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
    })).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME", httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies access-token provider failure as authentication failure before network mutation", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => { throw new Error("must not fetch"); });
    const client = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => { throw new Error("secret backend unavailable"); },
      fetchImpl,
      now: () => NOW,
    });
    await expect(client.sendTemplate({
      recipientE164: RECIPIENT,
      consent: consent(),
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized successful response before parsing its body", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(512 * 1024 + 1) },
    }));
    const client = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
      fetchImpl,
      now: () => NOW,
    });
    await expect(client.sendTemplate({
      recipientE164: RECIPIENT,
      consent: consent(),
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

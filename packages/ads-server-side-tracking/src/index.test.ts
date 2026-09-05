import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEnhancedConversionDataLayerEvent,
  buildGoogleConsentModeDefaults,
  buildGoogleTagServerConfig,
  buildServerContainerCspSources,
  createGtmServerTransport,
  extractGoogleClickIds,
  filterClickIdsByConsent,
  hashEnhancedConversionUserData,
  type TrackingConsent,
} from "./index.js";

const granted: TrackingConsent = {
  analyticsStorage: "granted",
  adStorage: "granted",
  adUserData: "granted",
  adPersonalization: "granted",
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("Google tag server configuration", () => {
  it("routes the Google tag to an HTTPS first-party server container", () => {
    expect(buildGoogleTagServerConfig("https://metrics.example.com/"))
      .toEqual({ server_container_url: "https://metrics.example.com" });
    expect(buildServerContainerCspSources("https://metrics.example.com"))
      .toEqual({
        imgSrc: "https://metrics.example.com",
        connectSrc: "https://metrics.example.com",
        frameSrc: "https://metrics.example.com",
      });
  });

  it("rejects insecure, credentialed, or ambiguous server URLs", () => {
    expect(() => buildGoogleTagServerConfig("http://metrics.example.com")).toThrow(/HTTPS/u);
    expect(() => buildGoogleTagServerConfig("https://user:pass@metrics.example.com")).toThrow(/credentials/u);
    expect(() => buildGoogleTagServerConfig("https://metrics.example.com?debug=1")).toThrow(/query string/u);
  });

  it("maps Nexus consent into Google Consent Mode fields without changing decisions", () => {
    expect(buildGoogleConsentModeDefaults({
      analyticsStorage: "granted",
      adStorage: "denied",
      adUserData: "denied",
      adPersonalization: "denied",
    })).toEqual({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });
});

describe("Google click identifiers", () => {
  it("extracts GCLID, WBRAID, and GBRAID from landing URLs", () => {
    expect(extractGoogleClickIds("https://example.com/?gclid=g.123&wbraid=w-456&gbraid=g_789"))
      .toEqual({ gclid: "g.123", wbraid: "w-456", gbraid: "g_789" });
  });

  it("drops advertising identifiers when ad storage is denied", () => {
    expect(filterClickIdsByConsent(
      { gclid: "abc123", wbraid: "w123" },
      { ...granted, adStorage: "denied" },
    )).toEqual({});
  });

  it("rejects malformed identifiers instead of forwarding arbitrary input", () => {
    expect(() => extractGoogleClickIds("https://example.com/?gclid=bad%0Avalue")).toThrow(/control characters/u);
  });
});

describe("enhanced conversion user data", () => {
  it("normalizes and SHA-256 hashes protected fields before returning user_data", () => {
    const result = hashEnhancedConversionUserData({
      email: "  CLIENTE@Example.COM ",
      phoneNumber: "+52 55 1234 5678",
      firstName: " Josué ",
      lastName: " Pérez ",
      street: " Reforma 100 ",
      city: " Ciudad de México ",
      region: " CDMX ",
      postalCode: "06600",
      country: "mx",
    }, granted);

    expect(result.sha256_email_address).toBe(sha256("cliente@example.com"));
    expect(result.sha256_phone_number).toBe(sha256("+525512345678"));
    expect(result.address).toEqual({
      sha256_first_name: sha256("josué"),
      sha256_last_name: sha256("pérez"),
      sha256_street: sha256("reforma 100"),
      city: "ciudad de méxico",
      region: "cdmx",
      postal_code: "06600",
      country: "MX",
    });
    expect(JSON.stringify(result)).not.toContain("CLIENTE@Example.COM");
    expect(JSON.stringify(result)).not.toContain("+52 55 1234 5678");
  });

  it("applies Google's Gmail normalization before SHA-256", () => {
    const result = hashEnhancedConversionUserData({
      email: " First.Last@GMAIL.COM ",
    }, granted);
    expect(result.sha256_email_address).toBe(sha256("firstlast@gmail.com"));
  });

  it("accepts a complete address as a documented matching identifier", () => {
    const result = hashEnhancedConversionUserData({
      firstName: "Ana",
      lastName: "López",
      postalCode: "06600",
      country: "MX",
    }, granted);
    expect(result.address).toEqual({
      sha256_first_name: sha256("ana"),
      sha256_last_name: sha256("lópez"),
      postal_code: "06600",
      country: "MX",
    });
  });

  it("enforces explicit consent and the documented E.164 range", () => {
    expect(() => hashEnhancedConversionUserData(
      { email: "client@example.com" },
      { ...granted, adUserData: "denied" },
    )).toThrow(/adUserData consent/u);
    expect(() => hashEnhancedConversionUserData({ firstName: "Only Name" }, granted))
      .toThrow(/email, phoneNumber, or a complete address/u);
    expect(() => hashEnhancedConversionUserData({ phoneNumber: "+12345678" }, granted))
      .toThrow(/11 to 15 digits/u);
  });

  it("builds a GTM data-layer event with an explicit deduplication transaction ID", () => {
    const event = buildEnhancedConversionDataLayerEvent({
      eventName: "qualified_lead",
      eventId: "lead:crm:42",
      transactionId: "ORDER-2026-0042",
      consent: granted,
      userData: { email: "lead@example.com" },
      parameters: { lead_value_bucket: "high", form_version: 3 },
    });
    expect(event.event).toBe("qualified_lead");
    expect(event.event_id).toBe("lead:crm:42");
    expect(event.transaction_id).toBe("ORDER-2026-0042");
    expect(event.user_data).toEqual({ sha256_email_address: sha256("lead@example.com") });
    expect(() => buildEnhancedConversionDataLayerEvent({
      eventName: "lead",
      eventId: "lead-1",
      consent: granted,
      userData: { email: "lead@example.com" },
      parameters: { email: "raw@example.com" },
    })).toThrow(/reserved for protected data/u);
    expect(() => buildEnhancedConversionDataLayerEvent({
      eventName: "lead",
      eventId: "lead-2",
      consent: granted,
      userData: { email: "lead@example.com" },
      parameters: { transaction_id: "bypass" },
    })).toThrow(/reserved for protected data/u);
  });
});

describe("server-to-server GTM transport", () => {
  it("sends a real Measurement Protocol POST to the configured sGTM activation path", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const transport = createGtmServerTransport({
      serverContainerUrl: "https://metrics.example.com",
      activationPath: "/batch",
      tagId: "G-TEST123",
      fetchImplementation: fakeFetch,
    });

    const result = await transport.send({
      eventName: "lead_submitted",
      eventId: "evt:2026:0001",
      clientId: "123456789.987654321",
      consent: { ...granted, adPersonalization: "denied" },
      category: "lead",
      value: 250,
      pageLocation: "https://example.com/contacto",
      clickIds: { gclid: "CjwK-test", wbraid: "wbraid-1", gbraid: "gbraid_1" },
      dimensions: { 1: "organic-form" },
      metrics: { 1: 2.5 },
    });

    expect(capturedUrl).toBe("https://metrics.example.com/batch");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    expect(capturedInit?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "cache-control": "no-store",
      "x-nexus-event-id": "evt:2026:0001",
    });
    expect(typeof capturedInit?.body).toBe("string");

    const body = new URLSearchParams(String(capturedInit?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      v: "1",
      tid: "G-TEST123",
      cid: "123456789.987654321",
      t: "event",
      ec: "lead",
      ea: "lead_submitted",
      el: "evt:2026:0001",
      ev: "250",
      dl: "https://example.com/contacto",
      gclid: "CjwK-test",
      wbraid: "wbraid-1",
      gbraid: "gbraid_1",
      npa: "1",
      cd1: "organic-form",
      cm1: "2.5",
    });
    expect(result).toEqual({
      eventId: "evt:2026:0001",
      status: 204,
      endpoint: "https://metrics.example.com/batch",
      bytesSent: Buffer.byteLength(String(capturedInit?.body), "utf8"),
    });
  });

  it("fails closed before the network when analytics consent is denied", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const transport = createGtmServerTransport({
      serverContainerUrl: "https://metrics.example.com",
      activationPath: "/batch",
      tagId: "G-TEST123",
      fetchImplementation: fakeFetch,
    });

    await expect(transport.send({
      eventName: "lead_submitted",
      eventId: "evt-2",
      clientId: "client-2",
      consent: { ...granted, analyticsStorage: "denied" },
    })).rejects.toThrow(/analyticsStorage consent/u);
    expect(called).toBe(false);
  });

  it("does not transmit click identifiers when ad storage is denied", async () => {
    let body = "";
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      body = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const transport = createGtmServerTransport({
      serverContainerUrl: "https://metrics.example.com",
      activationPath: "/batch",
      tagId: "G-TEST123",
      fetchImplementation: fakeFetch,
    });

    await transport.send({
      eventName: "page_engaged",
      eventId: "evt-3",
      clientId: "client-3",
      consent: { ...granted, adStorage: "denied" },
      clickIds: { gclid: "must-not-leave", wbraid: "must-not-leave-either" },
    });
    expect(body).not.toContain("gclid");
    expect(body).not.toContain("wbraid");
    expect(body).not.toContain("must-not-leave");
  });

  it("surfaces non-2xx responses without leaking response bodies", async () => {
    const fakeFetch = (async () => new Response("provider-secret-detail", { status: 503 })) as typeof fetch;
    const transport = createGtmServerTransport({
      serverContainerUrl: "https://metrics.example.com",
      activationPath: "/batch",
      tagId: "G-TEST123",
      fetchImplementation: fakeFetch,
    });

    await expect(transport.send({
      eventName: "lead_submitted",
      eventId: "evt-4",
      clientId: "client-4",
      consent: granted,
    })).rejects.toMatchObject({
      name: "GtmServerTransportError",
      status: 503,
      eventId: "evt-4",
    });
  });
});

import { describe, expect, it } from "vitest";
import { createGtmServerTransport, type TrackingConsent } from "./index.js";

const granted: TrackingConsent = {
  analyticsStorage: "granted",
  adStorage: "granted",
  adUserData: "granted",
  adPersonalization: "granted",
};

describe("same-origin server container paths", () => {
  it("preserves the first-party server path before the Measurement Protocol activation path", async () => {
    let requestUrl = "";
    const fakeFetch = (async (input: string | URL | Request) => {
      requestUrl = String(input);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const transport = createGtmServerTransport({
      serverContainerUrl: "https://www.example.com/metrics/",
      activationPath: "/batch",
      tagId: "G-TEST123",
      fetchImplementation: fakeFetch,
    });

    await transport.send({
      eventName: "lead_submitted",
      eventId: "evt-path-1",
      clientId: "123.456",
      consent: granted,
    });

    expect(requestUrl).toBe("https://www.example.com/metrics/batch");
  });

  it("rejects activation paths that can traverse outside the configured first-party prefix", () => {
    expect(() => createGtmServerTransport({
      serverContainerUrl: "https://www.example.com/metrics",
      activationPath: "/../batch",
      tagId: "G-TEST123",
    })).toThrow(/dot segments/u);

    expect(() => createGtmServerTransport({
      serverContainerUrl: "https://www.example.com/metrics",
      activationPath: "/%2e%2e/batch",
      tagId: "G-TEST123",
    })).toThrow(/dot segments/u);
  });
});

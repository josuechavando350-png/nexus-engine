import { describe, expect, it, vi } from "vitest";
import { PassivePublicSiteProbe, type PinnedHttpsTransportPort } from "./public-site-probe.js";

function transport(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>): PinnedHttpsTransportPort {
  return {
    get: vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("no fake response available");
      return { status: next.status, headers: next.headers ?? { "content-type": "text/html" }, body: next.body ?? "" };
    }),
  };
}

describe("PassivePublicSiteProbe", () => {
  it("pins the request to a public resolved IP and captures only bounded homepage evidence", async () => {
    const fakeTransport = transport([{ status: 200, headers: { "content-type": "text/html", server: "cloudflare" }, body: "<html><title>Candidate</title></html>" }]);
    const probe = new PassivePublicSiteProbe({
      resolver: { resolve: async () => ["8.8.8.8"] },
      transport: fakeTransport,
      now: () => Date.parse("2026-09-08T20:00:00.000Z"),
    });
    await expect(probe.inspect("https://candidate.example/")).resolves.toEqual({
      requestedUrl: "https://candidate.example/",
      finalUrl: "https://candidate.example/",
      status: 200,
      headers: { "content-type": "text/html", server: "cloudflare" },
      html: "<html><title>Candidate</title></html>",
      capturedAt: "2026-09-08T20:00:00.000Z",
      source: "PINNED_HTTPS_PUBLIC_HOMEPAGE",
    });
    expect(fakeTransport.get).toHaveBeenCalledWith(new URL("https://candidate.example/"), "8.8.8.8", 10_000);
  });

  it("rejects private and documentation IP resolutions before transport", async () => {
    const fakeTransport = transport([]);
    const probe = new PassivePublicSiteProbe({ resolver: { resolve: async () => ["127.0.0.1"] }, transport: fakeTransport });
    await expect(probe.inspect("https://candidate.example/")).rejects.toMatchObject({ code: "NON_PUBLIC_ADDRESS" });
    expect(fakeTransport.get).not.toHaveBeenCalled();
  });

  it("rejects cross-origin redirects without probing the destination", async () => {
    const fakeTransport = transport([{ status: 302, headers: { location: "https://other.example/" } }]);
    const probe = new PassivePublicSiteProbe({ resolver: { resolve: async () => ["8.8.8.8"] }, transport: fakeTransport });
    await expect(probe.inspect("https://candidate.example/")).rejects.toMatchObject({ code: "REDIRECT_DENIED" });
    expect(fakeTransport.get).toHaveBeenCalledTimes(1);
  });

  it("rejects paths, query strings and non-HTTPS candidates to avoid arbitrary crawling", async () => {
    const probe = new PassivePublicSiteProbe({ resolver: { resolve: async () => ["8.8.8.8"] }, transport: transport([]) });
    await expect(probe.inspect("https://candidate.example/admin")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(probe.inspect("http://candidate.example/")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { GoogleBusinessProfileClient } from "./google-business-profile.js";
import { type LocalBusinessProfile } from "./local-business.js";
import { LocalBusinessPresenceEngine } from "./local-presence.js";

const LOCATION = "locations/1234567890123456789";

const profile: LocalBusinessProfile = {
  schemaType: "Attorney",
  name: "CANO Estrategia Penal",
  websiteUri: "https://cano.example/",
  primaryPhone: "+52 55 1234 5678",
  storefrontAddress: {
    regionCode: "MX",
    addressLines: ["Montecito 38"],
    locality: "Benito Juárez",
    administrativeArea: "CDMX",
    postalCode: "03810",
  },
  areaServed: ["Ciudad de México"],
};

function remote(overrides: Record<string, unknown> = {}) {
  return {
    name: LOCATION,
    title: "CANO Estrategia Penal",
    websiteUri: "https://cano.example/",
    phoneNumbers: { primaryPhone: "+52 55 1234 5678" },
    storefrontAddress: {
      regionCode: "MX",
      addressLines: ["Montecito 38"],
      locality: "Benito Juárez",
      administrativeArea: "CDMX",
      postalCode: "03810",
    },
    metadata: { canUpdate: true, hasGoogleUpdated: false },
    ...overrides,
  };
}

function engine(fetchImpl: typeof fetch) {
  return new LocalBusinessPresenceEngine({
    profile,
    locationName: LOCATION,
    client: new GoogleBusinessProfileClient({
      accessTokenProvider: async () => "oauth-access-token-business-profile-123456",
      fetchImpl,
      maxReadRetries: 0,
    }),
  });
}

describe("Iman del Mapa local presence engine", () => {
  it("plans only authoritative local fields and does not clear unspecified data", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify(remote({
      websiteUri: "https://old.example/",
      phoneNumbers: { primaryPhone: "+52 55 9999 9999" },
    })), { status: 200 }));
    const presence = engine(fetchImpl);
    const audit = await presence.auditGoogleBusinessProfile();
    expect(audit.syncPlan).toMatchObject({
      status: "DRIFT",
      driftFields: ["websiteUri", "phoneNumbers.primaryPhone"],
      patch: {
        websiteUri: "https://cano.example/",
        phoneNumbers: { primaryPhone: "+52 55 1234 5678" },
      },
    });
    expect(audit.syncPlan.patch).not.toHaveProperty("categories");
    expect(audit.local.jsonLd).not.toHaveProperty("aggregateRating");
  });

  it("validates a real GBP patch without applying it", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push({ method, url });
      if (method === "GET") return new Response(JSON.stringify(remote({ title: "CANO Old Name" })), { status: 200 });
      return new Response(JSON.stringify(remote()), { status: 200 });
    });
    const receipt = await engine(fetchImpl).syncGoogleBusinessProfile("VALIDATE_ONLY");
    expect(receipt).toMatchObject({ status: "VALIDATED", driftFields: ["title"] });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.method).toBe("PATCH");
    expect(new URL(requests[1]!.url).searchParams.get("validateOnly")).toBe("true");
  });

  it("applies drift and re-reads the location to prove the postcondition", async () => {
    let getCount = 0;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const method = init?.method ?? "GET";
      requests.push(method);
      if (method === "PATCH") return new Response(JSON.stringify(remote()), { status: 200 });
      getCount += 1;
      return new Response(JSON.stringify(getCount === 1 ? remote({ websiteUri: "https://old.example/" }) : remote()), { status: 200 });
    });
    const receipt = await engine(fetchImpl).syncGoogleBusinessProfile("APPLY");
    expect(receipt).toMatchObject({ status: "APPLIED", driftFields: ["websiteUri"] });
    expect(requests).toEqual(["GET", "PATCH", "GET"]);
  });

  it("blocks automatic writes when Google reports pending updates", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify(remote({ metadata: { canUpdate: true, hasGoogleUpdated: true } })), { status: 200 });
    });
    await expect(engine(fetchImpl).syncGoogleBusinessProfile("APPLY")).rejects.toMatchObject({ code: "GOOGLE_UPDATE_REVIEW_REQUIRED" });
    expect(calls).toBe(1);
  });

  it("exposes a network-free snapshot for request-time integration", () => {
    const fetchImpl: typeof fetch = vi.fn();
    const presence = engine(fetchImpl);
    expect(presence.canonicalWebsiteOrigin()).toBe("https://cano.example");
    expect(presence.snapshot()).toMatchObject({
      canonicalWebsiteOrigin: "https://cano.example",
      profile: { schemaType: "Attorney", name: "CANO Estrategia Penal" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

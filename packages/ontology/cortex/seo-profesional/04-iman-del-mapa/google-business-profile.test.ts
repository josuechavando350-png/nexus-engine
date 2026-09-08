import { describe, expect, it, vi } from "vitest";
import {
  GoogleBusinessProfileClient,
  GoogleBusinessProfileError,
} from "./google-business-profile.js";

const LOCATION = "locations/1234567890123456789";

function locationPayload(overrides: Record<string, unknown> = {}) {
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
    metadata: { canUpdate: true, hasGoogleUpdated: false, mapsUri: "https://maps.google.com/?cid=123", placeId: "ChIJ123" },
    ...overrides,
  };
}

function client(fetchImpl: typeof fetch, maxReadRetries = 0) {
  return new GoogleBusinessProfileClient({
    accessTokenProvider: async () => "oauth-access-token-business-profile-123456",
    fetchImpl,
    maxReadRetries,
  });
}

describe("Google Business Profile Business Information API client", () => {
  it("reads an existing location through v1 with an explicit readMask", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(locationPayload()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await client(fetchImpl).getLocation(LOCATION);
    expect(result).toMatchObject({
      name: LOCATION,
      title: "CANO Estrategia Penal",
      websiteUri: "https://cano.example/",
      metadata: { canUpdate: true, hasGoogleUpdated: false, placeId: "ChIJ123" },
    });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://mybusinessbusinessinformation.googleapis.com/v1/${LOCATION}`);
    expect(url.searchParams.get("readMask")).toBe("name,title,websiteUri,phoneNumbers,storefrontAddress,metadata");
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(requests[0]!.init.headers).toMatchObject({ authorization: "Bearer oauth-access-token-business-profile-123456" });
  });

  it("reads Google-updated state and field masks without auto-accepting it", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify({
      location: locationPayload({ phoneNumbers: { primaryPhone: "+52 55 9999 9999" } }),
      diffMask: "phoneNumbers.primaryPhone",
      pendingMask: "websiteUri,title",
    }), { status: 200 }));
    const result = await client(fetchImpl).getGoogleUpdated(LOCATION);
    expect(result.diffMask).toEqual(["phoneNumbers.primaryPhone"]);
    expect(result.pendingMask).toEqual(["websiteUri", "title"]);
    expect(result.location.phoneNumbers.primaryPhone).toBe("+52 55 9999 9999");
  });

  it("uses PATCH with updateMask and validateOnly instead of silently mutating", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), init: init ?? {}, body });
      return new Response(JSON.stringify(locationPayload({ title: "CANO Estrategia Penal" })), { status: 200 });
    });
    await client(fetchImpl).patchLocation(LOCATION, {
      title: "CANO Estrategia Penal",
      websiteUri: "https://cano.example/",
    }, ["title", "websiteUri"], "VALIDATE_ONLY");
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("updateMask")).toBe("title,websiteUri");
    expect(url.searchParams.get("validateOnly")).toBe("true");
    expect(requests[0]!.init.method).toBe("PATCH");
    expect(requests[0]!.body).toEqual({
      name: LOCATION,
      title: "CANO Estrategia Penal",
      websiteUri: "https://cano.example/",
    });
  });

  it("does not retry an ambiguous apply mutation after a server failure", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "temporary failure" } }), { status: 503 });
    });
    await expect(client(fetchImpl, 5).patchLocation(LOCATION, { title: "CANO Estrategia Penal" }, ["title"], "APPLY"))
      .rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME", httpStatus: 503 });
    expect(calls).toBe(1);
  });

  it("rejects a mutation mask that does not have the corresponding field", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    await expect(client(fetchImpl).patchLocation(LOCATION, {}, ["websiteUri"], "APPLY")).rejects.toBeInstanceOf(GoogleBusinessProfileError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects hidden patch fields that are absent from updateMask", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    await expect(client(fetchImpl).patchLocation(LOCATION, {
      title: "CANO Estrategia Penal",
      websiteUri: "https://unexpected.example/",
    }, ["title"], "APPLY")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

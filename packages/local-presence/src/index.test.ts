import { describe, expect, it } from "vitest";
import {
  compareLocation,
  createCanonicalLocation,
  createControlledProviderLocation,
  executeGoogleBusinessProfileSync,
  fetchGoogleBusinessProfileLocation,
  fetchGoogleBusinessProfileReviews,
  localBusinessJsonLd,
  planGoogleBusinessProfileSync,
  replyGoogleBusinessProfileReview,
  validateLiveProviderLocation,
} from "./index.js";

const canonical = () => createCanonicalLocation({
  locationId: "mx-colima-1",
  name: "Nexus Legal",
  phone: "+52 312 123 4567",
  website: "https://example.com/",
  address: { addressLines: ["Av. Constitución 100"], locality: "Colima", administrativeArea: "Colima", postalCode: "28000", regionCode: "MX" },
  categories: ["LawFirm"],
});

const controlled = () => createControlledProviderLocation({
  providerId: "google-business-profile",
  externalId: "locations/123",
  name: "Nexus Legal",
  phone: "+52 312 123 4567",
  website: "https://example.com/",
  address: canonical().address,
});

describe("local presence", () => {
  it("keeps a canonical provider snapshot in sync", () => {
    expect(compareLocation(canonical(), controlled()).state).toBe("IN_SYNC");
  });

  it("detects NAP drift and builds a digest-bound GBP patch", () => {
    const provider = createControlledProviderLocation({ ...controlled(), phone: "+52 312 000 0000" });
    const comparison = compareLocation(canonical(), provider);
    expect(comparison.state).toBe("DRIFT");
    expect(comparison.differences).toContain("phone");
    const plan = planGoogleBusinessProfileSync(canonical(), provider);
    expect(plan.updateMask).toEqual(["phoneNumbers.primaryPhone"]);
    expect(plan.patch).toMatchObject({ phoneNumbers: { primaryPhone: "+52 312 123 4567" } });
  });

  it("does not treat caller-fabricated GBP authority as live evidence", () => {
    const base = controlled();
    const forged = { ...base, sourceAuthority: "GOOGLE_BUSINESS_PROFILE_API" as const };
    expect(() => validateLiveProviderLocation(forged)).toThrow(/not live-attested/);
  });

  it("returns UNAVAILABLE without OAuth rather than claiming provider success", async () => {
    await expect(fetchGoogleBusinessProfileLocation("locations/123", undefined)).resolves.toEqual({ status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" });
    await expect(fetchGoogleBusinessProfileReviews("1", "2", undefined)).resolves.toEqual({ status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" });
  });

  it("fetches and live-attests a Business Information location", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("mybusinessbusinessinformation.googleapis.com/v1/locations/123");
      expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
      return new Response(JSON.stringify({
        name: "locations/123", title: "Nexus Legal", websiteUri: "https://example.com/",
        phoneNumbers: { primaryPhone: "+52 312 123 4567" },
        storefrontAddress: { addressLines: ["Av. Constitución 100"], locality: "Colima", administrativeArea: "Colima", postalCode: "28000", regionCode: "MX" },
      }), { status: 200 });
    };
    const result = await fetchGoogleBusinessProfileLocation("locations/123", "token", fakeFetch as typeof fetch);
    expect(result.status).toBe("PASS");
    expect(result.value?.sourceAuthority).toBe("GOOGLE_BUSINESS_PROFILE_API");
    expect(() => validateLiveProviderLocation(result.value!)).not.toThrow();
  });

  it("requires approval and exact current live snapshot before GBP writes", async () => {
    const responseBody = { name: "locations/123", title: "Nexus Legal", websiteUri: "https://example.com/", phoneNumbers: { primaryPhone: "+52 312 000 0000" }, storefrontAddress: { addressLines: ["Av. Constitución 100"], locality: "Colima", administrativeArea: "Colima", postalCode: "28000", regionCode: "MX" } };
    const readFetch = (async () => new Response(JSON.stringify(responseBody), { status: 200 })) as typeof fetch;
    const current = (await fetchGoogleBusinessProfileLocation("locations/123", "token", readFetch)).value!;
    const plan = planGoogleBusinessProfileSync(canonical(), current);
    await expect(executeGoogleBusinessProfileSync(plan, canonical(), current, "token", false, readFetch)).resolves.toMatchObject({ status: "FAIL" });
    const writeFetch = (async (_url, init) => {
      expect(init?.method).toBe("PATCH");
      expect(String(init?.body)).toContain("+52 312 123 4567");
      return new Response(JSON.stringify({ ...responseBody, phoneNumbers: { primaryPhone: "+52 312 123 4567" } }), { status: 200 });
    }) as typeof fetch;
    await expect(executeGoogleBusinessProfileSync(plan, canonical(), current, "token", true, writeFetch)).resolves.toMatchObject({ status: "PASS" });
  });

  it("fetches real review fields without inventing rating aggregates", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ reviews: [{ reviewId: "r1", reviewer: { displayName: "Ada" }, starRating: "FIVE", comment: "Excelente", createTime: "2026-08-01T00:00:00Z" }] }), { status: 200 })) as typeof fetch;
    const result = await fetchGoogleBusinessProfileReviews("1", "2", "token", fakeFetch);
    expect(result.status).toBe("PASS");
    expect(result.value?.[0]).toMatchObject({ reviewId: "r1", reviewerName: "Ada", starRating: "FIVE" });
  });

  it("never writes a review reply without caller approval", async () => {
    const neverFetch = (async () => { throw new Error("should not call provider"); }) as typeof fetch;
    await expect(replyGoogleBusinessProfileReview("1", "2", "r", "Gracias", "token", false, neverFetch)).resolves.toMatchObject({ status: "FAIL" });
    const fakeFetch = (async (_url, init) => { expect(init?.method).toBe("PUT"); expect(String(init?.body)).toContain("Gracias"); return new Response("{}", { status: 200 }); }) as typeof fetch;
    await expect(replyGoogleBusinessProfileReview("1", "2", "r", "Gracias", "token", true, fakeFetch)).resolves.toEqual({ status: "PASS", value: true });
  });

  it("emits factual LocalBusiness JSON-LD without AggregateRating or Review", () => {
    const schema = localBusinessJsonLd(canonical(), "LegalService");
    expect(schema).toMatchObject({ "@context": "https://schema.org", "@type": "LegalService", name: "Nexus Legal" });
    expect(schema).not.toHaveProperty("aggregateRating");
    expect(schema).not.toHaveProperty("review");
  });

  it("rejects malformed identifiers and non-http websites", async () => {
    expect(() => createCanonicalLocation({ ...canonical(), website: "javascript:alert(1)" })).toThrow(/HTTP/);
    await expect(fetchGoogleBusinessProfileLocation("../locations/123", "token")).resolves.toMatchObject({ status: "FAIL" });
  });
});

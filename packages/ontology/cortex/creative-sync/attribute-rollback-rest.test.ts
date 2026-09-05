import { describe, expect, it } from "vitest";
import { GoogleAdsApiError } from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";
import { GoogleAdsCreativeRestClient } from "./google-ads-creative-rest";

const CUSTOMER = "1234567890";
const ATTRIBUTE = `customers/${CUSTOMER}/customizerAttributes/7777777777`;

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function attributeResponse(): Response {
  return response({ results: [{ customizerAttribute: { resourceName: ATTRIBUTE, id: "7777777777", name: "Price", type: "PRICE", status: "ENABLED" } }] });
}

function client(steps: readonly Response[]) {
  const calls: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
  let index = 0;
  const rest = new GoogleAdsCreativeRestClient({
    developerToken: "developer-token",
    accessTokenProvider: async () => "access-token",
    maxReadRetries: 0,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("missing request body");
      calls.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> });
      const next = steps[index++];
      if (!next) throw new Error(`unexpected fetch ${index}`);
      return next;
    }) as typeof fetch,
  });
  return { rest, calls };
}

describe("customizer attribute rollback dependency guard", () => {
  it("removes the exact attribute only after all four hierarchy levels prove unbound", async () => {
    const { rest, calls } = client([
      attributeResponse(),
      response({ results: [] }),
      response({ results: [] }),
      response({ results: [] }),
      response({ results: [] }),
      response({ results: [{ resourceName: ATTRIBUTE }] }),
    ]);
    const receipt = await rest.applyMutation(CUSTOMER, { kind: "REMOVE_CUSTOMIZER_ATTRIBUTE", resourceName: ATTRIBUTE, name: "Price", type: "PRICE" });
    expect(receipt.resourceName).toBe(ATTRIBUTE);
    expect(calls).toHaveLength(6);
    const guardQueries = calls.slice(1, 5).map((call) => String(call.body.query));
    expect(guardQueries[0]).toContain("FROM customer_customizer");
    expect(guardQueries[1]).toContain("FROM campaign_customizer");
    expect(guardQueries[2]).toContain("FROM ad_group_customizer");
    expect(guardQueries[3]).toContain("FROM ad_group_criterion_customizer");
    expect(calls[5]!.url).toContain("/customizerAttributes:mutate");
    expect(calls[5]!.body).toEqual({ operations: [{ remove: ATTRIBUTE }], partialFailure: false });
  });

  it("fails closed before removal when any external hierarchy binding exists", async () => {
    const { rest, calls } = client([
      attributeResponse(),
      response({ results: [] }),
      response({ results: [{ campaignCustomizer: { resourceName: `customers/${CUSTOMER}/campaignCustomizers/222~7777777777` } }] }),
    ]);
    try {
      await rest.applyMutation(CUSTOMER, { kind: "REMOVE_CUSTOMIZER_ATTRIBUTE", resourceName: ATTRIBUTE, name: "Price", type: "PRICE" });
      throw new Error("expected rollback conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAdsApiError);
      expect(error).toMatchObject({ code: "REMOTE_CONFLICT" });
    }
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.url.includes("customizerAttributes:mutate"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { BusinessProfitabilityTransportError, HttpBusinessProfitabilityProvider } from "./http-profitability-provider";

const query = {
  customerId: "1234567890",
  scopeKind: "CAMPAIGN" as const,
  scopeId: "1111111111",
  windowStart: "2026-08-20T00:00:00.000Z",
  windowEnd: "2026-09-03T00:00:00.000Z",
};
const snapshot = {
  ...query,
  revenueMicros: 18_000_000,
  grossProfitBeforeAdSpendMicros: 12_000_000,
  qualifiedConversions: 9,
  observedAt: "2026-09-05T22:00:00.000Z",
  sourceId: "finance-ledger-v1",
};
const token = "profitability-test-token-000000000000000000000";

describe("CORTEX authenticated profitability provider", () => {
  it("posts the exact business query over HTTPS with bearer authentication and rejects redirects", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const provider = new HttpBusinessProfitabilityProvider({
      endpoint: "https://finance.example.test/cortex/profitability",
      bearerToken: token,
      fetchImpl: async (input, init) => {
        observedUrl = String(input);
        observedInit = init;
        return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      },
    });
    await expect(provider.getProfitability(query)).resolves.toEqual(snapshot);
    expect(observedUrl).toBe("https://finance.example.test/cortex/profitability");
    expect(new Headers(observedInit?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(observedInit?.redirect).toBe("error");
    expect(JSON.parse(String(observedInit?.body))).toEqual(query);
  });

  it("rejects insecure endpoints and malformed or oversized responses", async () => {
    expect(() => new HttpBusinessProfitabilityProvider({ endpoint: "http://finance.example.test/data", bearerToken: token }))
      .toThrow(/must use https/i);

    const extraField = new HttpBusinessProfitabilityProvider({
      endpoint: "https://finance.example.test/data",
      bearerToken: token,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, email: "not-allowed@example.test" }), { headers: { "content-type": "application/json" } }),
    });
    await expect(extraField.getProfitability(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const wrongType = new HttpBusinessProfitabilityProvider({
      endpoint: "https://finance.example.test/data",
      bearerToken: token,
      fetchImpl: async () => new Response(JSON.stringify(snapshot), { headers: { "content-type": "text/plain" } }),
    });
    await expect(wrongType.getProfitability(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const oversized = new HttpBusinessProfitabilityProvider({
      endpoint: "https://finance.example.test/data",
      bearerToken: token,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, padding: "x".repeat(40_000) }), { headers: { "content-type": "application/json" } }),
    });
    await expect(oversized.getProfitability(query)).rejects.toBeInstanceOf(BusinessProfitabilityTransportError);
  });
});
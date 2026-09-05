import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_API_VERSION,
  GoogleAdsApiError,
  GoogleAdsRestClient,
  createGoogleOAuthRefreshTokenProvider,
  type GoogleAdsControlMutation,
} from "./google-ads-rest";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type FetchStep = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function sequenceFetch(steps: readonly FetchStep[]) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const step = steps[index++];
    if (!step) throw new Error(`unexpected fetch call ${index}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? await step(call) : step;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(steps: readonly FetchStep[], options: { readonly maxReadRetries?: number; readonly sleep?: (ms: number) => Promise<void> } = {}) {
  const sequence = sequenceFetch(steps);
  const rest = new GoogleAdsRestClient({
    developerToken: "developer-token-secret",
    loginCustomerId: "123-456-7890",
    accessTokenProvider: async () => "oauth-access-token",
    fetchImpl: sequence.fetchImpl,
    maxReadRetries: options.maxReadRetries ?? 0,
    sleep: options.sleep,
  });
  return { rest, calls: sequence.calls };
}

function campaignSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign: {
      id: "1111111111",
      name: "Search Brand",
      resourceName: "customers/1234567890/campaigns/1111111111",
      status: "ENABLED",
      campaignBudget: "customers/1234567890/campaignBudgets/2222222222",
      biddingStrategyType: "MAXIMIZE_CONVERSIONS",
      biddingStrategySystemStatus: "ENABLED",
      maximizeConversions: { targetCpaMicros: "50000000" },
      ...overrides,
    },
    campaignBudget: { amountMicros: "100000000", explicitlyShared: false, recommendedBudgetAmountMicros: "120000000" },
    metrics: { costMicros: "700000000", conversions: "21.5", conversionsValue: "1900.25" },
  };
}

function portfolioSearchRow(type: "TARGET_CPA" | "TARGET_ROAS" = "TARGET_CPA") {
  const strategy = type === "TARGET_CPA"
    ? { targetCpa: { targetCpaMicros: "45000000", cpcBidCeilingMicros: "9000000", cpcBidFloorMicros: "1000000" } }
    : { targetRoas: { targetRoas: 4.2, cpcBidCeilingMicros: "9000000", cpcBidFloorMicros: "1000000" } };
  return {
    biddingStrategy: {
      resourceName: "customers/1234567890/biddingStrategies/3333333333",
      id: "3333333333",
      type,
      ...strategy,
    },
    metrics: { costMicros: "900000000", conversions: 30, conversionsValue: 3000 },
  };
}

function body(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("expected JSON string request body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function mutationBody(call: FetchCall): { readonly updateMask: string; readonly update: Record<string, unknown> } {
  const root = body(call);
  if (!Array.isArray(root.operations) || root.operations.length !== 1) throw new Error("expected one operation");
  const operation = root.operations[0] as Record<string, unknown>;
  if (typeof operation.updateMask !== "string" || !operation.update || typeof operation.update !== "object") throw new Error("invalid mutate operation");
  return { updateMask: operation.updateMask, update: operation.update as Record<string, unknown> };
}

describe("Google Ads REST adapter", () => {
  it("uses the released v25 REST surface and required authorization headers", async () => {
    const { rest, calls } = client([response({ results: [campaignSearchRow()] })]);
    const snapshot = await rest.getCampaignSnapshot("123-456-7890", "1111111111", Date.parse("2026-08-20T00:00:00.000Z"), Date.parse("2026-09-02T00:00:00.000Z"));
    expect(GOOGLE_ADS_API_VERSION).toBe("v25");
    expect(snapshot.campaignId).toBe("1111111111");
    expect(snapshot.standardTargetCpaMicros).toBe(50_000_000);
    expect(snapshot.costMicros).toBe(700_000_000);
    expect(calls[0]!.url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-access-token");
    expect(headers["developer-token"]).toBe("developer-token-secret");
    expect(headers["login-customer-id"]).toBe("1234567890");
    expect(String(body(calls[0]!).query)).toContain("campaign.bidding_strategy_system_status");
    expect(String(body(calls[0]!).query)).toContain("segments.date BETWEEN '2026-08-20' AND '2026-09-02'");
  });

  it("refreshes OAuth tokens with the standard refresh-token grant and caches safely", async () => {
    let now = 1_000_000;
    const sequence = sequenceFetch([
      response({ access_token: "token-a", expires_in: 3600 }),
      response({ access_token: "token-b", expires_in: 3600 }),
    ]);
    const provider = createGoogleOAuthRefreshTokenProvider({
      clientId: "client-id-secret",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value",
      fetchImpl: sequence.fetchImpl,
      now: () => now,
    });
    expect(await provider()).toBe("token-a");
    expect(await provider()).toBe("token-a");
    expect(sequence.calls).toHaveLength(1);
    expect(sequence.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const firstBody = sequence.calls[0]!.init?.body;
    expect(firstBody).toBeInstanceOf(URLSearchParams);
    expect(String(firstBody)).toContain("grant_type=refresh_token");
    now += 3_301_000;
    expect(await provider()).toBe("token-b");
    expect(sequence.calls).toHaveLength(2);
  });

  it("retries retry-safe reads on quota responses but never turns that into mutation retries", async () => {
    const sleeps: number[] = [];
    const { rest, calls } = client([
      response({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, 429, { "retry-after": "1" }),
      response({ results: [campaignSearchRow()] }),
    ], { maxReadRetries: 1, sleep: async (ms) => { sleeps.push(ms); } });
    await rest.getCampaignSnapshot("1234567890", "1111111111", Date.parse("2026-08-20T00:00:00.000Z"), Date.parse("2026-09-02T00:00:00.000Z"));
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("parses portfolio targets and bid bounds from aggregate strategy metrics", async () => {
    const { rest } = client([response({ results: [portfolioSearchRow("TARGET_ROAS")] })]);
    const snapshot = await rest.getPortfolioSnapshot("1234567890", "customers/1234567890/biddingStrategies/3333333333", Date.parse("2026-08-20T00:00:00.000Z"), Date.parse("2026-09-02T00:00:00.000Z"));
    expect(snapshot.type).toBe("TARGET_ROAS");
    expect(snapshot.targetRoas).toBe(4.2);
    expect(snapshot.cpcBidCeilingMicros).toBe(9_000_000);
    expect(snapshot.cpcBidFloorMicros).toBe(1_000_000);
    expect(snapshot.costMicros).toBe(900_000_000);
  });

  it("preflights and applies an absolute campaign budget mutation with the exact field mask", async () => {
    const action: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: "customers/1234567890/campaignBudgets/2222222222", expectedAmountMicros: 100_000_000, nextAmountMicros: 110_000_000 };
    const { rest, calls } = client([
      response({ results: [{ campaignBudget: { resourceName: action.resourceName, amountMicros: "100000000" } }] }),
      response({ results: [{ resourceName: action.resourceName }] }, 200, { "request-id": "req-budget" }),
    ]);
    const receipt = await rest.applyMutation("1234567890", action);
    expect(receipt).toEqual({ requestId: "req-budget", resourceName: action.resourceName, recoveredAlreadyApplied: false });
    expect(calls[1]!.url).toContain("/campaignBudgets:mutate");
    expect(mutationBody(calls[1]!).updateMask).toBe("amount_micros");
    expect(mutationBody(calls[1]!).update).toEqual({ resourceName: action.resourceName, amountMicros: 110_000_000 });
  });

  it("uses exact nested masks for standard tCPA and tROAS", async () => {
    const campaignName = "customers/1234567890/campaigns/1111111111";
    const cpa = client([
      response({ results: [{ campaign: { resourceName: campaignName, campaignBudget: "customers/1234567890/campaignBudgets/2222222222", maximizeConversions: { targetCpaMicros: "50000000" } }, campaignBudget: { amountMicros: "100000000" } }] }),
      response({ results: [{ resourceName: campaignName }] }),
    ]);
    await cpa.rest.applyMutation("1234567890", { kind: "STANDARD_TARGET_CPA", resourceName: campaignName, expectedTargetCpaMicros: 50_000_000, nextTargetCpaMicros: 55_000_000 });
    expect(mutationBody(cpa.calls[1]!).updateMask).toBe("maximize_conversions.target_cpa_micros");
    expect(mutationBody(cpa.calls[1]!).update.maximizeConversions).toEqual({ targetCpaMicros: 55_000_000 });

    const roas = client([
      response({ results: [{ campaign: { resourceName: campaignName, campaignBudget: "customers/1234567890/campaignBudgets/2222222222", maximizeConversionValue: { targetRoas: 4 } }, campaignBudget: { amountMicros: "100000000" } }] }),
      response({ results: [{ resourceName: campaignName }] }),
    ]);
    await roas.rest.applyMutation("1234567890", { kind: "STANDARD_TARGET_ROAS", resourceName: campaignName, expectedTargetRoas: 4, nextTargetRoas: 3.6 });
    expect(mutationBody(roas.calls[1]!).updateMask).toBe("maximize_conversion_value.target_roas");
    expect(mutationBody(roas.calls[1]!).update.maximizeConversionValue).toEqual({ targetRoas: 3.6 });
  });

  it("uses portfolio-specific schemes and masks for targets and CPC bounds", async () => {
    const resourceName = "customers/1234567890/biddingStrategies/3333333333";
    const target = client([
      response({ results: [{ biddingStrategy: { resourceName, type: "TARGET_CPA", targetCpa: { targetCpaMicros: "45000000", cpcBidCeilingMicros: "9000000", cpcBidFloorMicros: "1000000" } } }] }),
      response({ results: [{ resourceName }] }),
    ]);
    await target.rest.applyMutation("1234567890", { kind: "PORTFOLIO_TARGET_CPA", resourceName, strategyType: "TARGET_CPA", expectedTargetCpaMicros: 45_000_000, nextTargetCpaMicros: 49_500_000 });
    expect(mutationBody(target.calls[1]!).updateMask).toBe("target_cpa.target_cpa_micros");
    expect(mutationBody(target.calls[1]!).update.targetCpa).toEqual({ targetCpaMicros: 49_500_000 });

    const bounds = client([
      response({ results: [{ biddingStrategy: { resourceName, type: "TARGET_ROAS", targetRoas: { targetRoas: 4.2, cpcBidCeilingMicros: "9000000", cpcBidFloorMicros: "1000000" } } }] }),
      response({ results: [{ resourceName }] }),
    ]);
    await bounds.rest.applyMutation("1234567890", { kind: "PORTFOLIO_BID_BOUNDS", resourceName, strategyType: "TARGET_ROAS", expectedCeilingMicros: 9_000_000, nextCeilingMicros: 9_900_000, expectedFloorMicros: 1_000_000, nextFloorMicros: 900_000 });
    expect(mutationBody(bounds.calls[1]!).updateMask).toBe("target_roas.cpc_bid_ceiling_micros,target_roas.cpc_bid_floor_micros");
    expect(mutationBody(bounds.calls[1]!).update.targetRoas).toEqual({ cpcBidCeilingMicros: 9_900_000, cpcBidFloorMicros: 900_000 });
  });

  it("recovers an already-applied absolute mutation without issuing a second mutate request", async () => {
    const action: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: "customers/1234567890/campaignBudgets/2222222222", expectedAmountMicros: 100_000_000, nextAmountMicros: 110_000_000 };
    const { rest, calls } = client([response({ results: [{ campaignBudget: { resourceName: action.resourceName, amountMicros: "110000000" } }] })]);
    expect(await rest.applyMutation("1234567890", action)).toEqual({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
    expect(calls).toHaveLength(1);
  });

  it("rejects remote drift before mutate", async () => {
    const action: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: "customers/1234567890/campaignBudgets/2222222222", expectedAmountMicros: 100_000_000, nextAmountMicros: 110_000_000 };
    const { rest, calls } = client([response({ results: [{ campaignBudget: { resourceName: action.resourceName, amountMicros: "105000000" } }] })]);
    await expect(rest.applyMutation("1234567890", action)).rejects.toMatchObject({ code: "REMOTE_CONFLICT" });
    expect(calls).toHaveLength(1);
  });

  it("treats transport errors, 5xx, and un-certifiable success responses as ambiguous mutation outcomes", async () => {
    const action: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: "customers/1234567890/campaignBudgets/2222222222", expectedAmountMicros: 100_000_000, nextAmountMicros: 110_000_000 };
    for (const mutationStep of [new Error("socket closed"), response({ error: { status: "INTERNAL", message: "server" } }, 500), response({ unexpected: true })] as const) {
      const { rest, calls } = client([
        response({ results: [{ campaignBudget: { resourceName: action.resourceName, amountMicros: "100000000" } }] }),
        mutationStep,
      ], { maxReadRetries: 3 });
      await expect(rest.applyMutation("1234567890", action)).rejects.toMatchObject({ code: "AMBIGUOUS_MUTATION_OUTCOME" });
      expect(calls).toHaveLength(2);
    }
  });

  it("keeps known HTTP validation failures distinct from ambiguous transport outcomes", async () => {
    const action: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: "customers/1234567890/campaignBudgets/2222222222", expectedAmountMicros: 100_000_000, nextAmountMicros: 110_000_000 };
    const { rest } = client([
      response({ results: [{ campaignBudget: { resourceName: action.resourceName, amountMicros: "100000000" } }] }),
      response({ error: { status: "INVALID_ARGUMENT", message: "bad mutate" } }, 400, { "request-id": "req-invalid" }),
    ]);
    try {
      await rest.applyMutation("1234567890", action);
      throw new Error("expected mutation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAdsApiError);
      expect(error).toMatchObject({ code: "API_ERROR", httpStatus: 400, requestId: "req-invalid", googleStatus: "INVALID_ARGUMENT" });
    }
  });

  it("does not expose OAuth secrets in refresh failure messages", async () => {
    const sequence = sequenceFetch([new Error("network included no response")]);
    const provider = createGoogleOAuthRefreshTokenProvider({ clientId: "client-id-secret", clientSecret: "super-secret-client", refreshToken: "super-secret-refresh", fetchImpl: sequence.fetchImpl });
    try {
      await provider();
      throw new Error("expected OAuth refresh to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAdsApiError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-client");
      expect(message).not.toContain("super-secret-refresh");
    }
  });
});
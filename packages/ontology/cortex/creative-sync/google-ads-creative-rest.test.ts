import { describe, expect, it } from "vitest";
import { GoogleAdsApiError } from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";
import { GoogleAdsCreativeRestClient } from "./google-ads-creative-rest";
import type { CreativeSyncAction, CustomizerScopeKind, ResponsiveSearchAdContent } from "./index";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type FetchStep = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

const CUSTOMER = "1234567890";
const ATTRIBUTE = `customers/${CUSTOMER}/customizerAttributes/7777777777`;
const AD = `customers/${CUSTOMER}/ads/3333333333`;
const AD_GROUP = `customers/${CUSTOMER}/adGroups/4444444444`;

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
  const rest = new GoogleAdsCreativeRestClient({
    developerToken: "developer-token-secret",
    loginCustomerId: "123-456-7890",
    accessTokenProvider: async () => "oauth-access-token",
    fetchImpl: sequence.fetchImpl,
    maxReadRetries: options.maxReadRetries ?? 0,
    sleep: options.sleep,
  });
  return { rest, calls: sequence.calls };
}

function requestBody(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("expected string body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function rsaContent(headline = "Old headline"): ResponsiveSearchAdContent {
  return {
    headlines: [
      { text: headline, pinnedField: "HEADLINE_1" },
      { text: "Legal strategy", pinnedField: null },
      { text: "Talk to our team", pinnedField: null },
    ],
    descriptions: [
      { text: "Get clear next steps for your legal matter.", pinnedField: null },
      { text: "Schedule a consultation with our legal team.", pinnedField: "DESCRIPTION_2" },
    ],
    path1: "legal",
    path2: "consulta",
    finalUrls: ["https://example.com/legal"],
    finalMobileUrls: [],
  };
}

function rsaRow(content = rsaContent()) {
  return {
    adGroup: { resourceName: AD_GROUP },
    adGroupAd: {
      status: "ENABLED",
      ad: {
        id: "3333333333",
        resourceName: AD,
        type: "RESPONSIVE_SEARCH_AD",
        finalUrls: content.finalUrls,
        finalMobileUrls: content.finalMobileUrls,
        responsiveSearchAd: {
          headlines: content.headlines.map((asset) => asset.pinnedField ? { text: asset.text, pinnedField: asset.pinnedField } : { text: asset.text }),
          descriptions: content.descriptions.map((asset) => asset.pinnedField ? { text: asset.text, pinnedField: asset.pinnedField } : { text: asset.text }),
          path1: content.path1,
          path2: content.path2,
        },
      },
    },
  };
}

function customizerRow(scopeKind: CustomizerScopeKind, stringValue = "100USD") {
  const resourceByKind: Record<CustomizerScopeKind, string> = {
    CUSTOMER: `customers/${CUSTOMER}/customerCustomizers/7777777777`,
    CAMPAIGN: `customers/${CUSTOMER}/campaignCustomizers/2222222222~7777777777`,
    AD_GROUP: `customers/${CUSTOMER}/adGroupCustomizers/4444444444~7777777777`,
    AD_GROUP_CRITERION: `customers/${CUSTOMER}/adGroupCriterionCustomizers/4444444444~5555555555~7777777777`,
  };
  const keyByKind: Record<CustomizerScopeKind, string> = {
    CUSTOMER: "customerCustomizer",
    CAMPAIGN: "campaignCustomizer",
    AD_GROUP: "adGroupCustomizer",
    AD_GROUP_CRITERION: "adGroupCriterionCustomizer",
  };
  const scopeByKind: Record<CustomizerScopeKind, Record<string, string>> = {
    CUSTOMER: {},
    CAMPAIGN: { campaign: `customers/${CUSTOMER}/campaigns/2222222222` },
    AD_GROUP: { adGroup: AD_GROUP },
    AD_GROUP_CRITERION: { adGroupCriterion: `customers/${CUSTOMER}/adGroupCriteria/4444444444~5555555555` },
  };
  return {
    [keyByKind[scopeKind]]: {
      resourceName: resourceByKind[scopeKind],
      customizerAttribute: ATTRIBUTE,
      status: "ENABLED",
      value: { type: "PRICE", stringValue },
      ...scopeByKind[scopeKind],
    },
  };
}

function scopeResource(scopeKind: CustomizerScopeKind): string {
  if (scopeKind === "CUSTOMER") return `customers/${CUSTOMER}`;
  if (scopeKind === "CAMPAIGN") return `customers/${CUSTOMER}/campaigns/2222222222`;
  if (scopeKind === "AD_GROUP") return AD_GROUP;
  return `customers/${CUSTOMER}/adGroupCriteria/4444444444~5555555555`;
}

describe("GoogleAdsCreativeRestClient", () => {
  it("reads an RSA from Google Ads v25 with exact auth headers and fields", async () => {
    const { rest, calls } = client([response({ results: [rsaRow()] })]);
    const snapshot = await rest.getResponsiveSearchAd(CUSTOMER, AD);
    expect(snapshot?.resourceName).toBe(AD);
    expect(snapshot?.headlines[0]).toEqual({ text: "Old headline", pinnedField: "HEADLINE_1" });
    expect(snapshot?.descriptions[1]).toEqual({ text: "Schedule a consultation with our legal team.", pinnedField: "DESCRIPTION_2" });
    expect(calls[0]!.url).toBe(`https://googleads.googleapis.com/v25/customers/${CUSTOMER}/googleAds:search`);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-access-token");
    expect(headers["developer-token"]).toBe("developer-token-secret");
    expect(headers["login-customer-id"]).toBe(CUSTOMER);
    const query = String(requestBody(calls[0]!).query);
    expect(query).toContain("ad_group_ad.ad.responsive_search_ad.headlines");
    expect(query).toContain("ad_group_ad.ad.id = 3333333333");
    expect(query).toContain("RESPONSIVE_SEARCH_AD");
  });

  it.each([
    ["CUSTOMER", "customer_customizer", "customerCustomizers:mutate"],
    ["CAMPAIGN", "campaign_customizer", "campaignCustomizers:mutate"],
    ["AD_GROUP", "ad_group_customizer", "adGroupCustomizers:mutate"],
    ["AD_GROUP_CRITERION", "ad_group_criterion_customizer", "adGroupCriterionCustomizers:mutate"],
  ] as const)("reads and atomically replaces %s values through the correct resource/service", async (scopeKind, gaqlResource, servicePath) => {
    const current = customizerRow(scopeKind, "100USD");
    const replacementResource = Object.values(current)[0]!.resourceName;
    const { rest, calls } = client([
      response({ results: [current] }),
      response({ results: [{ resourceName: replacementResource }, { resourceName: replacementResource }] }, 200, { "request-id": `req-${scopeKind}` }),
    ]);
    const action: CreativeSyncAction = {
      kind: "UPSERT_CUSTOMIZER_VALUE",
      scopeKind,
      scopeResourceName: scopeResource(scopeKind),
      attributeResourceName: ATTRIBUTE,
      type: "PRICE",
      expected: {
        resourceName: replacementResource,
        attributeResourceName: ATTRIBUTE,
        type: "PRICE",
        scopeKind,
        scopeResourceName: scopeResource(scopeKind),
        stringValue: "100USD",
        status: "ENABLED",
      },
      desiredStringValue: "125USD",
    };
    const receipt = await rest.applyMutation(CUSTOMER, action);
    expect(receipt).toEqual({ requestId: `req-${scopeKind}`, resourceName: replacementResource, recoveredAlreadyApplied: false });
    expect(String(requestBody(calls[0]!).query)).toContain(`FROM ${gaqlResource}`);
    expect(calls[1]!.url).toContain(`/${servicePath}`);
    const mutation = requestBody(calls[1]!);
    expect(mutation.partialFailure).toBe(false);
    expect(mutation.operations).toEqual([
      { remove: replacementResource },
      { create: expect.objectContaining({ customizerAttribute: ATTRIBUTE, value: { type: "PRICE", stringValue: "125USD" } }) },
    ]);
  });

  it("creates a missing attribute only after preflight and recovers a matching existing attribute", async () => {
    const created = `customers/${CUSTOMER}/customizerAttributes/8888888888`;
    const first = client([
      response({ results: [] }),
      response({ results: [{ resourceName: created }] }, 200, { "request-id": "req-create" }),
    ]);
    expect(await first.rest.applyMutation(CUSTOMER, { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: "Price", type: "PRICE" })).toEqual({
      requestId: "req-create", resourceName: created, recoveredAlreadyApplied: false,
    });
    expect(first.calls[1]!.url).toContain("/customizerAttributes:mutate");
    expect(requestBody(first.calls[1]!).operations).toEqual([{ create: { name: "Price", type: "PRICE" } }]);

    const recovered = client([response({ results: [{ customizerAttribute: { resourceName: created, id: "8888888888", name: "Price", type: "PRICE", status: "ENABLED" } }] })]);
    expect(await recovered.rest.applyMutation(CUSTOMER, { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: "price", type: "PRICE" })).toEqual({
      requestId: null, resourceName: created, recoveredAlreadyApplied: true,
    });
    expect(recovered.calls).toHaveLength(1);
  });

  it("updates RSA fields through AdService with the exact field mask after remote preflight", async () => {
    const desired = rsaContent("Book a consultation");
    const { rest, calls } = client([
      response({ results: [rsaRow()] }),
      response({ results: [{ resourceName: AD }] }, 200, { "request-id": "req-rsa" }),
    ]);
    const receipt = await rest.applyMutation(CUSTOMER, { kind: "UPDATE_RSA", resourceName: AD, expected: rsaContent(), desired });
    expect(receipt).toEqual({ requestId: "req-rsa", resourceName: AD, recoveredAlreadyApplied: false });
    expect(calls[1]!.url).toContain("/ads:mutate");
    const root = requestBody(calls[1]!);
    expect(root.partialFailure).toBe(false);
    const operations = root.operations as Array<Record<string, unknown>>;
    expect(operations).toHaveLength(1);
    expect(operations[0]!.updateMask).toBe("responsive_search_ad.headlines,responsive_search_ad.descriptions,responsive_search_ad.path1,responsive_search_ad.path2,final_urls,final_mobile_urls");
    expect(operations[0]!.update).toEqual(expect.objectContaining({ resourceName: AD, finalUrls: desired.finalUrls, finalMobileUrls: [] }));
  });

  it("fails closed on RSA drift before mutate and recovers an already-applied RSA without a second write", async () => {
    const desired = rsaContent("Book a consultation");
    const drifted = client([response({ results: [rsaRow(rsaContent("Third-party headline"))] })]);
    await expect(drifted.rest.applyMutation(CUSTOMER, { kind: "UPDATE_RSA", resourceName: AD, expected: rsaContent(), desired })).rejects.toMatchObject({ code: "REMOTE_CONFLICT" });
    expect(drifted.calls).toHaveLength(1);

    const recovered = client([response({ results: [rsaRow(desired)] })]);
    expect(await recovered.rest.applyMutation(CUSTOMER, { kind: "UPDATE_RSA", resourceName: AD, expected: rsaContent(), desired })).toEqual({
      requestId: null, resourceName: AD, recoveredAlreadyApplied: true,
    });
    expect(recovered.calls).toHaveLength(1);
  });

  it("retries retry-safe reads on quota responses but never blindly retries mutations", async () => {
    const sleeps: number[] = [];
    const reads = client([
      response({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, 429, { "retry-after": "1" }),
      response({ results: [] }),
    ], { maxReadRetries: 1, sleep: async (ms) => { sleeps.push(ms); } });
    await reads.rest.getCustomizerAttributes(CUSTOMER);
    expect(reads.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);

    const write = client([
      response({ results: [] }),
      response({ error: { status: "INTERNAL", message: "server" } }, 500),
    ], { maxReadRetries: 5 });
    await expect(write.rest.applyMutation(CUSTOMER, { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: "Price", type: "PRICE" })).rejects.toMatchObject({ code: "AMBIGUOUS_MUTATION_OUTCOME" });
    expect(write.calls).toHaveLength(2);
  });

  it("classifies transport failures and uncertifiable 2xx mutation responses as ambiguous", async () => {
    for (const mutationStep of [new Error("socket closed"), response({ unexpected: true })] as const) {
      const { rest, calls } = client([response({ results: [] }), mutationStep]);
      try {
        await rest.applyMutation(CUSTOMER, { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: "Price", type: "PRICE" });
        throw new Error("expected mutation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleAdsApiError);
        expect(error).toMatchObject({ code: "AMBIGUOUS_MUTATION_OUTCOME" });
      }
      expect(calls).toHaveLength(2);
    }
  });
});

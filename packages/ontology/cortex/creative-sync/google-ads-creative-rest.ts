import { canonicalJson } from "@nexus/ontology";
import {
  GOOGLE_ADS_API_VERSION,
  GoogleAdsApiError,
  type GoogleAdsAccessTokenProvider,
} from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";
import type {
  CreativeMutationReceipt,
  CreativeSyncAction,
  CreativeTextAsset,
  CustomizerAttributeSnapshot,
  CustomizerAttributeType,
  CustomizerScopeKind,
  CustomizerValueSnapshot,
  DesiredCustomizerValue,
  GoogleAdsCreativeGateway,
  ResponsiveSearchAdContent,
  ResponsiveSearchAdSnapshot,
  RsaPinnedField,
} from "./index";

const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com";
const ATTRIBUTE_RESOURCE = /^customers\/(\d{5,20})\/customizerAttributes\/(\d{1,20})$/;
const AD_RESOURCE = /^customers\/(\d{5,20})\/ads\/(\d{1,20})$/;
const ATTRIBUTE_TYPES: readonly CustomizerAttributeType[] = ["TEXT", "NUMBER", "PRICE", "PERCENT"];
const PINNED_FIELDS: readonly RsaPinnedField[] = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", "DESCRIPTION_1", "DESCRIPTION_2"];

export interface GoogleAdsCreativeRestClientConfig {
  readonly developerToken: string;
  readonly loginCustomerId?: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly maxReadRetries?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function secret(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new GoogleAdsApiError("INVALID_CONFIG", `${field} is required`);
  return normalized;
}

function numericId(value: string, field: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!/^\d{5,20}$/.test(normalized)) throw new GoogleAdsApiError("INVALID_CONFIG", `${field} is malformed`);
  return normalized;
}

function safePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GoogleAdsApiError("INVALID_CONFIG", `${field} must be a positive safe integer`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field} must be a string array`);
  return Object.freeze([...value] as string[]);
}

function attributeType(value: unknown, field: string): CustomizerAttributeType {
  if (typeof value !== "string" || !ATTRIBUTE_TYPES.includes(value as CustomizerAttributeType)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field} is not a supported customizer type`);
  return value as CustomizerAttributeType;
}

function textAssets(value: unknown, field: string): readonly CreativeTextAsset[] {
  if (!Array.isArray(value)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field} must be an array`);
  return Object.freeze(value.map((entry, index) => {
    const raw = object(entry, `${field}[${index}]`);
    const text = string(raw.text, `${field}[${index}].text`);
    const pinnedField = optionalString(raw.pinnedField);
    if (pinnedField !== null && !PINNED_FIELDS.includes(pinnedField as RsaPinnedField)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${field}[${index}].pinnedField is invalid`);
    return Object.freeze({ text, pinnedField: pinnedField as RsaPinnedField | null });
  }));
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1_000));
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.min(60_000, Math.max(0, absolute - Date.now())) : null;
}

function googleError(payload: unknown): { readonly status: string | null; readonly message: string } {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return {
    status: typeof error?.status === "string" ? error.status : null,
    message: typeof error?.message === "string" && error.message ? error.message.slice(0, 500) : "Google Ads API request failed",
  };
}

function gaqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function resourceId(resourceName: string, regex: RegExp, expectedCustomer: string, field: string): string {
  const match = regex.exec(resourceName);
  if (!match?.[1] || !match[2] || match[1] !== expectedCustomer) throw new GoogleAdsApiError("INVALID_CONFIG", `${field} is malformed or belongs to another customer`);
  return match[2];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function content(snapshot: ResponsiveSearchAdSnapshot): ResponsiveSearchAdContent {
  return Object.freeze({
    headlines: snapshot.headlines,
    descriptions: snapshot.descriptions,
    path1: snapshot.path1,
    path2: snapshot.path2,
    finalUrls: snapshot.finalUrls,
    finalMobileUrls: snapshot.finalMobileUrls,
  });
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class GoogleAdsCreativeRestClient implements GoogleAdsCreativeGateway {
  private readonly developerToken: string;
  private readonly loginCustomerId: string | null;
  private readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxReadRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GoogleAdsCreativeRestClientConfig) {
    this.developerToken = secret(config.developerToken, "developerToken");
    this.loginCustomerId = config.loginCustomerId ? numericId(config.loginCustomerId, "loginCustomerId") : null;
    this.accessTokenProvider = config.accessTokenProvider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxReadRetries = config.maxReadRetries ?? 2;
    if (!Number.isInteger(this.maxReadRetries) || this.maxReadRetries < 0 || this.maxReadRetries > 5) throw new GoogleAdsApiError("INVALID_CONFIG", "maxReadRetries must be 0..5");
    this.timeoutMs = config.timeoutMs ?? 20_000;
    safePositiveInt(this.timeoutMs, "timeoutMs");
    this.sleep = config.sleep ?? defaultSleep;
  }

  private async request(
    customerInput: string,
    path: string,
    body: Record<string, unknown>,
    retrySafe: boolean,
  ): Promise<{ readonly payload: unknown; readonly requestId: string | null }> {
    const customer = numericId(customerInput, "customerId");
    const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${customer}/${path}`;
    const attempts = retrySafe ? this.maxReadRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accessToken = secret(await this.accessTokenProvider(), "OAuth access token");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "developer-token": this.developerToken,
        };
        if (this.loginCustomerId) headers["login-customer-id"] = this.loginCustomerId;
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        const requestId = response.headers.get("request-id");
        let payload: unknown = null;
        try { payload = await response.json(); } catch { payload = null; }
        if (response.ok) return { payload, requestId };
        const detail = googleError(payload);
        if (retrySafe && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe && response.status >= 500) {
          throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "Google Ads creative mutation returned a server error; remote application is unconfirmed", response.status, requestId, detail.status);
        }
        const code = response.status === 429 || detail.status === "RESOURCE_EXHAUSTED"
          ? "QUOTA_EXHAUSTED"
          : response.status === 401 || response.status === 403
            ? "AUTHENTICATION_FAILED"
            : "API_ERROR";
        throw new GoogleAdsApiError(code, detail.message, response.status, requestId, detail.status);
      } catch (error) {
        if (error instanceof GoogleAdsApiError) throw error;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (retrySafe && attempt + 1 < attempts) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe) throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", aborted ? "Google Ads creative mutation timed out; remote application is unconfirmed" : "Google Ads creative mutation transport failed; remote application is unconfirmed");
        if (aborted) throw new GoogleAdsApiError("TIMEOUT", "Google Ads creative read timed out");
        throw new GoogleAdsApiError("API_ERROR", "Google Ads creative read transport failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GoogleAdsApiError("API_ERROR", "Google Ads creative retry loop exhausted");
  }

  private async search(customer: string, query: string): Promise<readonly Record<string, unknown>[]> {
    const { payload } = await this.request(customer, "googleAds:search", { query }, true);
    const root = object(payload, "Google Ads search response");
    if (root.nextPageToken) throw new GoogleAdsApiError("INVALID_RESPONSE", "creative synchronization query unexpectedly exceeded one page");
    if (root.results === undefined) return Object.freeze([]);
    if (!Array.isArray(root.results)) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads search results must be an array");
    return Object.freeze(root.results.map((row, index) => object(row, `Google Ads search result ${index}`)));
  }

  async getCustomizerAttributes(customerInput: string): Promise<readonly CustomizerAttributeSnapshot[]> {
    const customer = numericId(customerInput, "customerId");
    const rows = await this.search(customer, [
      "SELECT customizer_attribute.resource_name, customizer_attribute.id, customizer_attribute.name, customizer_attribute.type, customizer_attribute.status",
      "FROM customizer_attribute WHERE customizer_attribute.status = ENABLED LIMIT 40",
    ].join(" "));
    const seen = new Set<string>();
    return Object.freeze(rows.map((row, index) => {
      const raw = object(row.customizerAttribute, `customizerAttribute[${index}]`);
      const resourceName = string(raw.resourceName, "customizerAttribute.resourceName");
      const id = resourceId(resourceName, ATTRIBUTE_RESOURCE, customer, "customizerAttribute.resourceName");
      const name = string(raw.name, "customizerAttribute.name");
      const key = name.toLocaleLowerCase("en-US");
      if (seen.has(key)) throw new GoogleAdsApiError("INVALID_RESPONSE", `duplicate enabled customizer attribute ${name}`);
      seen.add(key);
      if (raw.status !== "ENABLED") throw new GoogleAdsApiError("INVALID_RESPONSE", "customizer attribute query returned non-enabled status");
      return Object.freeze({ resourceName, id, name, type: attributeType(raw.type, "customizerAttribute.type"), status: "ENABLED" as const });
    }));
  }

  async getResponsiveSearchAd(customerInput: string, resourceName: string): Promise<ResponsiveSearchAdSnapshot | null> {
    const customer = numericId(customerInput, "customerId");
    const adId = resourceId(resourceName, AD_RESOURCE, customer, "RSA resourceName");
    const rows = await this.search(customer, [
      "SELECT ad_group.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.resource_name, ad_group_ad.ad.type,",
      "ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls, ad_group_ad.ad.responsive_search_ad.headlines,",
      "ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2",
      `FROM ad_group_ad WHERE ad_group_ad.ad.id = ${adId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != REMOVED LIMIT 2`,
    ].join(" "));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new GoogleAdsApiError("INVALID_RESPONSE", `RSA ${resourceName} did not resolve uniquely`);
    const adGroupAd = object(rows[0]!.adGroupAd, "adGroupAd");
    const ad = object(adGroupAd.ad, "adGroupAd.ad");
    const rsa = object(ad.responsiveSearchAd, "adGroupAd.ad.responsiveSearchAd");
    const observedResource = string(ad.resourceName, "ad.resourceName");
    if (observedResource !== resourceName) throw new GoogleAdsApiError("REMOTE_CONFLICT", "RSA resource changed before synchronization");
    const observedId = typeof ad.id === "number" ? String(ad.id) : string(ad.id, "ad.id");
    if (observedId !== adId) throw new GoogleAdsApiError("INVALID_RESPONSE", "RSA ad ID did not match requested ad");
    return Object.freeze({
      resourceName: observedResource,
      adId,
      adGroupResourceName: string(object(rows[0]!.adGroup, "adGroup").resourceName, "adGroup.resourceName"),
      status: string(adGroupAd.status, "adGroupAd.status"),
      headlines: textAssets(rsa.headlines, "responsiveSearchAd.headlines"),
      descriptions: textAssets(rsa.descriptions, "responsiveSearchAd.descriptions"),
      path1: optionalString(rsa.path1),
      path2: optionalString(rsa.path2),
      finalUrls: stringArray(ad.finalUrls, "ad.finalUrls"),
      finalMobileUrls: stringArray(ad.finalMobileUrls, "ad.finalMobileUrls"),
    });
  }

  private valueResource(scopeKind: CustomizerScopeKind): {
    readonly from: string;
    readonly jsonKey: string;
    readonly field: string;
    readonly servicePath: string;
    readonly createScopeField: string | null;
  } {
    switch (scopeKind) {
      case "CUSTOMER": return { from: "customer_customizer", jsonKey: "customerCustomizer", field: "customer_customizer", servicePath: "customerCustomizers:mutate", createScopeField: null };
      case "CAMPAIGN": return { from: "campaign_customizer", jsonKey: "campaignCustomizer", field: "campaign_customizer", servicePath: "campaignCustomizers:mutate", createScopeField: "campaign" };
      case "AD_GROUP": return { from: "ad_group_customizer", jsonKey: "adGroupCustomizer", field: "ad_group_customizer", servicePath: "adGroupCustomizers:mutate", createScopeField: "adGroup" };
      case "AD_GROUP_CRITERION": return { from: "ad_group_criterion_customizer", jsonKey: "adGroupCriterionCustomizer", field: "ad_group_criterion_customizer", servicePath: "adGroupCriterionCustomizers:mutate", createScopeField: "adGroupCriterion" };
    }
  }

  private async hasCustomizerBindings(customer: string, attributeResourceName: string): Promise<boolean> {
    const resources: readonly { readonly from: string; readonly field: string }[] = [
      { from: "customer_customizer", field: "customer_customizer" },
      { from: "campaign_customizer", field: "campaign_customizer" },
      { from: "ad_group_customizer", field: "ad_group_customizer" },
      { from: "ad_group_criterion_customizer", field: "ad_group_criterion_customizer" },
    ];
    for (const resource of resources) {
      const rows = await this.search(customer, [
        `SELECT ${resource.field}.resource_name`,
        `FROM ${resource.from} WHERE ${resource.field}.customizer_attribute = ${gaqlString(attributeResourceName)}`,
        `AND ${resource.field}.status != REMOVED LIMIT 1`,
      ].join(" "));
      if (rows.length > 0) return true;
    }
    return false;
  }

  async getCustomizerValue(
    customerInput: string,
    lookup: Pick<DesiredCustomizerValue, "scopeKind" | "scopeResourceName"> & { readonly attributeResourceName: string },
  ): Promise<CustomizerValueSnapshot | null> {
    const customer = numericId(customerInput, "customerId");
    resourceId(lookup.attributeResourceName, ATTRIBUTE_RESOURCE, customer, "customizer attribute resourceName");
    const descriptor = this.valueResource(lookup.scopeKind);
    const scopeClause = descriptor.createScopeField === null ? "" : ` AND ${descriptor.field}.${descriptor.from === "ad_group_criterion_customizer" ? "ad_group_criterion" : descriptor.from === "ad_group_customizer" ? "ad_group" : "campaign"} = ${gaqlString(lookup.scopeResourceName)}`;
    const query = [
      `SELECT ${descriptor.field}.resource_name, ${descriptor.field}.customizer_attribute, ${descriptor.field}.status, ${descriptor.field}.value.type, ${descriptor.field}.value.string_value`,
      descriptor.createScopeField === null ? "" : `, ${descriptor.field}.${descriptor.from === "ad_group_criterion_customizer" ? "ad_group_criterion" : descriptor.from === "ad_group_customizer" ? "ad_group" : "campaign"}`,
      `FROM ${descriptor.from} WHERE ${descriptor.field}.customizer_attribute = ${gaqlString(lookup.attributeResourceName)}${scopeClause} AND ${descriptor.field}.status != REMOVED LIMIT 2`,
    ].join(" ");
    const rows = await this.search(customer, query);
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new GoogleAdsApiError("INVALID_RESPONSE", "customizer value did not resolve uniquely");
    const raw = object(rows[0]![descriptor.jsonKey], descriptor.jsonKey);
    if (raw.status !== "ENABLED") throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer value is not enabled");
    const observedAttribute = string(raw.customizerAttribute, `${descriptor.jsonKey}.customizerAttribute`);
    if (observedAttribute !== lookup.attributeResourceName) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer attribute changed before synchronization");
    if (descriptor.createScopeField !== null) {
      const observedScope = string(raw[descriptor.createScopeField], `${descriptor.jsonKey}.${descriptor.createScopeField}`);
      if (observedScope !== lookup.scopeResourceName) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer scope changed before synchronization");
    }
    const value = object(raw.value, `${descriptor.jsonKey}.value`);
    return Object.freeze({
      resourceName: string(raw.resourceName, `${descriptor.jsonKey}.resourceName`),
      attributeResourceName: observedAttribute,
      type: attributeType(value.type, `${descriptor.jsonKey}.value.type`),
      scopeKind: lookup.scopeKind,
      scopeResourceName: lookup.scopeResourceName,
      stringValue: string(value.stringValue, `${descriptor.jsonKey}.value.stringValue`),
      status: "ENABLED",
    });
  }

  private async mutate(
    customer: string,
    path: string,
    operations: readonly Record<string, unknown>[],
    expectedResourceName?: string,
  ): Promise<CreativeMutationReceipt> {
    const { payload, requestId } = await this.request(customer, path, { operations, partialFailure: false }, false);
    try {
      const root = object(payload, "Google Ads mutate response");
      if (!Array.isArray(root.results) || root.results.length !== operations.length) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads mutate response result count did not match operations");
      const last = object(root.results[root.results.length - 1], "Google Ads mutate result");
      const resourceName = string(last.resourceName, "Google Ads mutate result resourceName");
      if (expectedResourceName && resourceName !== expectedResourceName) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads mutate result resource did not match expected resource");
      return Object.freeze({ requestId, resourceName, recoveredAlreadyApplied: false });
    } catch (error) {
      if (error instanceof GoogleAdsApiError && error.code === "AMBIGUOUS_MUTATION_OUTCOME") throw error;
      throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "Google Ads accepted the creative mutation request but the response could not certify the resulting resource", 200, requestId);
    }
  }

  private createCustomizerPayload(action: Extract<CreativeSyncAction, { kind: "UPSERT_CUSTOMIZER_VALUE" }>): Record<string, unknown> {
    const descriptor = this.valueResource(action.scopeKind);
    const create: Record<string, unknown> = {
      customizerAttribute: action.attributeResourceName,
      value: { type: action.type, stringValue: action.desiredStringValue },
    };
    if (descriptor.createScopeField) create[descriptor.createScopeField] = action.scopeResourceName;
    return create;
  }

  async applyMutation(customerInput: string, action: CreativeSyncAction): Promise<CreativeMutationReceipt> {
    const customer = numericId(customerInput, "customerId");
    if (action.kind === "CREATE_CUSTOMIZER_ATTRIBUTE") {
      const attributes = await this.getCustomizerAttributes(customer);
      const existing = attributes.find((attribute) => attribute.name.toLocaleLowerCase("en-US") === action.name.toLocaleLowerCase("en-US"));
      if (existing) {
        if (existing.type !== action.type) throw new GoogleAdsApiError("REMOTE_CONFLICT", `customizer attribute ${action.name} now exists with another type`);
        return Object.freeze({ requestId: null, resourceName: existing.resourceName, recoveredAlreadyApplied: true });
      }
      if (attributes.length >= 40) throw new GoogleAdsApiError("REMOTE_CONFLICT", "Google Ads account reached the enabled customizer attribute limit");
      return this.mutate(customer, "customizerAttributes:mutate", [{ create: { name: action.name, type: action.type } }]);
    }

    if (action.kind === "REMOVE_CUSTOMIZER_ATTRIBUTE") {
      const attributes = await this.getCustomizerAttributes(customer);
      const existing = attributes.find((attribute) => attribute.resourceName === action.resourceName);
      if (!existing) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
      if (existing.name !== action.name || existing.type !== action.type) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer attribute changed before rollback");
      if (await this.hasCustomizerBindings(customer, action.resourceName)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer attribute gained a live hierarchy binding before rollback");
      return this.mutate(customer, "customizerAttributes:mutate", [{ remove: action.resourceName }], action.resourceName);
    }

    if (action.kind === "UPDATE_RSA") {
      const current = await this.getResponsiveSearchAd(customer, action.resourceName);
      if (!current) throw new GoogleAdsApiError("REMOTE_CONFLICT", "RSA disappeared before mutation");
      const currentContent = content(current);
      if (same(currentContent, action.desired)) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
      if (!same(currentContent, action.expected)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "RSA changed after synchronization observation");
      const desired = action.desired;
      const update = {
        resourceName: action.resourceName,
        responsiveSearchAd: {
          headlines: desired.headlines.map((asset) => asset.pinnedField ? { text: asset.text, pinnedField: asset.pinnedField } : { text: asset.text }),
          descriptions: desired.descriptions.map((asset) => asset.pinnedField ? { text: asset.text, pinnedField: asset.pinnedField } : { text: asset.text }),
          path1: desired.path1 ?? "",
          path2: desired.path2 ?? "",
        },
        finalUrls: [...desired.finalUrls],
        finalMobileUrls: [...desired.finalMobileUrls],
      };
      const updateMask = "responsive_search_ad.headlines,responsive_search_ad.descriptions,responsive_search_ad.path1,responsive_search_ad.path2,final_urls,final_mobile_urls";
      return this.mutate(customer, "ads:mutate", [{ update, updateMask }], action.resourceName);
    }

    if (action.kind === "REMOVE_CUSTOMIZER_VALUE") {
      const current = await this.getCustomizerValue(customer, {
        scopeKind: action.scopeKind,
        scopeResourceName: action.scopeResourceName,
        attributeResourceName: action.attributeResourceName,
      });
      if (!current) return Object.freeze({ requestId: null, resourceName: action.expected.resourceName, recoveredAlreadyApplied: true });
      if (!same(current, action.expected)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer value changed before rollback");
      const descriptor = this.valueResource(action.scopeKind);
      return this.mutate(customer, descriptor.servicePath, [{ remove: current.resourceName }], current.resourceName);
    }

    const current = await this.getCustomizerValue(customer, {
      scopeKind: action.scopeKind,
      scopeResourceName: action.scopeResourceName,
      attributeResourceName: action.attributeResourceName,
    });
    if (current && current.type === action.type && current.stringValue === action.desiredStringValue) {
      return Object.freeze({ requestId: null, resourceName: current.resourceName, recoveredAlreadyApplied: true });
    }
    if (action.expected === null && current !== null) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer value appeared after synchronization observation");
    if (action.expected !== null && (current === null || !same(current, action.expected))) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer value changed after synchronization observation");
    const descriptor = this.valueResource(action.scopeKind);
    const create = this.createCustomizerPayload(action);
    const operations = current ? [{ remove: current.resourceName }, { create }] : [{ create }];
    return this.mutate(customer, descriptor.servicePath, operations);
  }
}

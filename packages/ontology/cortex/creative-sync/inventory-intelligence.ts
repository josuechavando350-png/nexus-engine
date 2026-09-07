import { createHash } from "node:crypto";
import type {
  CreativeDesiredState,
  CreativeDesiredStateProvider,
  CustomizerAttributeType,
  CustomizerScopeKind,
  DesiredCustomizerValue,
} from "./index";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const CUSTOMER_ID = /^\d{5,20}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type InventoryAvailability = "IN_STOCK" | "OUT_OF_STOCK";

export interface InventoryCreativeItem {
  readonly sku: string;
  readonly availability: InventoryAvailability;
  /** Exact trusted copy/value that should be exposed to Google Ads for this inventory state. */
  readonly creativeValue: string;
}

export interface InventoryCreativeSnapshot {
  readonly customerId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly observedAt: string;
  readonly items: readonly InventoryCreativeItem[];
}

export interface InventoryCreativeProvider {
  getInventory(customerId: string, skus: readonly string[]): Promise<InventoryCreativeSnapshot>;
}

export interface HttpInventoryCreativeProviderConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface InventoryCreativeBinding {
  readonly sku: string;
  readonly attributeName: string;
  readonly type: CustomizerAttributeType;
  readonly scopeKind: CustomizerScopeKind;
  readonly scopeResourceName: string;
}

export interface InventoryCreativePolicy {
  readonly version: 1;
  readonly compositeSourceId: string;
  readonly maxInventoryAgeMs: number;
  readonly allowedInventorySourceIds: readonly string[];
  readonly bindings: readonly InventoryCreativeBinding[];
}

export interface InventoryAwareCreativeDesiredStateProviderOptions {
  readonly desiredState: CreativeDesiredStateProvider;
  readonly inventory: InventoryCreativeProvider;
  readonly policy: InventoryCreativePolicy;
  readonly now?: () => number;
}

export class InventoryIntelligenceError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "STALE_INVENTORY" | "INTEGRITY_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "InventoryIntelligenceError";
  }
}

function identifier(value: unknown, field: string, code: InventoryIntelligenceError["code"] = "INVALID_CONFIG"): string {
  if (typeof value !== "string" || !ID.test(value.trim())) throw new InventoryIntelligenceError(code, `${field} is malformed`);
  return value.trim();
}

function canonicalUtc(value: unknown, field: string, code: InventoryIntelligenceError["code"]): string {
  if (typeof value !== "string") throw new InventoryIntelligenceError(code, `${field} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new InventoryIntelligenceError(code, `${field} must be canonical UTC`);
  return value;
}

function endpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory endpoint is invalid"); }
  if (parsed.protocol !== "https:") throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory endpoint must use https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory endpoint must not contain credentials, query, or fragment");
  return parsed.toString();
}

function token(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory bearer token must contain 32..4096 characters");
  return normalized;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 10_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 60_000) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory timeoutMs must be 1000..60000");
  return resolved;
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new InventoryIntelligenceError("INVALID_RESPONSE", `${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new InventoryIntelligenceError("INVALID_RESPONSE", "inventory response must use application/json");
  if (!response.body) throw new InventoryIntelligenceError("INVALID_RESPONSE", "inventory response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(merged)) as unknown; }
  catch { throw new InventoryIntelligenceError("INVALID_RESPONSE", "inventory response contains malformed JSON"); }
}

function parseSnapshot(value: unknown, expectedCustomerId: string, expectedSkus: readonly string[]): InventoryCreativeSnapshot {
  const raw = plainObject(value, "inventory response");
  const keys = new Set(["customerId", "sourceId", "sourceVersion", "observedAt", "items"]);
  for (const key of Object.keys(raw)) if (!keys.has(key)) throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory response contains unknown field ${key}`);
  if (raw.customerId !== expectedCustomerId) throw new InventoryIntelligenceError("INVALID_RESPONSE", "inventory customerId mismatch");
  const sourceId = identifier(raw.sourceId, "inventory sourceId", "INVALID_RESPONSE");
  const sourceVersion = identifier(raw.sourceVersion, "inventory sourceVersion", "INVALID_RESPONSE");
  const observedAt = canonicalUtc(raw.observedAt, "inventory observedAt", "INVALID_RESPONSE");
  if (!Array.isArray(raw.items) || raw.items.length !== expectedSkus.length) throw new InventoryIntelligenceError("INVALID_RESPONSE", "inventory response must contain exactly one item per requested sku");
  const expected = new Set(expectedSkus);
  const seen = new Set<string>();
  const items = raw.items.map((entry, index): InventoryCreativeItem => {
    const item = plainObject(entry, `inventory items[${index}]`);
    const itemKeys = new Set(["sku", "availability", "creativeValue"]);
    for (const key of Object.keys(item)) if (!itemKeys.has(key)) throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory items[${index}] contains unknown field ${key}`);
    const sku = identifier(item.sku, `inventory items[${index}].sku`, "INVALID_RESPONSE");
    if (!expected.has(sku) || seen.has(sku)) throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory sku ${sku} is unrequested or duplicated`);
    seen.add(sku);
    if (!(item.availability === "IN_STOCK" || item.availability === "OUT_OF_STOCK")) throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory items[${index}].availability is invalid`);
    if (typeof item.creativeValue !== "string" || item.creativeValue.trim().length < 1 || item.creativeValue.trim().length > 500) {
      throw new InventoryIntelligenceError("INVALID_RESPONSE", `inventory items[${index}].creativeValue must contain 1..500 characters for every availability state`);
    }
    return Object.freeze({ sku, availability: item.availability, creativeValue: item.creativeValue.trim() });
  });
  return Object.freeze({ customerId: expectedCustomerId, sourceId, sourceVersion, observedAt, items: Object.freeze(items) });
}

export class HttpInventoryCreativeProvider implements InventoryCreativeProvider {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpInventoryCreativeProviderConfig) {
    this.url = endpoint(config.endpoint);
    this.secret = token(config.bearerToken);
    this.timeoutMs = timeout(config.timeoutMs);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getInventory(customerId: string, skus: readonly string[]): Promise<InventoryCreativeSnapshot> {
    if (!CUSTOMER_ID.test(customerId)) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory customerId is malformed");
    if (!Array.isArray(skus) || skus.length < 1 || skus.length > 5000) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory skus must contain 1..5000 items");
    const normalized = skus.map((sku) => identifier(sku, "inventory sku"));
    if (new Set(normalized).size !== normalized.length) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory skus must be unique");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.secret}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ customerId, skus: normalized }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new InventoryIntelligenceError("TIMEOUT", "inventory request timed out");
      throw new InventoryIntelligenceError("HTTP_ERROR", error instanceof Error ? error.message : "inventory transport failed");
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new InventoryIntelligenceError("HTTP_ERROR", `inventory endpoint returned HTTP ${response.status}`);
    return parseSnapshot(await boundedJson(response), customerId, normalized);
  }
}

function bindingKey(binding: Pick<InventoryCreativeBinding, "scopeKind" | "scopeResourceName" | "attributeName">): string {
  return `${binding.scopeKind}\u0000${binding.scopeResourceName}\u0000${binding.attributeName.toLocaleLowerCase("en-US")}`;
}

export function createInventoryCreativePolicy(input: InventoryCreativePolicy): InventoryCreativePolicy {
  if (input.version !== 1) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory creative policy version must be 1");
  const compositeSourceId = identifier(input.compositeSourceId, "compositeSourceId");
  if (!Number.isSafeInteger(input.maxInventoryAgeMs) || input.maxInventoryAgeMs < 1_000 || input.maxInventoryAgeMs > 86_400_000) throw new InventoryIntelligenceError("INVALID_CONFIG", "maxInventoryAgeMs must be 1000..86400000");
  if (!Array.isArray(input.allowedInventorySourceIds) || input.allowedInventorySourceIds.length < 1 || input.allowedInventorySourceIds.length > 32) throw new InventoryIntelligenceError("INVALID_CONFIG", "allowedInventorySourceIds must contain 1..32 items");
  const allowedInventorySourceIds = input.allowedInventorySourceIds.map((value) => identifier(value, "allowedInventorySourceId"));
  if (new Set(allowedInventorySourceIds).size !== allowedInventorySourceIds.length) throw new InventoryIntelligenceError("INVALID_CONFIG", "allowedInventorySourceIds must be unique");
  if (!Array.isArray(input.bindings) || input.bindings.length < 1 || input.bindings.length > 5000) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory bindings must contain 1..5000 items");
  const bindings = input.bindings.map((binding, index): InventoryCreativeBinding => {
    const sku = identifier(binding.sku, `bindings[${index}].sku`);
    if (typeof binding.attributeName !== "string" || binding.attributeName.trim().length < 1 || binding.attributeName.trim().length > 40) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}].attributeName is invalid`);
    if (!(binding.type === "TEXT" || binding.type === "NUMBER" || binding.type === "PRICE" || binding.type === "PERCENT")) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}].type is invalid`);
    if (!(binding.scopeKind === "CUSTOMER" || binding.scopeKind === "CAMPAIGN" || binding.scopeKind === "AD_GROUP" || binding.scopeKind === "AD_GROUP_CRITERION")) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}].scopeKind is invalid`);
    if (typeof binding.scopeResourceName !== "string" || binding.scopeResourceName.trim().length < 1 || binding.scopeResourceName.trim().length > 256) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}].scopeResourceName is invalid`);
    return Object.freeze({ sku, attributeName: binding.attributeName.trim(), type: binding.type, scopeKind: binding.scopeKind, scopeResourceName: binding.scopeResourceName.trim() });
  });
  const targets = bindings.map(bindingKey);
  if (new Set(targets).size !== targets.length) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory bindings must have unique creative targets");
  return Object.freeze({ version: 1, compositeSourceId, maxInventoryAgeMs: input.maxInventoryAgeMs, allowedInventorySourceIds: Object.freeze(allowedInventorySourceIds), bindings: Object.freeze(bindings) });
}

export class InventoryAwareCreativeDesiredStateProvider implements CreativeDesiredStateProvider {
  readonly policy: InventoryCreativePolicy;
  private readonly now: () => number;

  constructor(private readonly options: InventoryAwareCreativeDesiredStateProviderOptions) {
    this.policy = createInventoryCreativePolicy(options.policy);
    this.now = options.now ?? Date.now;
  }

  async getDesiredState(customerId: string): Promise<CreativeDesiredState> {
    const base = await this.options.desiredState.getDesiredState(customerId);
    const skus = Object.freeze([...new Set(this.policy.bindings.map((binding) => binding.sku))].sort());
    const inventory = await this.options.inventory.getInventory(customerId, skus);
    if (inventory.customerId !== customerId) throw new InventoryIntelligenceError("INTEGRITY_FAILURE", "inventory customerId does not match requested customer");
    if (!this.policy.allowedInventorySourceIds.includes(inventory.sourceId)) throw new InventoryIntelligenceError("INTEGRITY_FAILURE", "inventory source is not allowlisted");
    const inventoryObservedAt = canonicalUtc(inventory.observedAt, "inventory observedAt", "INTEGRITY_FAILURE");
    const inventoryAge = this.now() - Date.parse(inventoryObservedAt);
    if (inventoryAge < 0 || inventoryAge > this.policy.maxInventoryAgeMs) throw new InventoryIntelligenceError("STALE_INVENTORY", "inventory evidence is stale or future-dated");
    const baseObservedAt = canonicalUtc(base.observedAt, "desired-state observedAt", "INTEGRITY_FAILURE");
    const itemBySku = new Map(inventory.items.map((item) => [item.sku, item] as const));
    const attributes = new Map(base.customizerAttributes.map((attribute) => [attribute.name.toLocaleLowerCase("en-US"), attribute] as const));
    const values = new Map(base.customizerValues.map((value) => [bindingKey(value), value] as const));

    for (const binding of this.policy.bindings) {
      const attribute = attributes.get(binding.attributeName.toLocaleLowerCase("en-US"));
      if (!attribute || attribute.type !== binding.type) throw new InventoryIntelligenceError("INTEGRITY_FAILURE", `inventory binding ${binding.attributeName} does not match a declared desired customizer attribute`);
      const item = itemBySku.get(binding.sku);
      if (!item) throw new InventoryIntelligenceError("INTEGRITY_FAILURE", `inventory snapshot is missing sku ${binding.sku}`);
      const next: DesiredCustomizerValue = Object.freeze({
        attributeName: binding.attributeName,
        type: binding.type,
        scopeKind: binding.scopeKind,
        scopeResourceName: binding.scopeResourceName,
        stringValue: item.creativeValue,
      });
      values.set(bindingKey(binding), next);
    }

    const sourceVersion = `sha256:${createHash("sha256").update(JSON.stringify({
      base: { sourceId: base.sourceId, sourceVersion: base.sourceVersion, observedAt: baseObservedAt },
      inventory: { sourceId: inventory.sourceId, sourceVersion: inventory.sourceVersion, observedAt: inventoryObservedAt, items: inventory.items },
      bindings: this.policy.bindings,
    }), "utf8").digest("hex")}`;
    const observedAt = Date.parse(baseObservedAt) <= Date.parse(inventoryObservedAt) ? baseObservedAt : inventoryObservedAt;
    return Object.freeze({
      sourceId: this.policy.compositeSourceId,
      sourceVersion,
      observedAt,
      customizerAttributes: base.customizerAttributes,
      customizerValues: Object.freeze([...values.values()]),
      responsiveSearchAds: base.responsiveSearchAds,
    });
  }
}

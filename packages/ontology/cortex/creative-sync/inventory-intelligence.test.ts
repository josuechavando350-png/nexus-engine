import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  NearRealTimeCreativeSynchronizer,
  createCreativeSyncPolicy,
  type CreativeDesiredState,
  type CreativeDesiredStateProvider,
  type CreativeMutationReceipt,
  type CreativeSyncAction,
  type CustomizerAttributeSnapshot,
  type CustomizerValueSnapshot,
  type GoogleAdsCreativeGateway,
  type ResponsiveSearchAdSnapshot,
} from "./index";
import {
  HttpInventoryCreativeProvider,
  InventoryAwareCreativeDesiredStateProvider,
  InventoryIntelligenceError,
  type InventoryCreativeProvider,
} from "./inventory-intelligence";

const CUSTOMER = "1234567890";
const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const scope = { tenantId: "tenant:inventory", organizationId: "org:inventory" } as const;
const attribute: CustomizerAttributeSnapshot = { name: "StockStatus", type: "TEXT", resourceName: `customers/${CUSTOMER}/customizerAttributes/111`, id: "111", status: "ENABLED" };
const existingValue: CustomizerValueSnapshot = {
  resourceName: `customers/${CUSTOMER}/customizerAttributeValues/222`,
  attributeResourceName: attribute.resourceName,
  type: "TEXT",
  scopeKind: "CAMPAIGN",
  scopeResourceName: `customers/${CUSTOMER}/campaigns/333`,
  stringValue: "Available",
  status: "ENABLED",
};

const desired: CreativeDesiredState = {
  sourceId: "merch-control-v1",
  sourceVersion: "catalog-v7",
  observedAt: new Date(NOW).toISOString(),
  customizerAttributes: [{ name: "StockStatus", type: "TEXT" }],
  customizerValues: [{ attributeName: "StockStatus", type: "TEXT", scopeKind: "CAMPAIGN", scopeResourceName: existingValue.scopeResourceName, stringValue: "Available" }],
  responsiveSearchAds: [],
};

function desiredProvider(): CreativeDesiredStateProvider { return { async getDesiredState() { return desired; } }; }
function inventory(availability: "IN_STOCK" | "OUT_OF_STOCK", creativeValue: string, observedAt = new Date(NOW).toISOString()): InventoryCreativeProvider {
  return { async getInventory(customerId, skus) { return { customerId, sourceId: "inventory-ledger-v1", sourceVersion: "inventory-v9", observedAt, items: skus.map((sku) => ({ sku, availability, creativeValue })) }; } };
}
function inventoryAware(provider: InventoryCreativeProvider) {
  return new InventoryAwareCreativeDesiredStateProvider({
    desiredState: desiredProvider(),
    inventory: provider,
    policy: {
      version: 1,
      compositeSourceId: "merch-inventory-joined-v1",
      maxInventoryAgeMs: 3_600_000,
      allowedInventorySourceIds: ["inventory-ledger-v1"],
      bindings: [{ sku: "sku-0001", attributeName: "StockStatus", type: "TEXT", scopeKind: "CAMPAIGN", scopeResourceName: existingValue.scopeResourceName }],
    },
    now: () => NOW,
  });
}

class Gateway implements GoogleAdsCreativeGateway {
  readonly mutations: CreativeSyncAction[] = [];
  async getCustomizerAttributes(): Promise<readonly CustomizerAttributeSnapshot[]> { return [attribute]; }
  async getCustomizerValue(): Promise<CustomizerValueSnapshot | null> { return existingValue; }
  async getResponsiveSearchAd(): Promise<ResponsiveSearchAdSnapshot | null> { return null; }
  async applyMutation(_customerId: string, action: CreativeSyncAction): Promise<CreativeMutationReceipt> {
    this.mutations.push(action);
    return { requestId: "request-0001", resourceName: existingValue.resourceName, recoveredAlreadyApplied: false };
  }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CORTEX #23 inventory intelligence", () => {
  it("turns a trusted OUT_OF_STOCK inventory value into the real Google Ads customizer mutation", async () => {
    const gateway = new Gateway();
    const engine = new NearRealTimeCreativeSynchronizer(
      new InMemoryOntologyTransactionStore(),
      scope,
      createCreativeSyncPolicy({ policyId: "inventory-sync", version: "v1", maxSourceAgeMs: 3_600_000, maxDesiredResponsiveSearchAds: 100, maxDesiredCustomizerValues: 100, mode: "ACTIVE" }),
      gateway,
      inventoryAware(inventory("OUT_OF_STOCK", "Sold out")),
      () => NOW,
    );
    const result = await engine.synchronize({ runId: "inventory-out-of-stock-0001", customerId: CUSTOMER, mode: "ACTIVE" });
    expect(result.status).toBe("APPLIED");
    expect(gateway.mutations).toHaveLength(1);
    expect(gateway.mutations[0]).toMatchObject({ kind: "UPSERT_CUSTOMIZER_VALUE", desiredStringValue: "Sold out", expected: existingValue });
    expect(result.sourceId).toBe("merch-inventory-joined-v1");
    expect(result.sourceVersion).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("fails closed on stale inventory before any Google Ads read or mutation", async () => {
    const gateway = new Gateway();
    const stale = inventoryAware(inventory("IN_STOCK", "Available", new Date(NOW - 7_200_000).toISOString()));
    const engine = new NearRealTimeCreativeSynchronizer(
      new InMemoryOntologyTransactionStore(), scope,
      createCreativeSyncPolicy({ policyId: "inventory-sync", version: "v1", maxSourceAgeMs: 3_600_000, maxDesiredResponsiveSearchAds: 100, maxDesiredCustomizerValues: 100, mode: "ACTIVE" }),
      gateway, stale, () => NOW,
    );
    await expect(engine.synchronize({ runId: "stale-inventory-0001", customerId: CUSTOMER, mode: "ACTIVE" })).rejects.toBeInstanceOf(InventoryIntelligenceError);
    expect(gateway.mutations).toEqual([]);
  });

  it("keeps the timeout active while streaming the inventory response body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new HttpInventoryCreativeProvider({ endpoint: "https://inventory.example/v1/creative", bearerToken: "i".repeat(32), timeoutMs: 1_000, fetchImpl: fetchMock as unknown as typeof fetch });
    const pending = provider.getInventory(CUSTOMER, ["sku-0001"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires the inventory service to return explicit copy for both stock states", async () => {
    const fetchMock = vi.fn(async () => Response.json({ customerId: CUSTOMER, sourceId: "inventory-ledger-v1", sourceVersion: "v1", observedAt: new Date(NOW).toISOString(), items: [{ sku: "sku-0001", availability: "OUT_OF_STOCK", creativeValue: null }] }));
    const provider = new HttpInventoryCreativeProvider({ endpoint: "https://inventory.example/v1/creative", bearerToken: "i".repeat(32), fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(provider.getInventory(CUSTOMER, ["sku-0001"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects weak or non-HTTPS inventory adapter configuration", () => {
    expect(() => new HttpInventoryCreativeProvider({ endpoint: "http://inventory.example/v1/creative", bearerToken: "i".repeat(32) })).toThrowError(/https/u);
    expect(() => new HttpInventoryCreativeProvider({ endpoint: "https://inventory.example/v1/creative", bearerToken: "short" })).toThrowError(/32\.\.4096/u);
  });
});

import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { GoogleAdsApiError } from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";
import {
  NearRealTimeCreativeSynchronizer,
  createCreativeSyncPolicy,
  type CreativeDesiredState,
  type CreativeDesiredStateProvider,
  type CreativeMutationReceipt,
  type CreativeSyncAction,
  type CustomizerAttributeSnapshot,
  type CustomizerValueSnapshot,
  type DesiredCustomizerValue,
  type GoogleAdsCreativeGateway,
  type ResponsiveSearchAdSnapshot,
} from "./index";

const CUSTOMER = "1234567890";
const NOW = Date.parse("2026-09-05T04:00:00.000Z");
const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });

class Source implements CreativeDesiredStateProvider {
  async getDesiredState(): Promise<CreativeDesiredState> {
    return Object.freeze({
      sourceId: "creative-control-plane",
      sourceVersion: "version-001",
      observedAt: new Date(NOW).toISOString(),
      customizerAttributes: Object.freeze([{ name: "Price", type: "PRICE" as const }]),
      customizerValues: Object.freeze([]),
      responsiveSearchAds: Object.freeze([]),
    });
  }
}

class AmbiguousOnceGateway implements GoogleAdsCreativeGateway {
  mutationCalls = 0;

  async getCustomizerAttributes(): Promise<readonly CustomizerAttributeSnapshot[]> {
    return Object.freeze([]);
  }

  async getCustomizerValue(
    _customerId: string,
    _lookup: Pick<DesiredCustomizerValue, "scopeKind" | "scopeResourceName"> & { readonly attributeResourceName: string },
  ): Promise<CustomizerValueSnapshot | null> {
    return null;
  }

  async getResponsiveSearchAd(): Promise<ResponsiveSearchAdSnapshot | null> {
    return null;
  }

  async applyMutation(_customerId: string, action: CreativeSyncAction): Promise<CreativeMutationReceipt> {
    this.mutationCalls += 1;
    if (this.mutationCalls === 1) {
      throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "synthetic ambiguous forward mutation");
    }
    return Object.freeze({
      requestId: `request-${this.mutationCalls}`,
      resourceName: action.kind === "CREATE_CUSTOMIZER_ATTRIBUTE"
        ? `customers/${CUSTOMER}/customizerAttributes/9000`
        : "unexpected-resource",
      recoveredAlreadyApplied: false,
    });
  }
}

function harness() {
  const gateway = new AmbiguousOnceGateway();
  const engine = new NearRealTimeCreativeSynchronizer(
    new InMemoryOntologyTransactionStore(),
    scope,
    createCreativeSyncPolicy({
      policyId: "creative-sync",
      version: "v1",
      maxSourceAgeMs: 300_000,
      maxDesiredResponsiveSearchAds: 100,
      maxDesiredCustomizerValues: 500,
      maxWriteRetries: 3,
      mode: "ACTIVE",
    }),
    gateway,
    new Source(),
    () => NOW,
  );
  return { engine, gateway };
}

async function leaveForwardPrepared(h: ReturnType<typeof harness>): Promise<void> {
  await expect(h.engine.synchronize({ runId: "forward-prepared", customerId: CUSTOMER })).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
  expect(h.gateway.mutationCalls).toBe(1);
}

describe("creative-sync rollback safety", () => {
  it("refuses to execute an existing forward PREPARED run through rollback", async () => {
    const h = harness();
    await leaveForwardPrepared(h);
    await expect(h.engine.rollbackLastMutation({ runId: "forward-prepared", customerId: CUSTOMER })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.gateway.mutationCalls).toBe(1);
  });

  it("refuses to execute the state's forward in-flight run through a new rollback id", async () => {
    const h = harness();
    await leaveForwardPrepared(h);
    await expect(h.engine.rollbackLastMutation({ runId: "rollback-new", customerId: CUSTOMER })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.gateway.mutationCalls).toBe(1);
  });
});

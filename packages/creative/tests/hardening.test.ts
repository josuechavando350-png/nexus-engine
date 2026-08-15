import { describe, expect, it } from "vitest";
import { AppendOnlyMemoryService, DeterministicMemoryRetriever, type ArtDirectionMemoryRecord, type MemoryStore } from "../memory";
import { CreativeVault, type AssetDigest, type AssetResolutionRequest, type CreativeAssetManifest, type DigestVerifier, type VaultReader } from "../vault";
import { InMemoryMemoryStore, InMemoryVault } from "../testing";

const scope = { tenantId: "tenant-a", brandId: "brand-a" } as const;
const SOURCE = `sha256:${"1".repeat(64)}` as AssetDigest;
const GOOD = `sha256:${"2".repeat(64)}` as AssetDigest;
const PARAMS = `sha256:${"4".repeat(64)}` as AssetDigest;
const bytes = new Uint8Array([1, 2, 3]);

function memoryRecord(overrides: Partial<ArtDirectionMemoryRecord> = {}): ArtDirectionMemoryRecord {
  return {
    schemaVersion: 1,
    recordId: "record-1",
    scope,
    subjectId: "homepage",
    createdAt: "2026-08-15T00:00:00.000Z",
    validFrom: "2026-08-15T00:00:00.000Z",
    validUntil: "2026-09-15T00:00:00.000Z",
    confidence: 0.8,
    keywords: ["editorial"],
    provenance: { sourceId: "designer-1", sourceType: "HUMAN", capturedAt: "2026-08-15T00:00:00.000Z", evidenceIds: ["evidence-1"] },
    payload: { kind: "OBSERVATION", statement: "Editorial pacing." },
    ...overrides
  };
}

function manifest(): CreativeAssetManifest {
  return {
    schemaVersion: 2,
    assetId: "asset-hero",
    version: "1.0.0",
    digest: SOURCE,
    scope,
    provenance: { source: "fixture", capturedAt: "2026-08-15T00:00:00.000Z" },
    usage: [{ licenseId: "license-1", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z", allowedPurposes: ["hero"], allowedRegions: ["MX"] }],
    variants: [{
      variantId: "hero-avif",
      digest: GOOD,
      codec: "avif",
      mediaType: "image/avif",
      byteLength: bytes.byteLength,
      purposes: ["hero"],
      priority: 0,
      lineage: [{ sourceDigest: SOURCE, operation: "encode", tool: "fixture", toolVersion: "1", parametersDigest: PARAMS }]
    }]
  };
}

function request(overrides: Partial<AssetResolutionRequest> = {}): AssetResolutionRequest {
  return {
    scope,
    assetId: "asset-hero",
    version: "1.0.0",
    purpose: "hero",
    supportedCodecs: ["avif"],
    region: "MX",
    at: "2026-08-15T00:00:00.000Z",
    correlationId: "corr-1",
    inputsDigest: "inputs-1",
    ...overrides
  };
}

describe("V8 Vault/Memory hardening", () => {
  it("rejects missing runtime canonical IDs instead of coercing undefined", async () => {
    const retriever = new DeterministicMemoryRetriever(new InMemoryMemoryStore());
    await expect(retriever.retrieve({ ...request(), keywords: [], minimumConfidence: 0, limit: 1, subjectId: "homepage", correlationId: undefined } as unknown as Parameters<typeof retriever.retrieve>[0])).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  it("stores an immutable defensive memory copy", async () => {
    const store = new InMemoryMemoryStore();
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    const keywords = ["editorial"];
    const evidenceIds = ["evidence-1"];
    const item = memoryRecord({ keywords, provenance: { sourceId: "designer-1", sourceType: "HUMAN", capturedAt: "2026-08-15T00:00:00.000Z", evidenceIds } });
    await service.append(item);
    keywords[0] = "mutated";
    evidenceIds[0] = "mutated";
    const stored = await store.get(scope, "record-1");
    expect(stored?.keywords).toEqual(["editorial"]);
    expect(stored?.provenance.evidenceIds).toEqual(["evidence-1"]);
    expect(Object.isFrozen(stored?.keywords)).toBe(true);
    expect(Object.isFrozen(stored?.provenance)).toBe(true);
  });

  it("treats semantically identical reordered records as duplicates", async () => {
    const store = new InMemoryMemoryStore();
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    await service.append(memoryRecord({ payload: { kind: "OBSERVATION", statement: "same" } }));
    const reorderedPayload = { statement: "same", kind: "OBSERVATION" } as const;
    await expect(service.append(memoryRecord({ payload: reorderedPayload }))).rejects.toMatchObject({ code: "DUPLICATE_ID" });
  });

  it("maps malformed backend memory records to a typed validation error", async () => {
    const hostile: MemoryStore = {
      async append() {},
      async get() { return undefined; },
      async list() { return [{ ...memoryRecord(), scope: undefined } as unknown as ArtDirectionMemoryRecord]; }
    };
    const retriever = new DeterministicMemoryRetriever(hostile);
    await expect(retriever.retrieve({ scope, subjectId: "homepage", keywords: ["editorial"], at: "2026-08-20T00:00:00.000Z", minimumConfidence: 0, limit: 1, correlationId: "corr-1", inputsDigest: "inputs-1" })).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  it("rejects invalid vault version and variant IDs before backend access", async () => {
    const reader: VaultReader = {
      async readManifest() { throw new Error("must not run"); },
      async listVersions() { throw new Error("must not run"); },
      async readVariant() { throw new Error("must not run"); }
    };
    const verifier: DigestVerifier = { async digest() { return GOOD; } };
    const vault = new CreativeVault(reader, verifier);
    await expect(vault.resolve(request({ version: "" }))).rejects.toMatchObject({ code: "INVALID_METADATA" });
    await expect(vault.resolve(request({ variantId: " bad id " }))).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });

  it("maps digest verifier exceptions to typed storage failure evidence", async () => {
    const store = new InMemoryVault();
    const current = manifest();
    await store.appendManifest(current);
    const identity = { assetId: current.assetId, version: current.version, digest: GOOD, variantId: "hero-avif" } as const;
    await store.writeVariant(scope, identity, bytes);
    const verifier: DigestVerifier = { async digest() { throw new Error("verifier unavailable"); } };
    await expect(new CreativeVault(store, verifier).resolve(request())).rejects.toMatchObject({ code: "STORAGE_OUTAGE" });
  });

  it("returns a defensive copy of resolved vault bytes", async () => {
    const store = new InMemoryVault();
    const current = manifest();
    await store.appendManifest(current);
    const identity = { assetId: current.assetId, version: current.version, digest: GOOD, variantId: "hero-avif" } as const;
    await store.writeVariant(scope, identity, bytes);
    const verifier: DigestVerifier = { async digest() { return GOOD; } };
    const resolved = await new CreativeVault(store, verifier).resolve(request());
    resolved.bytes[0] = 99;
    const persisted = await store.readVariant(scope, identity);
    expect(persisted?.[0]).toBe(1);
  });
});

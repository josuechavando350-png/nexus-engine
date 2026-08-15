import { describe, expect, it } from "vitest";
import { InMemoryEvidenceSink, InMemoryVault, StaticDigestVerifier } from "../testing";
import {
  CreativeVault,
  VaultError,
  assetIdentity,
  migrateManifest,
  validateManifest,
  type AssetResolutionRequest,
  type AssetVariant,
  type CreativeAssetManifest,
  type CreativeAssetManifestV1,
  type VaultReader
} from "../vault";

const SOURCE = `sha256:${"1".repeat(64)}` as const;
const GOOD = `sha256:${"2".repeat(64)}` as const;
const BAD = `sha256:${"3".repeat(64)}` as const;
const PARAMS = `sha256:${"4".repeat(64)}` as const;
const scope = { tenantId: "tenant-a", brandId: "brand-a" } as const;
const bytes = new Uint8Array([1, 2, 3]);

function variant(overrides: Partial<AssetVariant> = {}): AssetVariant {
  return {
    variantId: "hero-avif",
    digest: GOOD,
    codec: "avif",
    mediaType: "image/avif",
    byteLength: bytes.byteLength,
    purposes: ["hero"],
    priority: 0,
    lineage: [{ sourceDigest: SOURCE, operation: "encode", tool: "fixture", toolVersion: "1", parametersDigest: PARAMS }],
    ...overrides
  };
}

function manifest(overrides: Partial<CreativeAssetManifest> = {}): CreativeAssetManifest {
  return {
    schemaVersion: 2,
    assetId: "asset-hero",
    version: "1.0.0",
    digest: SOURCE,
    scope,
    provenance: { source: "fixture", capturedAt: "2026-08-15T00:00:00.000Z" },
    usage: [{ licenseId: "license-1", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z", allowedPurposes: ["hero"], allowedRegions: ["MX"] }],
    variants: [variant()],
    ...overrides
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

async function prepared(currentManifest = manifest(), verifierDigest = GOOD) {
  const store = new InMemoryVault();
  await store.appendManifest(currentManifest);
  for (const current of currentManifest.variants) {
    if (current.digest === verifierDigest) await store.writeVariant(currentManifest.scope, assetIdentity(currentManifest, current), bytes);
  }
  return { store, vault: new CreativeVault(store, new StaticDigestVerifier(verifierDigest)) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("CreativeVault", () => {
  it("resolves and verifies a declared immutable variant", async () => {
    const { vault } = await prepared();
    const resolved = await vault.resolve(request());
    expect(resolved.identity).toEqual({ assetId: "asset-hero", version: "1.0.0", digest: GOOD, variantId: "hero-avif" });
    expect(resolved.fallbackPath).toEqual(["hero-avif"]);
    expect(resolved.evidence.at(-1)?.kind).toBe("ASSET_RESOLUTION");
  });

  it("uses a deterministic lexical tie break", async () => {
    const a = variant({ variantId: "a", priority: 1 });
    const b = variant({ variantId: "b", priority: 1 });
    const current = manifest({ variants: [b, a] });
    const store = new InMemoryVault();
    await store.appendManifest(current);
    await store.writeVariant(scope, assetIdentity(current, a), bytes);
    const resolved = await new CreativeVault(store, new StaticDigestVerifier(GOOD)).resolve(request());
    expect(resolved.variant.variantId).toBe("a");
  });

  it("selects only declared fallbacks and emits the path", async () => {
    const fallback = variant({ variantId: "fallback", priority: 1, purposes: ["fallback"] });
    const preferred = variant({ variantId: "preferred", codec: "unsupported", fallbackVariantId: "fallback", priority: 0 });
    const current = manifest({ variants: [preferred, fallback] });
    const store = new InMemoryVault();
    await store.appendManifest(current);
    await store.writeVariant(scope, assetIdentity(current, fallback), bytes);
    const resolved = await new CreativeVault(store, new StaticDigestVerifier(GOOD)).resolve(request());
    expect(resolved.fallbackPath).toEqual(["preferred", "fallback"]);
    expect(resolved.evidence.some((event) => event.kind === "FALLBACK_SELECTION")).toBe(true);
  });

  it("rejects fallback cycles", async () => {
    const a = variant({ variantId: "a", codec: "bad", fallbackVariantId: "b" });
    const b = variant({ variantId: "b", codec: "bad", fallbackVariantId: "a" });
    const { vault } = await prepared(manifest({ variants: [a, b] }));
    await expectCode(vault.resolve(request()), "FALLBACK_CYCLE");
  });

  it("rejects an incorrect digest and records evidence", async () => {
    const current = manifest();
    const store = new InMemoryVault();
    const sink = new InMemoryEvidenceSink();
    await store.appendManifest(current);
    await store.writeVariant(scope, assetIdentity(current, current.variants[0]!), bytes);
    const vault = new CreativeVault(store, new StaticDigestVerifier(BAD), sink);
    await expectCode(vault.resolve(request()), "DIGEST_MISMATCH");
    expect(sink.events.some((event) => event.kind === "DIGEST_FAILURE")).toBe(true);
  });

  it("rejects bytes whose declared size is corrupt", async () => {
    const current = manifest({ variants: [variant({ byteLength: 99 })] });
    const store = new InMemoryVault();
    await store.appendManifest(current);
    await store.writeVariant(scope, assetIdentity(current, current.variants[0]!), bytes);
    await expectCode(new CreativeVault(store, new StaticDigestVerifier(GOOD)).resolve(request()), "DIGEST_MISMATCH");
  });

  it("distinguishes missing asset from missing version", async () => {
    const store = new InMemoryVault();
    const vault = new CreativeVault(store, new StaticDigestVerifier(GOOD));
    await expectCode(vault.resolve(request()), "ASSET_NOT_FOUND");
    await store.appendManifest(manifest());
    await expectCode(vault.resolve(request({ version: "2.0.0" })), "VERSION_NOT_FOUND");
  });

  it("classifies expired rights only for otherwise relevant constraints", async () => {
    const expired = manifest({ usage: [{ licenseId: "license-1", validFrom: "2025-01-01T00:00:00.000Z", validUntil: "2025-12-31T00:00:00.000Z", allowedPurposes: ["hero"], allowedRegions: ["MX"] }] });
    const { vault } = await prepared(expired);
    await expectCode(vault.resolve(request()), "RIGHTS_EXPIRED");
    await expectCode(vault.resolve(request({ region: "US" })), "USAGE_NOT_ALLOWED");
  });

  it("rejects unsupported codecs and incompatible purposes explicitly", async () => {
    const { vault } = await prepared();
    await expectCode(vault.resolve(request({ supportedCodecs: ["webp"] })), "CODEC_UNSUPPORTED");
    await expectCode(vault.resolve(request({ purpose: "product" })), "USAGE_NOT_ALLOWED");
  });

  it("forbids latest as an identity version", async () => {
    const { vault } = await prepared();
    await expectCode(vault.resolve(request({ version: "latest" })), "INVALID_METADATA");
  });

  it("fails typed on storage outage and evidence sink failure does not mask it", async () => {
    const store = new InMemoryVault();
    store.failReads = true;
    const sink = new InMemoryEvidenceSink();
    sink.fail = true;
    const vault = new CreativeVault(store, new StaticDigestVerifier(GOOD), sink);
    await expectCode(vault.resolve(request()), "STORAGE_OUTAGE");
  });

  it("rejects a manifest returned from a different scope", async () => {
    const wrong = manifest({ scope: { tenantId: "tenant-b", brandId: "brand-b" } });
    const reader: VaultReader = {
      async readManifest() { return wrong; },
      async listVersions() { return [wrong.version]; },
      async readVariant() { return bytes; }
    };
    await expectCode(new CreativeVault(reader, new StaticDigestVerifier(GOOD)).resolve(request()), "SCOPE_MISMATCH");
  });

  it("migrates V1 manifests into the scoped V2 contract", () => {
    const v1: CreativeAssetManifestV1 = {
      schemaVersion: 1,
      assetId: "asset-hero",
      version: "1.0.0",
      digest: SOURCE,
      tenantId: "tenant-a",
      brandId: "brand-a",
      source: "fixture",
      capturedAt: "2026-08-15T00:00:00.000Z",
      usage: manifest().usage,
      variants: manifest().variants
    };
    expect(migrateManifest(v1).scope).toEqual(scope);
  });

  it("requires every transformation lineage to anchor to manifest.digest", () => {
    const broken = manifest({ variants: [variant({ lineage: [{ sourceDigest: BAD, operation: "encode", tool: "fixture", toolVersion: "1", parametersDigest: PARAMS }] })] });
    expect(() => validateManifest(broken)).toThrowError(VaultError);
  });

  it("rejects non-canonical timestamps instead of relying on Date.parse heuristics", () => {
    expect(() => validateManifest(manifest({ provenance: { source: "fixture", capturedAt: "2026-08-15" } }))).toThrowError(VaultError);
  });
});

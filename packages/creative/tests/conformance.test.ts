import { describe, expect, it } from "vitest";
import { CreativeVault, type AssetDigest, type CreativeAssetManifest, type DigestVerifier, type VaultReader } from "../vault";
import { DeterministicMemoryRetriever, type ArtDirectionMemoryRecord, type MemoryStore } from "../memory";

const scope = { tenantId: "tenant-a", brandId: "brand-a" } as const;
const source = `sha256:${"a".repeat(64)}` as AssetDigest;
const digest = `sha256:${"b".repeat(64)}` as AssetDigest;
const bytes = new Uint8Array([7]);

const manifest: CreativeAssetManifest = {
  schemaVersion: 2,
  assetId: "asset-1",
  version: "1",
  digest: source,
  scope,
  provenance: { source: "fixture", capturedAt: "2026-08-15T00:00:00.000Z" },
  usage: [{ licenseId: "l1", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z", allowedPurposes: ["hero"] }],
  variants: [{ variantId: "v1", digest, codec: "avif", mediaType: "image/avif", byteLength: 1, purposes: ["hero"], priority: 0, lineage: [{ sourceDigest: source, operation: "encode", tool: "fixture", toolVersion: "1", parametersDigest: source }] }]
};

const memoryRecord: ArtDirectionMemoryRecord = {
  schemaVersion: 1,
  recordId: "memory-1",
  scope,
  subjectId: "homepage",
  createdAt: "2026-08-15T00:00:00.000Z",
  validFrom: "2026-08-15T00:00:00.000Z",
  validUntil: "2026-09-15T00:00:00.000Z",
  confidence: 0.9,
  keywords: ["editorial"],
  provenance: { sourceId: "human-1", sourceType: "HUMAN", capturedAt: "2026-08-15T00:00:00.000Z", evidenceIds: ["e1"] },
  payload: { kind: "OBSERVATION", statement: "Editorial hierarchy worked." }
};

describe("replaceable creative ports", () => {
  it("runs Vault against an arbitrary structural adapter", async () => {
    const reader: VaultReader = {
      async readManifest() { return manifest; },
      async listVersions() { return ["1"]; },
      async readVariant() { return bytes; }
    };
    const verifier: DigestVerifier = { async digest() { return digest; } };
    const result = await new CreativeVault(reader, verifier).resolve({ scope, assetId: "asset-1", version: "1", purpose: "hero", supportedCodecs: ["avif"], at: "2026-08-20T00:00:00.000Z", correlationId: "corr-1", inputsDigest: "inputs-1" });
    expect(result.variant.variantId).toBe("v1");
  });

  it("runs Memory retrieval against an arbitrary structural adapter", async () => {
    const store: MemoryStore = {
      async append() {},
      async get() { return undefined; },
      async list() { return [memoryRecord]; }
    };
    const result = await new DeterministicMemoryRetriever(store).retrieve({ scope, subjectId: "homepage", keywords: ["editorial"], at: "2026-08-20T00:00:00.000Z", minimumConfidence: 0.5, limit: 5, correlationId: "corr-1", inputsDigest: "inputs-1" });
    expect(result.results).toHaveLength(1);
    expect(result.authority).toBe("EVIDENCE_ONLY");
  });
});

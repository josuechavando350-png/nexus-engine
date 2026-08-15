import { createEvidence, deliverEvidence, NullCreativeEvidenceSink, type CreativeEvidence, type CreativeEvidenceSink } from "../evidence";
import { assertCanonicalId, assertNonEmpty, assertScope, canonicalTimestamp, CreativeValidationError, lexicalCompare, type CreativeScope } from "../shared";

export type AssetDigest = `sha256:${string}`;
export type AssetPurpose = "hero" | "editorial" | "product" | "thumbnail" | "fallback" | "archive";

export type TransformationLineage = Readonly<{
  sourceDigest: AssetDigest;
  operation: string;
  tool: string;
  toolVersion: string;
  parametersDigest: AssetDigest;
}>;

export type UsageConstraint = Readonly<{
  licenseId: string;
  validFrom: string;
  validUntil?: string;
  allowedPurposes: readonly AssetPurpose[];
  allowedRegions?: readonly string[];
  attribution?: string;
}>;

export type AssetVariant = Readonly<{
  variantId: string;
  digest: AssetDigest;
  codec: string;
  mediaType: string;
  byteLength: number;
  width?: number;
  height?: number;
  purposes: readonly AssetPurpose[];
  priority: number;
  fallbackVariantId?: string;
  lineage: readonly TransformationLineage[];
}>;

export type CreativeAssetManifest = Readonly<{
  schemaVersion: 2;
  assetId: string;
  version: string;
  /** SHA-256 of the immutable source asset bytes; every variant lineage must anchor to it. */
  digest: AssetDigest;
  scope: CreativeScope;
  provenance: Readonly<{ source: string; capturedAt: string; creator?: string }>;
  usage: readonly UsageConstraint[];
  variants: readonly AssetVariant[];
}>;

export type CreativeAssetManifestV1 = Readonly<{
  schemaVersion: 1;
  assetId: string;
  version: string;
  digest: AssetDigest;
  tenantId: string;
  brandId: string;
  source: string;
  capturedAt: string;
  usage: readonly UsageConstraint[];
  variants: readonly AssetVariant[];
}>;

export type AssetIdentity = Readonly<{
  assetId: string;
  version: string;
  digest: AssetDigest;
  variantId: string;
}>;

export type VaultErrorCode =
  | "INVALID_METADATA"
  | "ASSET_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "VARIANT_INCOMPATIBLE"
  | "CODEC_UNSUPPORTED"
  | "RIGHTS_EXPIRED"
  | "USAGE_NOT_ALLOWED"
  | "FALLBACK_CYCLE"
  | "STORAGE_OUTAGE"
  | "DIGEST_MISMATCH"
  | "SCOPE_MISMATCH";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string, readonly details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultReader {
  readManifest(scope: CreativeScope, assetId: string, version: string): Promise<CreativeAssetManifest | undefined>;
  listVersions(scope: CreativeScope, assetId: string): Promise<readonly string[]>;
  readVariant(scope: CreativeScope, identity: AssetIdentity): Promise<Uint8Array | undefined>;
}

export interface VaultWriter {
  appendManifest(manifest: CreativeAssetManifest): Promise<void>;
  writeVariant(scope: CreativeScope, identity: AssetIdentity, bytes: Uint8Array): Promise<void>;
}

export interface DigestVerifier {
  digest(bytes: Uint8Array): Promise<AssetDigest>;
}

export type AssetResolutionRequest = Readonly<{
  scope: CreativeScope;
  assetId: string;
  version: string;
  variantId?: string;
  purpose: AssetPurpose;
  supportedCodecs: readonly string[];
  region?: string;
  at: string;
  correlationId: string;
  inputsDigest: string;
}>;

export type ResolvedAsset = Readonly<{
  identity: AssetIdentity;
  manifest: CreativeAssetManifest;
  variant: AssetVariant;
  bytes: Uint8Array;
  fallbackPath: readonly string[];
  evidence: readonly CreativeEvidence[];
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function time(value: string, field: string): number {
  try {
    return canonicalTimestamp(value, field);
  } catch (error) {
    if (error instanceof CreativeValidationError) throw new VaultError("INVALID_METADATA", error.message);
    throw error;
  }
}

export function assetIdentity(manifest: CreativeAssetManifest, variant: AssetVariant): AssetIdentity {
  return Object.freeze({ assetId: manifest.assetId, version: manifest.version, digest: variant.digest, variantId: variant.variantId });
}

export function validateManifest(manifest: CreativeAssetManifest): CreativeAssetManifest {
  try {
    assertScope(manifest.scope);
    assertNonEmpty(manifest.assetId, "assetId");
    assertCanonicalId(manifest.assetId, "assetId");
    assertNonEmpty(manifest.version, "version");
    assertNonEmpty(manifest.provenance.source, "provenance.source");
  } catch (error) {
    if (error instanceof CreativeValidationError) throw new VaultError("INVALID_METADATA", error.message);
    throw error;
  }
  if (manifest.version.trim().toLowerCase() === "latest") throw new VaultError("INVALID_METADATA", 'version "latest" is forbidden');
  if (!DIGEST.test(manifest.digest)) throw new VaultError("INVALID_METADATA", "manifest digest must be canonical sha256");
  time(manifest.provenance.capturedAt, "provenance.capturedAt");
  if (!manifest.usage.length) throw new VaultError("INVALID_METADATA", "at least one usage constraint is required");
  if (!manifest.variants.length) throw new VaultError("INVALID_METADATA", "at least one variant is required");

  for (const constraint of manifest.usage) {
    assertNonEmpty(constraint.licenseId, "usage.licenseId");
    const start = time(constraint.validFrom, "usage.validFrom");
    const end = constraint.validUntil ? time(constraint.validUntil, "usage.validUntil") : Infinity;
    if (start > end) throw new VaultError("INVALID_METADATA", "usage validity interval is invalid");
    if (!constraint.allowedPurposes.length) throw new VaultError("INVALID_METADATA", "usage allowedPurposes must not be empty");
  }

  const ids = new Set<string>();
  for (const variant of manifest.variants) {
    try {
      assertCanonicalId(variant.variantId, "variant.variantId");
    } catch (error) {
      if (error instanceof CreativeValidationError) throw new VaultError("INVALID_METADATA", error.message);
      throw error;
    }
    if (ids.has(variant.variantId)) throw new VaultError("INVALID_METADATA", "variant ids must be unique");
    ids.add(variant.variantId);
    if (!DIGEST.test(variant.digest) || !Number.isInteger(variant.byteLength) || variant.byteLength < 0 || !Number.isFinite(variant.priority) || !variant.lineage.length) {
      throw new VaultError("INVALID_METADATA", `variant ${variant.variantId} has invalid digest, size, priority, or provenance lineage`);
    }
    if (!variant.codec.trim() || !variant.mediaType.trim() || !variant.purposes.length) throw new VaultError("INVALID_METADATA", `variant ${variant.variantId} has incomplete compatibility metadata`);
    for (const lineage of variant.lineage) {
      if (!DIGEST.test(lineage.sourceDigest) || !DIGEST.test(lineage.parametersDigest) || !lineage.operation || !lineage.tool || !lineage.toolVersion) {
        throw new VaultError("INVALID_METADATA", `variant ${variant.variantId} has invalid transformation lineage`);
      }
      if (lineage.sourceDigest !== manifest.digest) throw new VaultError("INVALID_METADATA", `variant ${variant.variantId} lineage must anchor to manifest digest`);
    }
  }
  for (const variant of manifest.variants) {
    if (variant.fallbackVariantId && !ids.has(variant.fallbackVariantId)) throw new VaultError("INVALID_METADATA", `missing fallback ${variant.fallbackVariantId}`);
  }
  return Object.freeze(manifest);
}

export function migrateManifest(input: CreativeAssetManifest | CreativeAssetManifestV1): CreativeAssetManifest {
  if (input.schemaVersion === 2) return validateManifest(input);
  return validateManifest({
    schemaVersion: 2,
    assetId: input.assetId,
    version: input.version,
    digest: input.digest,
    scope: { tenantId: input.tenantId, brandId: input.brandId },
    provenance: { source: input.source, capturedAt: input.capturedAt },
    usage: input.usage,
    variants: input.variants
  });
}

function checkUsage(manifest: CreativeAssetManifest, request: AssetResolutionRequest): void {
  const at = time(request.at, "request.at");
  const relevant = manifest.usage.filter(
    (constraint) =>
      constraint.allowedPurposes.includes(request.purpose) &&
      (!constraint.allowedRegions || (!!request.region && constraint.allowedRegions.includes(request.region)))
  );
  const applicable = relevant.filter((constraint) => {
    const starts = time(constraint.validFrom, "usage.validFrom");
    const ends = constraint.validUntil ? time(constraint.validUntil, "usage.validUntil") : Infinity;
    return at >= starts && at <= ends;
  });
  if (applicable.length) return;
  const expired = relevant.length > 0 && relevant.every((constraint) => constraint.validUntil && at > time(constraint.validUntil, "usage.validUntil"));
  throw new VaultError(expired ? "RIGHTS_EXPIRED" : "USAGE_NOT_ALLOWED", expired ? "asset rights expired" : "asset usage is not allowed");
}

function compatible(variant: AssetVariant, request: AssetResolutionRequest): VaultErrorCode | undefined {
  if (!request.supportedCodecs.includes(variant.codec)) return "CODEC_UNSUPPORTED";
  if (!variant.purposes.includes(request.purpose) && !variant.purposes.includes("fallback")) return "VARIANT_INCOMPATIBLE";
  return undefined;
}

export class CreativeVault {
  constructor(
    private readonly reader: VaultReader,
    private readonly verifier: DigestVerifier,
    private readonly evidenceSink: CreativeEvidenceSink = new NullCreativeEvidenceSink()
  ) {}

  async resolve(request: AssetResolutionRequest): Promise<ResolvedAsset> {
    try {
      assertScope(request.scope);
      assertCanonicalId(request.assetId, "request.assetId");
      assertCanonicalId(request.correlationId, "request.correlationId");
      assertNonEmpty(request.inputsDigest, "request.inputsDigest");
      time(request.at, "request.at");
    } catch (error) {
      if (error instanceof CreativeValidationError) throw new VaultError("INVALID_METADATA", error.message);
      throw error;
    }
    if (request.version.trim().toLowerCase() === "latest") throw new VaultError("INVALID_METADATA", 'version "latest" is forbidden');
    if (!request.supportedCodecs.length || request.supportedCodecs.some((codec) => !codec.trim())) throw new VaultError("INVALID_METADATA", "supportedCodecs must contain canonical non-empty values");

    let manifest: CreativeAssetManifest | undefined;
    try {
      manifest = await this.reader.readManifest(request.scope, request.assetId, request.version);
    } catch {
      await this.emit(request, "BACKEND_FAILURE", request.assetId, { operation: "readManifest" });
      throw new VaultError("STORAGE_OUTAGE", "vault manifest backend unavailable");
    }
    if (!manifest) {
      let versions: readonly string[];
      try {
        versions = await this.reader.listVersions(request.scope, request.assetId);
      } catch {
        await this.emit(request, "BACKEND_FAILURE", request.assetId, { operation: "listVersions" });
        throw new VaultError("STORAGE_OUTAGE", "vault manifest backend unavailable");
      }
      throw new VaultError(versions.length ? "VERSION_NOT_FOUND" : "ASSET_NOT_FOUND", versions.length ? `version ${request.version} not found` : `asset ${request.assetId} not found`);
    }
    validateManifest(manifest);
    if (manifest.version !== request.version) throw new VaultError("VERSION_NOT_FOUND", `version ${request.version} not found`);
    if (manifest.assetId !== request.assetId) throw new VaultError("ASSET_NOT_FOUND", `asset ${request.assetId} not found`);
    if (manifest.scope.tenantId !== request.scope.tenantId || manifest.scope.brandId !== request.scope.brandId) {
      await this.emit(request, "SCOPE_REJECTION", request.assetId, { manifestTenant: manifest.scope.tenantId, manifestBrand: manifest.scope.brandId });
      throw new VaultError("SCOPE_MISMATCH", "asset scope does not match request scope");
    }
    try {
      checkUsage(manifest, request);
    } catch (error) {
      await this.emit(request, "USAGE_REJECTION", request.assetId, { code: error instanceof VaultError ? error.code : "INVALID_METADATA" });
      throw error;
    }

    const byId = new Map(manifest.variants.map((variant) => [variant.variantId, variant]));
    let current = request.variantId
      ? byId.get(request.variantId)
      : [...manifest.variants].sort((a, b) => a.priority - b.priority || lexicalCompare(a.variantId, b.variantId))[0];
    if (!current) throw new VaultError("VARIANT_INCOMPATIBLE", "requested variant does not exist");

    const visited = new Set<string>();
    const fallbackPath: string[] = [];
    let incompatibility: VaultErrorCode | undefined;
    while ((incompatibility = compatible(current, request))) {
      if (visited.has(current.variantId)) throw new VaultError("FALLBACK_CYCLE", "asset fallback cycle detected");
      visited.add(current.variantId);
      if (!current.fallbackVariantId) throw new VaultError(incompatibility, `variant ${current.variantId} is incompatible`);
      fallbackPath.push(current.variantId);
      const next = byId.get(current.fallbackVariantId);
      if (!next) throw new VaultError("VARIANT_INCOMPATIBLE", `fallback ${current.fallbackVariantId} is missing`);
      current = next;
    }
    if (visited.has(current.variantId)) throw new VaultError("FALLBACK_CYCLE", "asset fallback cycle detected");
    fallbackPath.push(current.variantId);

    const identity = assetIdentity(manifest, current);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.reader.readVariant(request.scope, identity);
    } catch {
      await this.emit(request, "BACKEND_FAILURE", current.variantId, { operation: "readVariant" });
      throw new VaultError("STORAGE_OUTAGE", "vault bytes backend unavailable");
    }
    if (!bytes) throw new VaultError("ASSET_NOT_FOUND", `variant ${current.variantId} bytes not found`);
    if (bytes.byteLength !== current.byteLength) throw new VaultError("DIGEST_MISMATCH", "asset byte length does not match manifest", { expected: String(current.byteLength), actual: String(bytes.byteLength) });
    const actual = await this.verifier.digest(bytes);
    if (actual !== current.digest) {
      await this.emit(request, "DIGEST_FAILURE", current.variantId, { expected: current.digest, actual });
      throw new VaultError("DIGEST_MISMATCH", "asset digest verification failed", { expected: current.digest, actual });
    }

    const evidence: CreativeEvidence[] = [];
    if (fallbackPath.length > 1) evidence.push(await this.emit(request, "FALLBACK_SELECTION", current.variantId, { path: fallbackPath.join("->") }));
    evidence.push(await this.emit(request, "ASSET_RESOLUTION", current.variantId, { identity: `${identity.assetId}@${identity.version}:${identity.digest}:${identity.variantId}` }));
    return Object.freeze({ identity, manifest, variant: current, bytes, fallbackPath: Object.freeze([...fallbackPath]), evidence: Object.freeze(evidence) });
  }

  private async emit(request: AssetResolutionRequest, kind: CreativeEvidence["kind"], subjectId: string, details: CreativeEvidence["details"]): Promise<CreativeEvidence> {
    const event = createEvidence({
      kind,
      occurredAt: request.at,
      correlationId: request.correlationId,
      scope: request.scope,
      subjectId,
      inputsDigest: request.inputsDigest,
      details
    });
    return deliverEvidence(this.evidenceSink, event);
  }
}

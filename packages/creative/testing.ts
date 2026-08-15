import type { CreativeEvidence, CreativeEvidenceSink } from "./evidence";
import type { GalleryEntry, GalleryStore } from "./gallery";
import type { ArtDirectionMemoryRecord, MemoryStore } from "./memory";
import type { AssetDigest, AssetIdentity, CreativeAssetManifest, DigestVerifier, VaultReader, VaultWriter } from "./vault";
import type { CreativeScope } from "./shared";

function scopeKey(scope: CreativeScope): string {
  return `${scope.tenantId}/${scope.brandId}`;
}

export class InMemoryEvidenceSink implements CreativeEvidenceSink {
  readonly events: CreativeEvidence[] = [];
  fail = false;
  append(evidence: CreativeEvidence): void {
    if (this.fail) throw new Error("evidence sink unavailable");
    this.events.push(evidence);
  }
}

export class InMemoryVault implements VaultReader, VaultWriter {
  private readonly manifests = new Map<string, CreativeAssetManifest>();
  private readonly variants = new Map<string, Uint8Array>();
  failReads = false;
  failWrites = false;

  async appendManifest(manifest: CreativeAssetManifest): Promise<void> {
    if (this.failWrites) throw new Error("vault unavailable");
    const key = `${scopeKey(manifest.scope)}/${manifest.assetId}/${manifest.version}`;
    if (this.manifests.has(key)) throw new Error("append-only manifest collision");
    this.manifests.set(key, manifest);
  }

  async writeVariant(scope: CreativeScope, identity: AssetIdentity, bytes: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error("vault unavailable");
    const key = `${scopeKey(scope)}/${identity.assetId}/${identity.version}/${identity.digest}/${identity.variantId}`;
    if (this.variants.has(key)) throw new Error("append-only variant collision");
    this.variants.set(key, bytes);
  }

  async readManifest(scope: CreativeScope, assetId: string, version: string): Promise<CreativeAssetManifest | undefined> {
    if (this.failReads) throw new Error("vault unavailable");
    return this.manifests.get(`${scopeKey(scope)}/${assetId}/${version}`);
  }

  async listVersions(scope: CreativeScope, assetId: string): Promise<readonly string[]> {
    if (this.failReads) throw new Error("vault unavailable");
    const prefix = `${scopeKey(scope)}/${assetId}/`;
    return [...this.manifests.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  async readVariant(scope: CreativeScope, identity: AssetIdentity): Promise<Uint8Array | undefined> {
    if (this.failReads) throw new Error("vault unavailable");
    return this.variants.get(`${scopeKey(scope)}/${identity.assetId}/${identity.version}/${identity.digest}/${identity.variantId}`);
  }
}

export class StaticDigestVerifier implements DigestVerifier {
  constructor(private readonly value: AssetDigest) {}
  async digest(): Promise<AssetDigest> {
    return this.value;
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, ArtDirectionMemoryRecord>();
  failReads = false;
  failWrites = false;

  async append(record: ArtDirectionMemoryRecord): Promise<void> {
    if (this.failWrites) throw new Error("memory unavailable");
    const key = `${scopeKey(record.scope)}/${record.recordId}`;
    if (this.records.has(key)) throw new Error("append-only collision");
    this.records.set(key, record);
  }

  async get(scope: CreativeScope, recordId: string): Promise<ArtDirectionMemoryRecord | undefined> {
    if (this.failReads) throw new Error("memory unavailable");
    return this.records.get(`${scopeKey(scope)}/${recordId}`);
  }

  async list(scope: CreativeScope): Promise<readonly ArtDirectionMemoryRecord[]> {
    if (this.failReads) throw new Error("memory unavailable");
    const prefix = `${scopeKey(scope)}/`;
    return [...this.records.entries()].filter(([key]) => key.startsWith(prefix)).map(([, record]) => record);
  }

  unsafeInject(record: ArtDirectionMemoryRecord): void {
    this.records.set(`${scopeKey(record.scope)}/${record.recordId}`, record);
  }
}

export class InMemoryGalleryStore implements GalleryStore {
  private readonly entries = new Map<string, GalleryEntry>();
  failReads = false;
  failWrites = false;

  async append(entry: GalleryEntry): Promise<void> {
    if (this.failWrites) throw new Error("gallery unavailable");
    const key = `${scopeKey(entry.scope)}/${entry.entryId}`;
    if (this.entries.has(key)) throw new Error("append-only collision");
    this.entries.set(key, entry);
  }

  async get(scope: CreativeScope, entryId: string): Promise<GalleryEntry | undefined> {
    if (this.failReads) throw new Error("gallery unavailable");
    return this.entries.get(`${scopeKey(scope)}/${entryId}`);
  }

  async list(scope: CreativeScope): Promise<readonly GalleryEntry[]> {
    if (this.failReads) throw new Error("gallery unavailable");
    const prefix = `${scopeKey(scope)}/`;
    return [...this.entries.entries()].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => entry);
  }

  unsafeInject(entry: GalleryEntry): void {
    this.entries.set(`${scopeKey(entry.scope)}/${entry.entryId}`, entry);
  }
}

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "@nexus/ontology";
import {
  MetadataPublisherError,
  createPublishedMetadataSnapshot,
  validatePublishedMetadataSnapshot,
  type MetadataPublishAction,
  type MetadataPublishReceipt,
  type MetadataPublisher,
  type PublishedMetadataSnapshot,
  type SeoMetadataValue,
} from "./index";

const FORMAT_VERSION = "nexus-serp-metadata-manifest-v1";
const PUBLISHER_VERSION = "nexus-json-metadata-publisher-v1";

interface ManifestEntry {
  readonly pageUrl: string;
  readonly metadata: SeoMetadataValue;
  readonly revision: number;
  readonly digest: string;
}

interface Manifest {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly siteUrl: string;
  readonly pages: Readonly<Record<string, ManifestEntry>>;
}

export interface JsonFileMetadataPublisherConfig {
  readonly manifestPath: string;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MetadataPublisherError("PUBLISH_FAILURE", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseMetadata(value: unknown, field: string): SeoMetadataValue {
  const raw = object(value, field);
  if (typeof raw.title !== "string" || !raw.title.trim()) throw new MetadataPublisherError("PUBLISH_FAILURE", `${field}.title is invalid`);
  if (raw.metaDescription !== null && typeof raw.metaDescription !== "string") throw new MetadataPublisherError("PUBLISH_FAILURE", `${field}.metaDescription is invalid`);
  return Object.freeze({ title: raw.title, metaDescription: raw.metaDescription as string | null });
}

function parseEntry(pageId: string, value: unknown): PublishedMetadataSnapshot {
  const raw = object(value, `pages.${pageId}`);
  if (typeof raw.pageUrl !== "string" || typeof raw.revision !== "number" || typeof raw.digest !== "string") throw new MetadataPublisherError("PUBLISH_FAILURE", `pages.${pageId} is invalid`);
  const snapshot: PublishedMetadataSnapshot = Object.freeze({
    pageId,
    pageUrl: raw.pageUrl,
    metadata: parseMetadata(raw.metadata, `pages.${pageId}.metadata`),
    revision: raw.revision,
    digest: raw.digest,
  });
  try { validatePublishedMetadataSnapshot(snapshot); } catch (error) {
    throw new MetadataPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : `pages.${pageId} failed integrity validation`);
  }
  return snapshot;
}

function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new MetadataPublisherError("PUBLISH_FAILURE", "metadata manifest is not valid JSON"); }
  const raw = object(parsed, "manifest");
  if (raw.formatVersion !== FORMAT_VERSION || typeof raw.siteUrl !== "string") throw new MetadataPublisherError("PUBLISH_FAILURE", "metadata manifest identity is invalid");
  const rawPages = object(raw.pages, "manifest.pages");
  const pages: Record<string, ManifestEntry> = {};
  for (const pageId of Object.keys(rawPages).sort((a, b) => a.localeCompare(b, "en"))) {
    const snapshot = parseEntry(pageId, rawPages[pageId]);
    pages[pageId] = Object.freeze({ pageUrl: snapshot.pageUrl, metadata: snapshot.metadata, revision: snapshot.revision, digest: snapshot.digest });
  }
  return Object.freeze({ formatVersion: FORMAT_VERSION, siteUrl: raw.siteUrl, pages: Object.freeze(pages) });
}

function snapshotFromEntry(pageId: string, entry: ManifestEntry | undefined): PublishedMetadataSnapshot | null {
  if (!entry) return null;
  const snapshot: PublishedMetadataSnapshot = Object.freeze({ pageId, pageUrl: entry.pageUrl, metadata: entry.metadata, revision: entry.revision, digest: entry.digest });
  validatePublishedMetadataSnapshot(snapshot);
  return snapshot;
}

function sameSnapshot(left: PublishedMetadataSnapshot | null, right: PublishedMetadataSnapshot | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameMetadata(left: SeoMetadataValue, right: SeoMetadataValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class JsonFileMetadataPublisher implements MetadataPublisher {
  readonly manifestPath: string;
  private readonly lockPath: string;

  constructor(config: JsonFileMetadataPublisherConfig) {
    if (typeof config.manifestPath !== "string" || !config.manifestPath.trim()) throw new MetadataPublisherError("INVALID_CONFIG", "manifestPath is required");
    this.manifestPath = resolve(config.manifestPath);
    this.lockPath = `${this.manifestPath}.lock`;
    mkdirSync(dirname(this.manifestPath), { recursive: true });
  }

  private readManifest(): Manifest | null {
    if (!existsSync(this.manifestPath)) return null;
    return parseManifest(readFileSync(this.manifestPath, "utf8"));
  }

  private readForSite(siteUrl: string): Manifest | null {
    const manifest = this.readManifest();
    if (manifest && manifest.siteUrl !== siteUrl) throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata manifest belongs to another Search Console property");
    return manifest;
  }

  async read(siteUrl: string, pageId: string, pageUrl: string): Promise<PublishedMetadataSnapshot | null> {
    const manifest = this.readForSite(siteUrl);
    const snapshot = snapshotFromEntry(pageId, manifest?.pages[pageId]);
    if (snapshot && snapshot.pageUrl !== pageUrl) throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata pageId is bound to another URL");
    return snapshot;
  }

  private writeManifest(manifest: Manifest): void {
    const tempPath = `${this.manifestPath}.tmp-${process.pid}`;
    let fd: number | null = null;
    let renamed = false;
    try {
      const stablePages = Object.fromEntries(Object.entries(manifest.pages).sort(([a], [b]) => a.localeCompare(b, "en")));
      const body = `${canonicalJson({ formatVersion: FORMAT_VERSION, siteUrl: manifest.siteUrl, pages: stablePages })}\n`;
      fd = openSync(tempPath, "w", 0o600);
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, this.manifestPath);
      renamed = true;
      const directoryFd = openSync(dirname(this.manifestPath), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      const verified = this.readManifest();
      if (!verified || canonicalJson(verified) !== canonicalJson({ formatVersion: FORMAT_VERSION, siteUrl: manifest.siteUrl, pages: stablePages })) {
        throw new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "metadata manifest rename completed but read-back could not certify the result");
      }
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* best effort */ } }
      if (!renamed) { try { rmSync(tempPath, { force: true }); } catch { /* best effort */ } }
      if (error instanceof MetadataPublisherError) throw error;
      if (renamed) throw new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", error instanceof Error ? error.message : "metadata manifest post-rename failure");
      throw new MetadataPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "metadata manifest write failed");
    }
  }

  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    let lockFd: number | null = null;
    try {
      try { lockFd = openSync(this.lockPath, "wx", 0o600); } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
        if (code === "EEXIST") throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata manifest is locked by another writer");
        throw new MetadataPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "metadata manifest lock failed");
      }
      const manifest: Manifest = this.readForSite(action.siteUrl) ?? Object.freeze({
        formatVersion: FORMAT_VERSION,
        siteUrl: action.siteUrl,
        pages: Object.freeze({} as Record<string, ManifestEntry>),
      });
      const current = snapshotFromEntry(action.pageId, manifest.pages[action.pageId]);
      if (current && current.pageUrl !== action.pageUrl) throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata pageId is bound to another URL");

      if (action.kind === "UPSERT_METADATA_OVERRIDE") {
        if (current && sameMetadata(current.metadata, action.desired)) {
          return Object.freeze({ snapshot: current, recoveredAlreadyApplied: true, publisherVersion: PUBLISHER_VERSION });
        }
        if (!sameSnapshot(current, action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata override changed after optimizer preflight");
        const next = createPublishedMetadataSnapshot({ pageId: action.pageId, pageUrl: action.pageUrl, metadata: action.desired, revision: (current?.revision ?? 0) + 1 });
        const pages: Record<string, ManifestEntry> = { ...manifest.pages, [action.pageId]: Object.freeze({ pageUrl: next.pageUrl, metadata: next.metadata, revision: next.revision, digest: next.digest }) };
        this.writeManifest(Object.freeze({ formatVersion: FORMAT_VERSION, siteUrl: action.siteUrl, pages: Object.freeze(pages) }));
        const certified = await this.read(action.siteUrl, action.pageId, action.pageUrl);
        if (!certified || certified.digest !== next.digest) throw new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "metadata override write could not be certified after commit");
        return Object.freeze({ snapshot: certified, recoveredAlreadyApplied: false, publisherVersion: PUBLISHER_VERSION });
      }

      if (!current) return Object.freeze({ snapshot: null, recoveredAlreadyApplied: true, publisherVersion: PUBLISHER_VERSION });
      if (!sameSnapshot(current, action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "metadata override changed before rollback removal");
      const pages: Record<string, ManifestEntry> = { ...manifest.pages };
      delete pages[action.pageId];
      this.writeManifest(Object.freeze({ formatVersion: FORMAT_VERSION, siteUrl: action.siteUrl, pages: Object.freeze(pages) }));
      const certified = await this.read(action.siteUrl, action.pageId, action.pageUrl);
      if (certified !== null) throw new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "metadata override removal could not be certified after commit");
      return Object.freeze({ snapshot: null, recoveredAlreadyApplied: false, publisherVersion: PUBLISHER_VERSION });
    } finally {
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch { /* best effort */ }
        try { rmSync(this.lockPath, { force: true }); } catch { /* best effort */ }
      }
    }
  }
}

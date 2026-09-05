import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "@nexus/ontology";
import {
  ProgrammaticSeoPublisherError,
  createProgrammaticSeoBundleRef,
  createPublishedProgrammaticSeoBundle,
  validateProgrammaticSeoBundle,
  validateProgrammaticSeoBundleRef,
  validatePublishedProgrammaticSeoBundle,
  type ProgrammaticSeoBundle,
  type ProgrammaticSeoBundleRef,
  type ProgrammaticSeoPublishAction,
  type ProgrammaticSeoPublishReceipt,
  type ProgrammaticSeoPublisher,
  type PublishedProgrammaticSeoBundle,
} from "./index";

const FORMAT_VERSION = "nexus-programmatic-seo-manifest-v2";
const PUBLISHER_VERSION = "nexus-json-programmatic-seo-publisher-v2";
const DIGEST = /^sha256:([0-9a-f]{64})$/u;
let tempSequence = 0;

interface Manifest { readonly formatVersion: typeof FORMAT_VERSION; readonly siteId: string; readonly current: PublishedProgrammaticSeoBundle | null; }
export interface JsonFileProgrammaticSeoPublisherConfig { readonly manifestPath: string; }

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", `${field} must be an object`); return value as Record<string, unknown>; }
function artifactId(bundleDigest: string): string { const match = DIGEST.exec(bundleDigest); if (!match) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundle digest must be sha256"); return `bundle-${match[1]}`; }
function parseRef(value: unknown): ProgrammaticSeoBundleRef {
  const raw = object(value, "bundleRef"); if (typeof raw.siteId !== "string" || typeof raw.bundleDigest !== "string" || typeof raw.artifactId !== "string" || typeof raw.digest !== "string") throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundleRef is malformed");
  const ref = Object.freeze({ siteId: raw.siteId, bundleDigest: raw.bundleDigest, artifactId: raw.artifactId, digest: raw.digest });
  try { validateProgrammaticSeoBundleRef(ref); } catch (error) { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "bundleRef failed integrity validation"); }
  if (ref.artifactId !== artifactId(ref.bundleDigest)) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundleRef artifact identity mismatch"); return ref;
}
function parsePublished(value: unknown): PublishedProgrammaticSeoBundle {
  const raw = object(value, "published"); if (typeof raw.siteId !== "string" || typeof raw.revision !== "number" || typeof raw.digest !== "string") throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "published snapshot is malformed");
  const snapshot = Object.freeze({ siteId: raw.siteId, bundleRef: parseRef(raw.bundleRef), revision: raw.revision, digest: raw.digest });
  try { validatePublishedProgrammaticSeoBundle(snapshot); } catch (error) { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "published snapshot failed integrity validation"); } return snapshot;
}
function parseManifest(text: string): Manifest {
  let parsed: unknown; try { parsed = JSON.parse(text) as unknown; } catch { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "programmatic SEO manifest is not valid JSON"); }
  const raw = object(parsed, "manifest"); if (raw.formatVersion !== FORMAT_VERSION || typeof raw.siteId !== "string") throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "manifest identity is invalid");
  const current = raw.current === null ? null : parsePublished(raw.current); if (current && current.siteId !== raw.siteId) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "manifest current snapshot belongs to another site"); return Object.freeze({ formatVersion: FORMAT_VERSION, siteId: raw.siteId, current });
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

export class JsonFileProgrammaticSeoPublisher implements ProgrammaticSeoPublisher {
  readonly manifestPath: string;
  readonly artifactsDirectory: string;
  private readonly lockPath: string;

  constructor(config: JsonFileProgrammaticSeoPublisherConfig) {
    if (typeof config.manifestPath !== "string" || !config.manifestPath.trim()) throw new ProgrammaticSeoPublisherError("INVALID_CONFIG", "manifestPath is required");
    this.manifestPath = resolve(config.manifestPath); this.artifactsDirectory = `${this.manifestPath}.bundles`; this.lockPath = `${this.manifestPath}.lock`;
    mkdirSync(dirname(this.manifestPath), { recursive: true }); mkdirSync(this.artifactsDirectory, { recursive: true });
  }
  private artifactPath(ref: ProgrammaticSeoBundleRef): string {
    try { validateProgrammaticSeoBundleRef(ref); } catch (error) { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "bundleRef failed validation"); }
    if (ref.artifactId !== artifactId(ref.bundleDigest)) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundleRef artifact identity mismatch"); return join(this.artifactsDirectory, `${ref.artifactId}.json`);
  }
  private syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private atomicWrite(path: string, body: string): void {
    const tempPath = `${path}.tmp-${process.pid}-${++tempSequence}`; try { rmSync(tempPath, { force: true }); } catch { /* stale temp cleanup is best effort */ }
    let fd: number | null = null; let renamed = false;
    try {
      fd = openSync(tempPath, "wx", 0o600); writeFileSync(fd, body, "utf8"); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tempPath, path); renamed = true; this.syncDirectory(dirname(path));
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* best effort */ } } if (!renamed) { try { rmSync(tempPath, { force: true }); } catch { /* best effort */ } }
      if (renamed) throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", error instanceof Error ? error.message : "post-rename durability failure"); throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "atomic write failed");
    }
  }
  async stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef> {
    try { validateProgrammaticSeoBundle(bundle); } catch (error) { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "bundle failed validation"); }
    const ref = createProgrammaticSeoBundleRef(bundle.siteId, bundle.digest, artifactId(bundle.digest)); const path = this.artifactPath(ref);
    if (existsSync(path)) { const existing = await this.load(ref); if (canonicalJson(existing) !== canonicalJson(bundle)) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "content-addressed artifact collision"); return ref; }
    this.atomicWrite(path, `${canonicalJson(bundle)}\n`); const certified = await this.load(ref); if (canonicalJson(certified) !== canonicalJson(bundle)) throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "staged bundle could not be certified"); return ref;
  }
  async load(ref: ProgrammaticSeoBundleRef): Promise<ProgrammaticSeoBundle> {
    const path = this.artifactPath(ref); if (!existsSync(path)) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "referenced bundle artifact is missing");
    let parsed: unknown; try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundle artifact is not valid JSON"); }
    const bundle = parsed as ProgrammaticSeoBundle; try { validateProgrammaticSeoBundle(bundle); } catch (error) { throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "bundle artifact failed integrity validation"); }
    if (bundle.siteId !== ref.siteId || bundle.digest !== ref.bundleDigest) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "bundle artifact identity mismatch"); return bundle;
  }
  private readManifest(): Manifest | null { if (!existsSync(this.manifestPath)) return null; return parseManifest(readFileSync(this.manifestPath, "utf8")); }
  async read(siteId: string): Promise<PublishedProgrammaticSeoBundle | null> {
    const manifest = this.readManifest(); if (!manifest) return null; if (manifest.siteId !== siteId) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "manifest belongs to another site"); if (manifest.current) await this.load(manifest.current.bundleRef); return manifest.current;
  }
  private writeManifest(manifest: Manifest): void {
    this.atomicWrite(this.manifestPath, `${canonicalJson(manifest)}\n`); const verified = this.readManifest(); if (!verified || canonicalJson(verified) !== canonicalJson(manifest)) throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "manifest read-back did not certify committed state");
  }
  async apply(action: ProgrammaticSeoPublishAction): Promise<ProgrammaticSeoPublishReceipt> {
    let lockFd: number | null = null;
    try {
      try { lockFd = openSync(this.lockPath, "wx", 0o600); } catch (error) { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : ""; if (code === "EEXIST") throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "manifest is locked by another writer"); throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", error instanceof Error ? error.message : "manifest lock failed"); }
      const manifest = this.readManifest(); if (manifest && manifest.siteId !== action.siteId) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "manifest belongs to another site"); const current = manifest?.current ?? null;
      if (current) await this.load(current.bundleRef); if (action.desired) await this.load(action.desired);
      if (action.expected && action.expected.siteId !== action.siteId) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "expected snapshot belongs to another site"); if (action.desired && action.desired.siteId !== action.siteId) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "desired bundle reference belongs to another site");
      if (action.desired && current?.bundleRef.digest === action.desired.digest) return Object.freeze({ snapshot: current, recoveredAlreadyApplied: true, publisherVersion: PUBLISHER_VERSION });
      if (action.desired === null && current === null) return Object.freeze({ snapshot: null, recoveredAlreadyApplied: true, publisherVersion: PUBLISHER_VERSION });
      if (!same(current, action.expected)) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "published bundle changed after preflight");
      const next = action.desired ? createPublishedProgrammaticSeoBundle(action.desired, (current?.revision ?? 0) + 1) : null; this.writeManifest(Object.freeze({ formatVersion: FORMAT_VERSION, siteId: action.siteId, current: next }));
      const certified = await this.read(action.siteId); if (!same(certified, next)) throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "manifest change could not be certified after commit"); return Object.freeze({ snapshot: certified, recoveredAlreadyApplied: false, publisherVersion: PUBLISHER_VERSION });
    } finally {
      if (lockFd !== null) { try { closeSync(lockFd); } catch { /* best effort */ } try { rmSync(this.lockPath, { force: true }); } catch { /* best effort */ } }
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface ArtifactRecord {
  id: string;
  requestId: string;
  name: string;
  path: string;
  url: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ArtifactStore {
  putFile(requestId: string, name: string, sourcePath: string, mediaType: string, metadata?: ArtifactRecord["metadata"]): Promise<ArtifactRecord>;
  manifest(requestId: string): Promise<readonly ArtifactRecord[]>;
  resolve(requestId: string, id: string): Promise<{ path: string; record: ArtifactRecord; bytes: Buffer } | null>;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_REQUEST = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;

export class LocalArtifactStore implements ArtifactStore {
  readonly root: string;
  readonly maxArtifactBytes: number;
  private readonly manifestUpdates = new Map<string, Promise<void>>();

  constructor(root: string, maxArtifactBytes: number) {
    this.root = resolve(root);
    this.maxArtifactBytes = maxArtifactBytes;
  }

  private directory(requestId: string): string {
    if (!SAFE_REQUEST.test(requestId)) throw new Error("invalid artifact requestId");
    return join(this.root, requestId);
  }

  async putFile(requestId: string, name: string, sourcePath: string, mediaType: string, metadata: ArtifactRecord["metadata"] = {}): Promise<ArtifactRecord> {
    const id = basename(name);
    if (!SAFE_ID.test(id) || id !== name) throw new Error("artifact name must be a confined basename");
    const source = resolve(sourcePath);
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`artifact source is not a file: ${sourcePath}`);
    if (info.size > this.maxArtifactBytes) throw new Error(`artifact exceeds configured ${this.maxArtifactBytes} byte limit`);
    const directory = this.directory(requestId); await mkdir(directory, { recursive: true });
    const destination = join(directory, id);
    if (source !== destination) await copyFile(source, destination);
    const bytes = await readFile(destination);
    const record: ArtifactRecord = Object.freeze({ id, requestId, name: id, path: relative(process.cwd(), destination).split(sep).join("/"), url: `/artifacts/${requestId}/${encodeURIComponent(id)}`, mediaType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: Object.freeze({ ...metadata }) });
    const previous = this.manifestUpdates.get(requestId) ?? Promise.resolve();
    const update = previous.catch(() => undefined).then(async () => {
      const recordsById = new Map((await this.manifest(requestId)).map((item) => [item.id, item])); recordsById.set(record.id, record);
      const records = [...recordsById.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
      const temporary = join(directory, `.manifest.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, requestId, artifacts: records }, null, 2)}\n`);
        await rename(temporary, join(directory, "manifest.json"));
      } finally { await rm(temporary, { force: true }); }
    });
    this.manifestUpdates.set(requestId, update);
    try { await update; }
    finally { if (this.manifestUpdates.get(requestId) === update) this.manifestUpdates.delete(requestId); }
    return record;
  }

  async manifest(requestId: string): Promise<readonly ArtifactRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory(requestId), "manifest.json"), "utf8")) as { schemaVersion?: number; requestId?: string; artifacts?: ArtifactRecord[] };
      if (parsed.schemaVersion !== 1 || parsed.requestId !== requestId || !Array.isArray(parsed.artifacts)) throw new Error("invalid artifact manifest");
      return parsed.artifacts;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  async resolve(requestId: string, id: string): Promise<{ path: string; record: ArtifactRecord; bytes: Buffer } | null> {
    if (!SAFE_ID.test(id) || basename(id) !== id) return null;
    if (id === "manifest.json") {
      const path = join(this.directory(requestId), id);
      try {
        const bytes = await readFile(path);
        return { path, bytes, record: { id, requestId, name: id, path: relative(process.cwd(), path).split(sep).join("/"), url: `/artifacts/${requestId}/manifest.json`, mediaType: "application/json", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: { authority: "NEXUS_MCP_ARTIFACT_MANIFEST_V1" } } };
      } catch { return null; }
    }
    const record = (await this.manifest(requestId)).find((item) => item.id === id);
    if (!record) return null;
    const path = resolve(this.directory(requestId), id);
    if (!path.startsWith(`${this.directory(requestId)}${sep}`)) return null;
    try {
      if (!(await stat(path)).isFile()) return null;
      const bytes = await readFile(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== record.byteLength || sha256 !== record.sha256) return null;
      return { path, record, bytes };
    } catch { return null; }
  }
}

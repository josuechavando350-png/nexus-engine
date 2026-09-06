import { DatabaseSync } from "node:sqlite";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/u;
const PATH = /^\/[A-Za-z0-9/_-]{0,255}$/u;
const MAX_EMBEDDING_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface SearchDocumentInput {
  readonly id: string;
  readonly text: string;
  readonly landingPath: string;
}

export interface SemanticSearchOptions {
  readonly topK: number;
  readonly minSemanticCoverage: number;
}

export interface SearchHit {
  readonly id: string;
  readonly landingPath: string;
  readonly score: number;
  readonly semanticScore: number | null;
  readonly lexicalScore: number;
}

export interface SemanticSearchResult {
  readonly mode: "HYBRID" | "LEXICAL_FALLBACK";
  readonly semanticCoverage: number;
  readonly modelId: string | null;
  readonly hits: readonly SearchHit[];
}

export interface EmbeddingProvider {
  readonly modelId: string;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export class Cortex15Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "PROVIDER_ERROR" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "Cortex15Error";
  }
}

function parseDocument(value: unknown): SearchDocumentInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex15Error("INVALID_INPUT", "search document must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "id,landingPath,text") throw new Cortex15Error("INVALID_INPUT", "document contract contains missing or unsupported fields");
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw new Cortex15Error("INVALID_INPUT", "document id is malformed");
  if (typeof raw.landingPath !== "string" || !PATH.test(raw.landingPath) || raw.landingPath.includes("//")) throw new Cortex15Error("INVALID_INPUT", "landingPath is malformed");
  if (typeof raw.text !== "string" || raw.text.trim().length < 3 || raw.text.length > 50_000) throw new Cortex15Error("INVALID_INPUT", "document text is invalid");
  return Object.freeze({ id: raw.id, text: raw.text.trim(), landingPath: raw.landingPath });
}

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("es-MX").match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length > 1).slice(0, 10_000) ?? [];
}

function vector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 8 || value.length > 8_192) throw new Cortex15Error("PROVIDER_ERROR", "embedding has invalid dimensions");
  const parsed = value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > 1e9) throw new Cortex15Error("PROVIDER_ERROR", "embedding contains invalid values");
    return item;
  });
  const norm = Math.sqrt(parsed.reduce((sum, item) => sum + item * item, 0));
  if (!(norm > 0)) throw new Cortex15Error("PROVIDER_ERROR", "embedding norm is zero");
  return Object.freeze(parsed);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0; let l = 0; let r = 0;
  for (let i = 0; i < left.length; i += 1) { dot += left[i]! * right[i]!; l += left[i]! ** 2; r += right[i]! ** 2; }
  return l > 0 && r > 0 ? dot / Math.sqrt(l * r) : 0;
}

function round(value: number): number { return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000; }

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_EMBEDDING_RESPONSE_BYTES)) throw new Cortex15Error("PROVIDER_ERROR", "embedding response is oversized");
  if (!response.body) throw new Cortex15Error("PROVIDER_ERROR", "embedding response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Cortex15Error("PROVIDER_ERROR", "embedding response is oversized");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(combined)) as unknown; }
  catch { throw new Cortex15Error("PROVIDER_ERROR", "embedding response is not valid JSON"); }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly endpoint: URL, public readonly modelId: string, private readonly bearerToken: string, private readonly timeoutMs = 10_000) {
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !ID.test(modelId) || !bearerToken || bearerToken.length > 8_192 || /[\r\n\0]/u.test(bearerToken) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Cortex15Error("INVALID_INPUT", "embedding provider configuration is invalid");
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length < 1 || texts.length > 128 || texts.some((text) => typeof text !== "string" || text.length < 1 || text.length > 50_000)) throw new Cortex15Error("INVALID_INPUT", "embedding batch is invalid");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: this.modelId, input: texts }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Cortex15Error("PROVIDER_ERROR", `embedding provider returned HTTP ${response.status}`);
    const body = await readBoundedJson(response) as { data?: unknown };
    if (!body || typeof body !== "object" || !Array.isArray(body.data) || body.data.length !== texts.length) throw new Cortex15Error("PROVIDER_ERROR", "embedding response cardinality mismatch");
    const byIndex = new Map<number, readonly number[]>();
    for (const item of body.data) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Cortex15Error("PROVIDER_ERROR", "embedding response item is invalid");
      const raw = item as Record<string, unknown>;
      if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || (raw.index as number) >= texts.length || byIndex.has(raw.index as number)) throw new Cortex15Error("PROVIDER_ERROR", "embedding response index is invalid or duplicated");
      byIndex.set(raw.index as number, vector(raw.embedding));
    }
    const ordered = Array.from({ length: texts.length }, (_, index) => byIndex.get(index));
    if (ordered.some((item) => !item)) throw new Cortex15Error("PROVIDER_ERROR", "embedding response indices are incomplete");
    const dimensions = ordered[0]!.length;
    if (!ordered.every((item) => item!.length === dimensions)) throw new Cortex15Error("PROVIDER_ERROR", "embedding response dimensions are inconsistent");
    return Object.freeze(ordered as readonly (readonly number[])[]);
  }
}

interface StoredDocument extends SearchDocumentInput { readonly embedding: readonly number[] | null; readonly modelId: string | null; }

export class SqliteSemanticSearchIndex {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly provider: EmbeddingProvider | null, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex15Error("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex15_documents(
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      landing_path TEXT NOT NULL,
      embedding_json TEXT,
      model_id TEXT,
      updated_at TEXT NOT NULL
    );`);
  }
  close(): void { this.db.close(); }

  async upsertDocuments(values: readonly unknown[], beforeCommit?: () => void): Promise<{ indexed: number; semantic: number; lexicalOnly: number }> {
    if (!Array.isArray(values) || values.length < 1 || values.length > 500) throw new Cortex15Error("INVALID_INPUT", "document batch must contain 1-500 entries");
    if (beforeCommit !== undefined && typeof beforeCommit !== "function") throw new Cortex15Error("INVALID_INPUT", "beforeCommit guard is invalid");
    const docs = values.map(parseDocument);
    if (new Set(docs.map((doc) => doc.id)).size !== docs.length) throw new Cortex15Error("INVALID_INPUT", "document batch contains duplicate ids");
    let embeddings: readonly (readonly number[])[] | null = null;
    if (this.provider) {
      try { embeddings = await this.provider.embed(docs.map((doc) => doc.text)); } catch { embeddings = null; }
    }
    const updatedAt = new Date(this.now()).toISOString();
    const statement = this.db.prepare(`INSERT INTO cortex15_documents(id,text,landing_path,embedding_json,model_id,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,landing_path=excluded.landing_path,embedding_json=excluded.embedding_json,model_id=excluded.model_id,updated_at=excluded.updated_at`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      beforeCommit?.();
      docs.forEach((doc, index) => {
        const embedding = embeddings ? vector(embeddings[index]) : null;
        statement.run(doc.id, doc.text, doc.landingPath, embedding ? JSON.stringify(embedding) : null, embedding ? this.provider!.modelId : null, updatedAt);
      });
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    const semantic = embeddings ? docs.length : 0;
    return Object.freeze({ indexed: docs.length, semantic, lexicalOnly: docs.length - semantic });
  }

  async search(query: string, options: SemanticSearchOptions): Promise<SemanticSearchResult> {
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 1_000) throw new Cortex15Error("INVALID_INPUT", "query is invalid");
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).sort().join(",") !== "minSemanticCoverage,topK" || !Number.isSafeInteger(options.topK) || options.topK < 1 || options.topK > 100 || typeof options.minSemanticCoverage !== "number" || !Number.isFinite(options.minSemanticCoverage) || options.minSemanticCoverage < 0 || options.minSemanticCoverage > 1) throw new Cortex15Error("INVALID_INPUT", "search options are invalid");
    const docs = (this.db.prepare("SELECT id,text,landing_path,embedding_json,model_id FROM cortex15_documents ORDER BY id").all() as Record<string, unknown>[]).map((row): StoredDocument => {
      let embedding: readonly number[] | null = null;
      if (row.embedding_json) {
        try { embedding = vector(JSON.parse(String(row.embedding_json)) as unknown); }
        catch { throw new Cortex15Error("INTEGRITY_FAILURE", "stored embedding is corrupt"); }
      }
      return { id: String(row.id), text: String(row.text), landingPath: String(row.landing_path), embedding, modelId: row.model_id ? String(row.model_id) : null };
    });
    if (docs.length === 0) return Object.freeze({ mode: "LEXICAL_FALLBACK", semanticCoverage: 0, modelId: null, hits: Object.freeze([]) });
    const queryTokens = tokens(query);
    const tokenized = docs.map((doc) => tokens(doc.text));
    const avgLength = tokenized.reduce((sum, row) => sum + row.length, 0) / docs.length || 1;
    const documentFrequency = new Map<string, number>();
    for (const row of tokenized) for (const term of new Set(row)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    const lexicalRaw = tokenized.map((row) => {
      const frequencies = new Map<string, number>(); for (const term of row) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      let score = 0; const k1 = 1.2; const b = 0.75;
      for (const term of queryTokens) { const df = documentFrequency.get(term) ?? 0; const tf = frequencies.get(term) ?? 0; if (!tf) continue; const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)); score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * row.length / avgLength)); }
      return score;
    });
    const lexicalMax = Math.max(1e-9, ...lexicalRaw);
    const lexical = lexicalRaw.map((score) => score / lexicalMax);
    const semanticDocs = docs.filter((doc) => doc.embedding && doc.modelId === this.provider?.modelId);
    const coverage = semanticDocs.length / docs.length;
    let queryVector: readonly number[] | null = null;
    if (this.provider && coverage >= options.minSemanticCoverage) { try { queryVector = vector((await this.provider.embed([query.trim()]))[0]); } catch { queryVector = null; } }
    const useSemantic = Boolean(queryVector && coverage >= options.minSemanticCoverage);
    const hits = docs.map((doc, index): SearchHit => {
      const semanticScore = useSemantic && doc.embedding && doc.modelId === this.provider?.modelId ? (cosine(queryVector!, doc.embedding) + 1) / 2 : null;
      const lexicalScore = lexical[index] ?? 0;
      const score = semanticScore === null ? lexicalScore : 0.7 * semanticScore + 0.3 * lexicalScore;
      return Object.freeze({ id: doc.id, landingPath: doc.landingPath, score: round(score), semanticScore: semanticScore === null ? null : round(semanticScore), lexicalScore: round(lexicalScore) });
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.topK);
    return Object.freeze({ mode: useSemantic ? "HYBRID" : "LEXICAL_FALLBACK", semanticCoverage: round(coverage), modelId: useSemantic ? this.provider!.modelId : null, hits: Object.freeze(hits) });
  }
}

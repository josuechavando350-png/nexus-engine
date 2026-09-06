import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex15Error, OpenAICompatibleEmbeddingProvider, SqliteSemanticSearchIndex, type EmbeddingProvider } from "./index";

const dirs: string[] = [];
function path(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex15-")); dirs.push(dir); return join(dir, "search.sqlite"); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const docs = [
  { id: "doc-0001", text: "abogado penal defensa urgente audiencia", landingPath: "/penal" },
  { id: "doc-0002", text: "asesoría mercantil contratos empresas", landingPath: "/mercantil" },
  { id: "doc-0003", text: "defensa penal carpeta de investigación", landingPath: "/investigacion" },
] as const;

const provider: EmbeddingProvider = {
  modelId: "embedding-model-v1",
  embed: vi.fn(async (texts: readonly string[]) => texts.map((text) => text.includes("penal") || text.includes("defensa") ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])),
};

describe("CORTEX #15 semantic search", () => {
  it("indexes real provider embeddings and combines semantic plus lexical evidence", async () => {
    const index = new SqliteSemanticSearchIndex(path(), provider);
    expect(await index.upsertDocuments(docs)).toEqual({ indexed: 3, semantic: 3, lexicalOnly: 0 });
    const result = await index.search("defensa penal", { topK: 3, minSemanticCoverage: 0.8 });
    expect(result.mode).toBe("HYBRID");
    expect(result.semanticCoverage).toBe(1);
    expect(result.modelId).toBe("embedding-model-v1");
    expect(result.hits[0]?.landingPath).toMatch(/^\/(penal|investigacion)$/u);
    index.close();
  });

  it("falls back to BM25 when embedding generation is unavailable instead of fabricating vectors", async () => {
    const failing: EmbeddingProvider = { modelId: "embedding-model-v1", embed: vi.fn(async () => { throw new Error("provider unavailable"); }) };
    const index = new SqliteSemanticSearchIndex(path(), failing);
    expect(await index.upsertDocuments(docs)).toEqual({ indexed: 3, semantic: 0, lexicalOnly: 3 });
    const result = await index.search("contratos empresas", { topK: 3, minSemanticCoverage: 0.5 });
    expect(result.mode).toBe("LEXICAL_FALLBACK");
    expect(result.semanticCoverage).toBe(0);
    expect(result.modelId).toBeNull();
    expect(result.hits[0]?.id).toBe("doc-0002");
    expect(result.hits.every((hit) => hit.semanticScore === null)).toBe(true);
    index.close();
  });

  it("uses lexical fallback if stored semantic coverage is below the configured threshold", async () => {
    const db = path();
    const index = new SqliteSemanticSearchIndex(db, null);
    await index.upsertDocuments(docs);
    const result = await index.search("defensa penal", { topK: 2, minSemanticCoverage: 0.7 });
    expect(result.mode).toBe("LEXICAL_FALLBACK");
    index.close();
  });

  it("rejects unsafe document paths and unsupported fields", async () => {
    const index = new SqliteSemanticSearchIndex(path(), null);
    await expect(index.upsertDocuments([{ ...docs[0], landingPath: "https://attacker.invalid" }])).rejects.toBeInstanceOf(Cortex15Error);
    await expect(index.upsertDocuments([{ ...docs[0], email: "not-allowed@example.invalid" }])).rejects.toBeInstanceOf(Cortex15Error);
    index.close();
  });
});

describe("CORTEX #15 HTTPS embedding adapter", () => {
  it("uses an HTTPS OpenAI-compatible boundary with fixed model identity", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ index: 0, embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleEmbeddingProvider(new URL("https://embeddings.example/v1/embeddings"), "embedding-model-v1", "token", 1_000);
    expect(await adapter.embed(["defensa penal"])).toHaveLength(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token");
    expect(init.redirect).toBe("error");
  });

  it("rejects non-HTTPS providers", () => {
    expect(() => new OpenAICompatibleEmbeddingProvider(new URL("http://embeddings.example"), "embedding-model-v1", "token")).toThrowError(/configuration/u);
  });
});

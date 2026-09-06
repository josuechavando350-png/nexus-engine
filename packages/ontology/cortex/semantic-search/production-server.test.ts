import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSemanticSearchIndex } from "./index";
import { startCortex15Server } from "./production-server";
import type { Cortex15Mode } from "./runtime-control";

const dirs: string[] = [];
const port = 39815;
const origin = `http://127.0.0.1:${port}`;
const writeToken = "w".repeat(32);
const readToken = "r".repeat(32);
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex15-server-")); dirs.push(dir); return join(dir, "search.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function request(path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : null });
      });
    });
    req.on("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function waitHealth(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if ((await request("/healthz", readToken)).status === expected) return; } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`CORTEX #15 server did not reach HTTP ${expected}`);
}

describe("CORTEX #15 production search boundary", () => {
  it("requires auth, indexes only in ACTIVE, and serves lexical fallback without fabricating embeddings", async () => {
    const index = new SqliteSemanticSearchIndex(database(), null);
    let mode: Cortex15Mode = "ACTIVE";
    const server = startCortex15Server({ index, writeToken, readToken, port, readMode: () => mode });
    try {
      await waitHealth(200);
      expect((await request("/v1/documents", "x".repeat(32), { documents: [] })).status).toBe(401);
      const indexed = await request("/v1/documents", writeToken, { documents: [{ id: "doc-0001", text: "defensa penal audiencia urgente", landingPath: "/penal" }] });
      expect(indexed).toEqual({ status: 200, body: { indexed: 1, semantic: 0, lexicalOnly: 1 } });
      const searched = await request("/v1/search", readToken, { query: "defensa penal", options: { topK: 5, minSemanticCoverage: 0.8 } });
      expect(searched.status).toBe(200);
      expect(searched.body).toMatchObject({ mode: "ACTIVE", result: { mode: "LEXICAL_FALLBACK", semanticCoverage: 0, modelId: null } });
      mode = "KILLED";
      expect((await request("/v1/search", readToken, { query: "defensa", options: { topK: 5, minSemanticCoverage: 0 } })).status).toBe(503);
    } finally { await server.close(); index.close(); }
  });

  it("rechecks durable control immediately before mutation and rolls the transaction back", async () => {
    const index = new SqliteSemanticSearchIndex(database(), null);
    let reads = 0;
    const server = startCortex15Server({ index, writeToken, readToken, port, readMode: () => (++reads < 3 ? "ACTIVE" : "KILLED") });
    try {
      await waitHealth(200);
      reads = 0;
      const result = await request("/v1/documents", writeToken, { documents: [{ id: "doc-0002", text: "contratos empresas mercantil", landingPath: "/mercantil" }] });
      expect(result.status).toBe(503);
      const direct = await index.search("contratos", { topK: 5, minSemanticCoverage: 0 });
      expect(direct.hits).toHaveLength(0);
    } finally { await server.close(); index.close(); }
  });

  it("treats OBSERVE_ONLY as read-only for index mutations while still allowing search", async () => {
    const index = new SqliteSemanticSearchIndex(database(), null);
    let mode: Cortex15Mode = "ACTIVE";
    await index.upsertDocuments([{ id: "doc-0003", text: "asesoría contratos empresas", landingPath: "/empresas" }]);
    mode = "OBSERVE_ONLY";
    const server = startCortex15Server({ index, writeToken, readToken, port, readMode: () => mode });
    try {
      await waitHealth(200);
      expect((await request("/v1/documents", writeToken, { documents: [{ id: "doc-0004", text: "otro documento", landingPath: "/otro" }] })).status).toBe(503);
      const searched = await request("/v1/search", readToken, { query: "contratos", options: { topK: 5, minSemanticCoverage: 0 } });
      expect(searched.status).toBe(200);
      expect(searched.body).toMatchObject({ mode: "OBSERVE_ONLY", result: { hits: [{ id: "doc-0003" }] } });
    } finally { await server.close(); index.close(); }
  });
});

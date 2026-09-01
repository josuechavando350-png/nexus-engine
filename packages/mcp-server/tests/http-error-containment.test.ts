import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createNexusHttpApp } from "../src/http.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

async function start(app: ReturnType<typeof createNexusHttpApp>): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("authenticated MCP HTTP error containment", () => {
  it("does not disclose coordinator exception messages", async () => {
    const token = "error-containment-token";
    const app = createNexusHttpApp({
      root: process.cwd(),
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      git: async () => ({ branch: "work", headSha: "d".repeat(40), detached: false, clean: true, changedPaths: [], remoteUrl: null }),
      coordinator: { run: async () => { throw new Error("DATABASE_PASSWORD=super-secret"); } },
    });
    const base = await start(app);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("Internal server error");
    expect(body).not.toContain("DATABASE_PASSWORD");
    expect(body).not.toContain("super-secret");
  });

  it("does not disclose artifact-store exception messages", async () => {
    const token = "artifact-error-token";
    const app = createNexusHttpApp({
      root: process.cwd(),
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      artifactStore: {
        putFile: async () => { throw new Error("not used"); },
        manifest: async () => [],
        resolve: async () => { throw new Error("AWS_SECRET_ACCESS_KEY=super-secret"); },
      },
    });
    const base = await start(app);
    const response = await fetch(`${base}/artifacts/request-1/result.json`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("Internal server error");
    expect(body).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(body).not.toContain("super-secret");
  });

  it("does not disclose concurrency exception details", async () => {
    const token = "concurrency-error-token";
    const app = createNexusHttpApp({
      root: process.cwd(),
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      git: async () => ({ branch: "work", headSha: "e".repeat(40), detached: false, clean: true, changedPaths: [], remoteUrl: null }),
      limits: { maxConcurrency: 0, executionTimeoutMs: undefined, maxArtifactBytes: 1024, maxProcessOutputBytes: 1024 },
    });
    const base = await start(app);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
    });
    const body = await response.text();
    expect(response.status).toBe(429);
    expect(body).toContain("Concurrency limit reached");
    expect(body).not.toContain("maxConcurrency");
  });
});

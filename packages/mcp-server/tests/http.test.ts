import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createNexusHttpApp } from "../src/http.js";
import { TOOL_NAMES, type NexusToolName } from "../src/policy.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });

async function listen(enabledTools?: ReadonlySet<NexusToolName>) {
  const token = "mobile-safe-test-token";
  const writeToken = "mobile-safe-write-token";
  const app = createNexusHttpApp({
    root: process.cwd(), tokenSha256: createHash("sha256").update(token).digest("hex"), writeTokenSha256: createHash("sha256").update(writeToken).digest("hex"),
    git: async () => ({ branch: "work", headSha: "c".repeat(40), detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    projects: async () => [],
    enabledTools,
    coordinator: { run: async (_requestId, _sourceSha, _isolated, operation) => await operation(process.cwd()) },
  });
  const server = await new Promise<Server>((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return { token, writeToken, base: `http://127.0.0.1:${address.port}` };
}

describe("remote MCP HTTP surface", () => {
  it("rejects unauthenticated MCP requests but keeps health free of repository data", async () => {
    const { base } = await listen();
    const health = await fetch(`${base}/healthz`).then((response) => response.json());
    expect(health).toEqual({ status: "ok", service: "nexus-mcp-server", version: "0.1.0" });
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(response.status).toBe(401);
  });

  it("defaults remote exposure to status and projects only", async () => {
    const { base, token } = await listen();
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "nexus-mcp-test-client", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["nexus_projects", "nexus_status"]);
    const called = await client.callTool({ name: "nexus_projects", arguments: {} });
    expect((called.structuredContent as { status?: string }).status).toBe("PASS");
    await client.close();
  });

  it("exposes project creation only to the separate write token and rejects traversal at the MCP boundary", async () => {
    const { base, writeToken } = await listen(new Set(TOOL_NAMES));
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${writeToken}` } } });
    const client = new Client({ name: "nexus-mcp-write-test", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("nexus_project_new");
    const called = await client.callTool({ name: "nexus_project_new", arguments: { slug: "../escape" } });
    expect(called.isError).toBe(true);
    await client.close();
  });

  it("fails closed when read and write credential hashes are equal", () => {
    const digest = createHash("sha256").update("same-token").digest("hex");
    expect(() => createNexusHttpApp({ root: process.cwd(), tokenSha256: digest, writeTokenSha256: digest })).toThrow(/must be different/);
  });
});

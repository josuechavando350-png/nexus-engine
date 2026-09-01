import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createNexusHttpApp } from "../src/http.js";
import { TOOL_NAMES, type NexusToolName } from "../src/policy.js";

const servers: Server[] = [];
const OAUTH_RESOURCE = "https://nexus.example.test";
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });

async function start(app: ReturnType<typeof createNexusHttpApp>) {
  const server = await new Promise<Server>((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

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
  return { token, writeToken, base: await start(app) };
}

async function listenOAuth(scope: string, enabledTools?: ReadonlySet<NexusToolName>) {
  const token = `oauth-token-${scope.replace(/\s+/gu, "-")}`;
  const app = createNexusHttpApp({
    root: process.cwd(),
    oauth: {
      resource: OAUTH_RESOURCE,
      authorizationServers: ["https://auth.example.test"],
      introspection: { endpoint: "https://auth.example.test/oauth/introspect", clientId: "nexus-resource", clientSecret: "resource-secret" },
    },
    oauthFetch: async (_input, init) => {
      const body = String(init?.body ?? "");
      const suppliedToken = new URLSearchParams(body).get("token");
      return new Response(JSON.stringify({ active: suppliedToken === token, aud: OAUTH_RESOURCE, scope, exp: Math.floor(Date.now() / 1_000) + 300, sub: "chatgpt-operator" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    git: async () => ({ branch: "work", headSha: "c".repeat(40), detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    projects: async () => [],
    enabledTools,
    coordinator: { run: async (_requestId, _sourceSha, _isolated, operation) => await operation(process.cwd()) },
  });
  return { token, base: await start(app) };
}

describe("remote MCP HTTP surface", () => {
  it("rejects unauthenticated MCP requests but keeps health free of repository data", async () => {
    const { base } = await listen();
    const health = await fetch(`${base}/healthz`).then((response) => response.json());
    expect(health).toEqual({ status: "ok", service: "nexus-mcp-server", version: "0.1.0" });
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(response.status).toBe(401);
  });

  it("publishes OAuth protected-resource metadata and challenges unauthenticated ChatGPT clients", async () => {
    const { base } = await listenOAuth("nexus:read");
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`).then((response) => response.json());
    expect(metadata).toEqual({ resource: OAUTH_RESOURCE, authorization_servers: ["https://auth.example.test"], scopes_supported: ["nexus:read", "nexus:write"] });
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${OAUTH_RESOURCE}/.well-known/oauth-protected-resource", scope="nexus:read"`);
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

  it("accepts OAuth MCP sessions and grants mutation tools only with the write scope", async () => {
    const enabledTools = new Set<NexusToolName>(["nexus_projects", "nexus_project_new"]);
    const readOnly = await listenOAuth("nexus:read", enabledTools);
    const readTransport = new StreamableHTTPClientTransport(new URL(`${readOnly.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${readOnly.token}` } } });
    const readClient = new Client({ name: "nexus-mcp-oauth-read", version: "1.0.0" });
    await readClient.connect(readTransport);
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).toEqual(["nexus_projects"]);
    await readClient.close();

    const writable = await listenOAuth("nexus:read nexus:write", enabledTools);
    const writeTransport = new StreamableHTTPClientTransport(new URL(`${writable.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${writable.token}` } } });
    const writeClient = new Client({ name: "nexus-mcp-oauth-write", version: "1.0.0" });
    await writeClient.connect(writeTransport);
    expect((await writeClient.listTools()).tools.map((tool) => tool.name)).toContain("nexus_project_new");
    await writeClient.close();
  });

  it("exposes project creation only to the separate write token and rejects traversal at the MCP boundary", async () => {
    const writeSurface = new Set<NexusToolName>(TOOL_NAMES.filter((name) => name !== "nexus_operator"));
    const { base, writeToken } = await listen(writeSurface);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${writeToken}` } } });
    const client = new Client({ name: "nexus-mcp-write-test", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("nexus_project_new");
    const called = await client.callTool({ name: "nexus_project_new", arguments: { slug: "../escape" } });
    expect(called.isError).toBe(true);
    await client.close();
  });

  it("refuses to expose nexus_operator without a server-owned operator scope or runtime", () => {
    const tokenSha256 = createHash("sha256").update("operator-read-token").digest("hex");
    const enabledTools = new Set<NexusToolName>(["nexus_operator"]);
    expect(() => createNexusHttpApp({ root: process.cwd(), tokenSha256, enabledTools })).toThrow(/server-owned operator scope or runtime/);
  });

  it("fails closed when no authentication mode is configured", () => {
    expect(() => createNexusHttpApp({ root: process.cwd() })).toThrow(/requires shared-token or OAuth authentication/);
  });

  it("fails closed when read and write credential hashes are equal", () => {
    const digest = createHash("sha256").update("same-token").digest("hex");
    expect(() => createNexusHttpApp({ root: process.cwd(), tokenSha256: digest, writeTokenSha256: digest })).toThrow(/must be different/);
  });
});

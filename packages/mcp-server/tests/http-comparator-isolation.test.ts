import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { createNexusHttpApp } from "../src/http.js";
import type { NexusToolName } from "../src/policy.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

it("runs nexus_comparator in an isolated exact-SHA HTTP worktree", async () => {
  const token = "comparator-isolation-token";
  const sourceSha = "c".repeat(40);
  const isolatedCalls: boolean[] = [];
  const app = createNexusHttpApp({
    root: process.cwd(),
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    git: async () => ({ branch: "work", headSha: sourceSha, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    projects: async () => [],
    enabledTools: new Set<NexusToolName>(["nexus_comparator"]),
    coordinator: {
      run: async (_requestId, _sourceSha, isolated, operation) => {
        isolatedCalls.push(isolated);
        return await operation(process.cwd());
      },
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "comparator-isolation-test", version: "1.0.0" });
  await client.connect(transport);
  const callsBeforeComparator = isolatedCalls.length;
  await client.callTool({ name: "nexus_comparator", arguments: { target: "missing", sourceSha, baselineManifestPath: "evidence/missing.json" } });
  const comparatorCalls = isolatedCalls.slice(callsBeforeComparator);
  await client.close();

  expect(callsBeforeComparator).toBeGreaterThan(0);
  expect(comparatorCalls).toEqual([true]);
});

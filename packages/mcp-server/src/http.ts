import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNexusMcpServer } from "./mcp.js";
import type { ToolDependencies } from "./tools.js";
import { LocalArtifactStore, type ArtifactStore } from "./artifacts.js";
import { ConcurrencyLimitError, ExecutionCoordinator, type ExecutionRunner } from "./execution.js";
import { DEFAULT_EXECUTION_TIMEOUT_MS, DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_PROCESS_OUTPUT_BYTES, REMOTE_READINESS_DEFAULT_TOOLS, type NexusToolName, type RuntimeLimits } from "./policy.js";
import { readGitState } from "./git.js";

export interface HttpServerOptions extends ToolDependencies {
  tokenSha256: string;
  writeTokenSha256?: string;
  allowedHosts?: readonly string[];
  enabledTools?: ReadonlySet<NexusToolName>;
  limits?: RuntimeLimits;
  artifactStore?: ArtifactStore;
  coordinator?: ExecutionRunner;
}

function authorized(header: string | undefined, expectedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

export function createNexusHttpApp(options: HttpServerOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.tokenSha256)) throw new Error("NEXUS_MCP_TOKEN_SHA256 must be a lowercase SHA-256 digest");
  if (options.writeTokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.writeTokenSha256)) throw new Error("NEXUS_MCP_WRITE_TOKEN_SHA256 must be a lowercase SHA-256 digest");
  if (options.writeTokenSha256 === options.tokenSha256) throw new Error("read and write token hashes must be different");
  const limits = options.limits ?? { maxConcurrency: DEFAULT_MAX_CONCURRENCY, executionTimeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS, maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES, maxProcessOutputBytes: DEFAULT_MAX_PROCESS_OUTPUT_BYTES };
  const enabledTools = options.enabledTools ?? new Set<NexusToolName>(REMOTE_READINESS_DEFAULT_TOOLS);
  const localArtifactRoot = options.artifactRoot ?? join(options.root, ".artifacts", "mcp");
  const artifactStore = options.artifactStore ?? new LocalArtifactStore(localArtifactRoot, limits.maxArtifactBytes);
  const coordinator = options.coordinator ?? new ExecutionCoordinator(options.root, join(localArtifactRoot, "worktrees"), limits.maxConcurrency, limits.executionTimeoutMs, limits.maxProcessOutputBytes);
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [...(options.allowedHosts ?? ["localhost", "127.0.0.1"])] });
  app.get("/healthz", (_request: Request, response: Response) => response.json({ status: "ok", service: "nexus-mcp-server", version: "0.1.0" }));
  app.get("/artifacts/:requestId/:name", async (request: Request, response: Response) => {
    if (!authorized(request.header("authorization"), options.tokenSha256) && !(options.writeTokenSha256 && authorized(request.header("authorization"), options.writeTokenSha256))) { response.status(401).json({ error: "Unauthorized" }); return; }
    const requestId = Array.isArray(request.params.requestId) ? request.params.requestId[0] ?? "" : request.params.requestId ?? "";
    const requestedName = Array.isArray(request.params.name) ? request.params.name[0] ?? "" : request.params.name ?? "";
    const found = await artifactStore.resolve(requestId, requestedName);
    if (!found) { response.status(404).end(); return; }
    response.type(found.record.mediaType); response.setHeader("X-Nexus-SHA256", found.record.sha256); response.send(found.bytes);
  });
  app.all("/mcp", async (request: Request, response: Response) => {
    const writeAuthorized = options.writeTokenSha256 ? authorized(request.header("authorization"), options.writeTokenSha256) : false;
    if (!authorized(request.header("authorization"), options.tokenSha256) && !writeAuthorized) {
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    if (request.method !== "POST") {
      response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }
    const toolName = request.body?.method === "tools/call" && typeof request.body?.params?.name === "string" ? request.body.params.name as NexusToolName : null;
    const isolated = toolName !== null && new Set<NexusToolName>(["nexus_gates", "nexus_capture", "nexus_build", "nexus_project_new"]).has(toolName);
    const requestId = randomUUID();
    try {
      const git = await (options.git ?? readGitState)(options.root);
      await coordinator.run(requestId, git.headSha, isolated, async (root) => {
        const dependencies: ToolDependencies = { ...options, root, artifactRoot: localArtifactRoot, artifactStore, limits, requestId: () => requestId };
        const server = createNexusMcpServer(dependencies, { allowProjectWrite: writeAuthorized, enabledTools });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try { await server.connect(transport); await transport.handleRequest(request, response, request.body); }
        finally { await transport.close(); await server.close(); }
      });
    } catch (cause) {
      if (!response.headersSent) {
        if (cause instanceof ConcurrencyLimitError) response.status(429).json({ jsonrpc: "2.0", error: { code: -32002, message: cause.message }, id: request.body?.id ?? null });
        else response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: cause instanceof Error ? cause.message : "Internal server error" }, id: request.body?.id ?? null });
      }
    }
  });
  return app;
}

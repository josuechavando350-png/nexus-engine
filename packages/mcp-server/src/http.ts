import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNexusMcpServer } from "./mcp.js";
import { NEXUS_OPERATOR_AUTHORITY, NexusOperatorRuntime, operatorDigest, type OperatorScope } from "./operator-gateway.js";
import type { ToolDependencies } from "./tools.js";
import { LocalArtifactStore, type ArtifactStore } from "./artifacts.js";
import { ConcurrencyLimitError, ExecutionCoordinator, type ExecutionRunner } from "./execution.js";
import { DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_PROCESS_OUTPUT_BYTES, REMOTE_READINESS_DEFAULT_TOOLS, type NexusToolName, type RuntimeLimits } from "./policy.js";
import { OAUTH_PROTECTED_RESOURCE_PATH, prepareOAuthResourceServer, type OAuthFetch, type OAuthResourceServerConfig, type PreparedOAuthResourceServer } from "./oauth-resource.js";
import { readGitState } from "./git.js";

export interface HttpServerOptions extends ToolDependencies {
  tokenSha256?: string;
  writeTokenSha256?: string;
  oauth?: OAuthResourceServerConfig;
  oauthFetch?: OAuthFetch;
  allowedHosts?: readonly string[];
  enabledTools?: ReadonlySet<NexusToolName>;
  limits?: RuntimeLimits;
  artifactStore?: ArtifactStore;
  coordinator?: ExecutionRunner;
  operatorScope?: OperatorScope;
  operatorRuntime?: NexusOperatorRuntime;
}

interface RequestAuthorization {
  readonly authenticated: true;
  readonly writeAuthorized: boolean;
  readonly channel: "MCP_SHARED_TOKEN" | "MCP_OAUTH";
  readonly subject: string | null;
}

function authorized(header: string | undefined, expectedHex: string | undefined): boolean {
  if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

async function requestAuthorization(header: string | undefined, readTokenSha256: string | undefined, writeTokenSha256: string | undefined, oauth: PreparedOAuthResourceServer | undefined): Promise<RequestAuthorization | null> {
  const legacyWrite = authorized(header, writeTokenSha256);
  if (legacyWrite || authorized(header, readTokenSha256)) return Object.freeze({ authenticated: true as const, writeAuthorized: legacyWrite, channel: "MCP_SHARED_TOKEN" as const, subject: null });
  const oauthAuthorization = oauth ? await oauth.authorize(header) : null;
  if (!oauthAuthorization) return null;
  return Object.freeze({ authenticated: true as const, writeAuthorized: oauthAuthorization.writeAuthorized, channel: "MCP_OAUTH" as const, subject: oauthAuthorization.subject });
}

function rejectUnauthorized(response: Response, oauth: PreparedOAuthResourceServer | undefined, scope?: string): void {
  if (oauth) response.setHeader("WWW-Authenticate", oauth.challenge(scope));
  response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

export function createNexusHttpApp(options: HttpServerOptions) {
  if (options.tokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.tokenSha256)) throw new Error("NEXUS_MCP_TOKEN_SHA256 must be a lowercase SHA-256 digest");
  if (options.writeTokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.writeTokenSha256)) throw new Error("NEXUS_MCP_WRITE_TOKEN_SHA256 must be a lowercase SHA-256 digest");
  if (options.tokenSha256 !== undefined && options.writeTokenSha256 === options.tokenSha256) throw new Error("read and write token hashes must be different");
  const oauth = options.oauth ? prepareOAuthResourceServer(options.oauth, options.oauthFetch) : undefined;
  if (!options.tokenSha256 && !options.writeTokenSha256 && !oauth) throw new Error("NEXUS MCP requires shared-token or OAuth authentication");
  const limits = options.limits ?? { maxConcurrency: DEFAULT_MAX_CONCURRENCY, executionTimeoutMs: undefined, maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES, maxProcessOutputBytes: DEFAULT_MAX_PROCESS_OUTPUT_BYTES };
  const enabledTools = options.enabledTools ?? new Set<NexusToolName>(REMOTE_READINESS_DEFAULT_TOOLS);
  if (enabledTools.has("nexus_operator") && !options.operatorRuntime && !options.operatorScope) throw new Error("nexus_operator requires a server-owned operator scope or runtime");
  const operatorRuntime = options.operatorRuntime ?? (options.operatorScope ? new NexusOperatorRuntime(options.operatorScope) : undefined);
  const localArtifactRoot = options.artifactRoot ?? join(options.root, ".artifacts", "mcp");
  const artifactStore = options.artifactStore ?? new LocalArtifactStore(localArtifactRoot, limits.maxArtifactBytes);
  const coordinator = options.coordinator ?? new ExecutionCoordinator(options.root, join(localArtifactRoot, "worktrees"), limits.maxConcurrency, limits.executionTimeoutMs, limits.maxProcessOutputBytes);
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [...(options.allowedHosts ?? ["localhost", "127.0.0.1"])] });
  app.get("/healthz", (_request: Request, response: Response) => response.json({ status: "ok", service: "nexus-mcp-server", version: "0.1.0" }));
  if (oauth) app.get(OAUTH_PROTECTED_RESOURCE_PATH, (_request: Request, response: Response) => response.json(oauth.protectedResourceMetadata()));
  app.get("/artifacts/:requestId/:name", async (request: Request, response: Response) => {
    const auth = await requestAuthorization(request.header("authorization"), options.tokenSha256, options.writeTokenSha256, oauth);
    if (!auth) { rejectUnauthorized(response, oauth); return; }
    const requestId = Array.isArray(request.params.requestId) ? request.params.requestId[0] ?? "" : request.params.requestId ?? "";
    const requestedName = Array.isArray(request.params.name) ? request.params.name[0] ?? "" : request.params.name ?? "";
    try {
      const found = await artifactStore.resolve(requestId, requestedName);
      if (!found) { response.status(404).end(); return; }
      response.type(found.record.mediaType); response.setHeader("X-Nexus-SHA256", found.record.sha256); response.send(found.bytes);
    } catch {
      response.status(500).json({ error: "Internal server error" });
    }
  });
  app.all("/mcp", async (request: Request, response: Response) => {
    const auth = await requestAuthorization(request.header("authorization"), options.tokenSha256, options.writeTokenSha256, oauth);
    if (!auth) { rejectUnauthorized(response, oauth); return; }
    if (request.method !== "POST") {
      response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }
    const toolName = request.body?.method === "tools/call" && typeof request.body?.params?.name === "string" ? request.body.params.name as NexusToolName : null;
    const isolated = toolName !== null && new Set<NexusToolName>(["nexus_gates", "nexus_capture", "nexus_build", "nexus_project_new", "nexus_operator"]).has(toolName);
    const requestId = randomUUID();
    try {
      const git = await (options.git ?? readGitState)(options.root);
      await coordinator.run(requestId, git.headSha, isolated, async (root) => {
        const dependencies: ToolDependencies = { ...options, root, artifactRoot: localArtifactRoot, artifactStore, limits, requestId: () => requestId };
        const authorizationDurationMs = Math.min(limits.executionTimeoutMs ?? 900_000, 900_000);
        const authorizationExpiresAt = new Date(Date.now() + authorizationDurationMs).toISOString();
        const mutationApproval = auth.writeAuthorized ? Object.freeze({
          status: "APPROVED" as const,
          expiresAt: authorizationExpiresAt,
          evidenceDigest: operatorDigest({ channel: auth.channel, requestId, repository: dependencies.repository ?? "josuechavando350-png/nexus-engine", subject: auth.subject }),
        }) : undefined;
        const server = createNexusMcpServer(dependencies, {
          allowProjectWrite: auth.writeAuthorized,
          enabledTools,
          operatorRuntime,
          operatorContext: operatorRuntime ? Object.freeze({
            authority: NEXUS_OPERATOR_AUTHORITY,
            authenticated: true as const,
            writeAuthorized: auth.writeAuthorized,
            authorizationExpiresAt,
            enabledTools,
            ...(mutationApproval ? { mutationApproval } : {}),
          }) : undefined,
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try { await server.connect(transport); await transport.handleRequest(request, response, request.body); }
        finally { await transport.close(); await server.close(); }
      });
    } catch (cause) {
      if (!response.headersSent) {
        if (cause instanceof ConcurrencyLimitError) response.status(429).json({ jsonrpc: "2.0", error: { code: -32002, message: "Concurrency limit reached" }, id: request.body?.id ?? null });
        else response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: request.body?.id ?? null });
      }
    }
  });
  return app;
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNexusMcpServer } from "./mcp.js";
import type { ToolDependencies } from "./tools.js";

export interface HttpServerOptions extends ToolDependencies { tokenSha256: string; writeTokenSha256?: string; allowedHosts?: readonly string[] }

function authorized(header: string | undefined, expectedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

export function createNexusHttpApp(options: HttpServerOptions) {
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [...(options.allowedHosts ?? ["localhost", "127.0.0.1"])] });
  app.get("/healthz", (_request: Request, response: Response) => response.json({ status: "ok", service: "nexus-mcp-server", version: "0.1.0" }));
  app.get("/artifacts/:requestId/:name", async (request: Request, response: Response) => {
    if (!authorized(request.header("authorization"), options.tokenSha256) && !(options.writeTokenSha256 && authorized(request.header("authorization"), options.writeTokenSha256))) { response.status(401).json({ error: "Unauthorized" }); return; }
    const artifactRoot = resolve(options.artifactRoot ?? join(options.root, ".artifacts", "mcp"));
    const requestId = Array.isArray(request.params.requestId) ? request.params.requestId[0] ?? "" : request.params.requestId ?? "";
    const requestedName = Array.isArray(request.params.name) ? request.params.name[0] ?? "" : request.params.name ?? "";
    const path = resolve(artifactRoot, requestId, basename(requestedName));
    if (!path.startsWith(`${artifactRoot}${sep}`)) { response.status(404).end(); return; }
    try { if (!(await stat(path)).isFile()) { response.status(404).end(); return; } } catch { response.status(404).end(); return; }
    response.type("image/png"); createReadStream(path).pipe(response);
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
    const server = createNexusMcpServer(options, { allowProjectWrite: writeAuthorized });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    } finally {
      await transport.close();
      await server.close();
    }
  });
  return app;
}

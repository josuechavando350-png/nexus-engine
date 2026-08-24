#!/usr/bin/env node
import { createNexusHttpApp } from "./http.js";

const tokenSha256 = process.env.NEXUS_MCP_TOKEN_SHA256;
if (!tokenSha256) throw new Error("NEXUS_MCP_TOKEN_SHA256 is required");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer in 1..65535");
const allowedHosts = (process.env.NEXUS_MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1").split(",").map((value) => value.trim()).filter(Boolean);
if (allowedHosts.length === 0) throw new Error("NEXUS_MCP_ALLOWED_HOSTS must contain at least one hostname");
const app = createNexusHttpApp({ allowedHosts, artifactRoot: process.env.NEXUS_MCP_ARTIFACT_ROOT, root: process.env.NEXUS_REPOSITORY_ROOT ?? process.cwd(), repository: process.env.NEXUS_GITHUB_REPOSITORY, githubToken: process.env.NEXUS_GITHUB_TOKEN, tokenSha256, writeTokenSha256: process.env.NEXUS_MCP_WRITE_TOKEN_SHA256 });
app.listen(port, "0.0.0.0", (error?: Error) => {
  if (error) throw error;
  process.stdout.write(`NEXUS MCP server listening on port ${port}\n`);
});

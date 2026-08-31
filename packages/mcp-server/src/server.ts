#!/usr/bin/env node
import { createNexusHttpApp } from "./http.js";
import { enabledToolsFromEnv, runtimeLimitsFromEnv } from "./policy.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when nexus_operator is enabled`);
  return value;
}

const tokenSha256 = process.env.NEXUS_MCP_TOKEN_SHA256;
if (!tokenSha256) throw new Error("NEXUS_MCP_TOKEN_SHA256 is required");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer in 1..65535");
const allowedHosts = (process.env.NEXUS_MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1").split(",").map((value) => value.trim()).filter(Boolean);
if (allowedHosts.length === 0) throw new Error("NEXUS_MCP_ALLOWED_HOSTS must contain at least one hostname");
const enabledTools = enabledToolsFromEnv();
const repository = process.env.NEXUS_GITHUB_REPOSITORY ?? "josuechavando350-png/nexus-engine";
const operatorScope = enabledTools.has("nexus_operator") ? {
  tenantId: requiredEnvironment("NEXUS_OPERATOR_TENANT_ID"),
  organizationId: requiredEnvironment("NEXUS_OPERATOR_ORGANIZATION_ID"),
  brandId: requiredEnvironment("NEXUS_OPERATOR_BRAND_ID"),
  repository,
} : undefined;
const app = createNexusHttpApp({
  allowedHosts,
  artifactRoot: process.env.NEXUS_MCP_ARTIFACT_ROOT,
  root: process.env.NEXUS_REPOSITORY_ROOT ?? process.cwd(),
  repository,
  githubToken: process.env.NEXUS_GITHUB_TOKEN,
  tokenSha256,
  writeTokenSha256: process.env.NEXUS_MCP_WRITE_TOKEN_SHA256,
  enabledTools,
  limits: runtimeLimitsFromEnv(),
  operatorScope,
});
app.listen(port, "0.0.0.0", (error?: Error) => {
  if (error) throw error;
  process.stdout.write(`NEXUS MCP server listening on port ${port}\n`);
});

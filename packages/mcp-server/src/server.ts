#!/usr/bin/env node
import { createNexusHttpApp } from "./http.js";
import { enabledToolsFromEnv, runtimeLimitsFromEnv } from "./policy.js";
import type { OAuthResourceServerConfig } from "./oauth-resource.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function oauthFromEnvironment(): OAuthResourceServerConfig | undefined {
  const resource = process.env.NEXUS_MCP_OAUTH_RESOURCE?.trim();
  const oauthNames = [
    "NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS",
    "NEXUS_MCP_OAUTH_INTROSPECTION_ENDPOINT",
    "NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_ID",
    "NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET",
    "NEXUS_MCP_OAUTH_READ_SCOPE",
    "NEXUS_MCP_OAUTH_WRITE_SCOPE",
    "NEXUS_MCP_OAUTH_RESOURCE_DOCUMENTATION",
  ] as const;
  const hasOtherOAuthSetting = oauthNames.some((name) => Boolean(process.env[name]?.trim()));
  if (!resource && hasOtherOAuthSetting) throw new Error("NEXUS_MCP_OAUTH_RESOURCE is required when OAuth settings are present");
  if (!resource) return undefined;
  const authorizationServers = requiredEnvironment("NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS").split(",").map((value) => value.trim()).filter(Boolean);
  return Object.freeze({
    resource,
    authorizationServers,
    readScope: process.env.NEXUS_MCP_OAUTH_READ_SCOPE?.trim() || undefined,
    writeScope: process.env.NEXUS_MCP_OAUTH_WRITE_SCOPE?.trim() || undefined,
    resourceDocumentation: process.env.NEXUS_MCP_OAUTH_RESOURCE_DOCUMENTATION?.trim() || undefined,
    introspection: Object.freeze({
      endpoint: requiredEnvironment("NEXUS_MCP_OAUTH_INTROSPECTION_ENDPOINT"),
      clientId: requiredEnvironment("NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_ID"),
      clientSecret: requiredEnvironment("NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET"),
    }),
  });
}

const tokenSha256 = process.env.NEXUS_MCP_TOKEN_SHA256?.trim() || undefined;
const writeTokenSha256 = process.env.NEXUS_MCP_WRITE_TOKEN_SHA256?.trim() || undefined;
const oauth = oauthFromEnvironment();
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer in 1..65535");
const defaultAllowedHosts = oauth ? [new URL(oauth.resource).hostname] : ["localhost", "127.0.0.1"];
const allowedHosts = (process.env.NEXUS_MCP_ALLOWED_HOSTS ? process.env.NEXUS_MCP_ALLOWED_HOSTS.split(",") : defaultAllowedHosts).map((value) => value.trim()).filter(Boolean);
if (allowedHosts.length === 0) throw new Error("NEXUS_MCP_ALLOWED_HOSTS must contain at least one hostname");
if (oauth && !allowedHosts.includes(new URL(oauth.resource).hostname)) throw new Error("NEXUS_MCP_ALLOWED_HOSTS must include the OAuth resource hostname");
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
  writeTokenSha256,
  oauth,
  enabledTools,
  limits: runtimeLimitsFromEnv(),
  operatorScope,
});
app.listen(port, "0.0.0.0", (error?: Error) => {
  if (error) throw error;
  process.stdout.write(`NEXUS MCP server listening on port ${port}\n`);
});

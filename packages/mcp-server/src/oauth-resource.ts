import { Buffer } from "node:buffer";

export const NEXUS_MCP_OAUTH_READ_SCOPE = "nexus:read" as const;
export const NEXUS_MCP_OAUTH_WRITE_SCOPE = "nexus:write" as const;
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource" as const;

export interface OAuthIntrospectionConfig {
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OAuthResourceServerConfig {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly readScope?: string;
  readonly writeScope?: string;
  readonly resourceDocumentation?: string;
  readonly introspection: OAuthIntrospectionConfig;
}

export interface OAuthAuthorization {
  readonly authenticated: true;
  readonly writeAuthorized: boolean;
  readonly scopes: readonly string[];
  readonly subject: string | null;
}

export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function httpsUrl(value: string, name: string, originOnly = false): string {
  const candidate = value.trim();
  let parsed: URL;
  try { parsed = new URL(candidate); }
  catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${name} must not contain credentials, query, or fragment`);
  if (originOnly && parsed.pathname !== "/") throw new Error(`${name} must be a canonical HTTPS origin`);
  return originOnly ? parsed.origin : candidate;
}

function scopeName(value: string | undefined, fallback: string, name: string): string {
  const scope = value ?? fallback;
  if (!/^[A-Za-z0-9._~:/-]{1,128}$/u.test(scope)) throw new Error(`${name} is invalid`);
  return scope;
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (token.length < 1 || token.length > 8_192 || /\s/u.test(token)) return null;
  return token;
}

function scopesFrom(value: unknown): readonly string[] {
  const raw = typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean)
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : [];
  return Object.freeze([...new Set(raw)]);
}

function audienceIncludes(value: unknown, resource: string): boolean {
  if (typeof value === "string") return value === resource;
  return Array.isArray(value) && value.some((entry) => entry === resource);
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function clientSecretBasic(clientId: string, clientSecret: string): string {
  return Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, "utf8").toString("base64");
}

export interface PreparedOAuthResourceServer {
  readonly resource: string;
  readonly metadataUrl: string;
  readonly authorizationServers: readonly string[];
  readonly readScope: string;
  readonly writeScope: string;
  readonly resourceDocumentation?: string;
  readonly authorize: (authorizationHeader: string | undefined) => Promise<OAuthAuthorization | null>;
  readonly protectedResourceMetadata: () => Readonly<Record<string, unknown>>;
  readonly challenge: (scope?: string) => string;
}

export function prepareOAuthResourceServer(config: OAuthResourceServerConfig, fetchImpl: OAuthFetch = fetch): PreparedOAuthResourceServer {
  const resource = httpsUrl(config.resource, "NEXUS_MCP_OAUTH_RESOURCE", true);
  if (!Array.isArray(config.authorizationServers) || config.authorizationServers.length < 1 || config.authorizationServers.length > 8) throw new Error("NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS must contain 1..8 issuers");
  const authorizationServers = Object.freeze(config.authorizationServers.map((value) => httpsUrl(value, "NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS")));
  if (new Set(authorizationServers).size !== authorizationServers.length) throw new Error("NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS must be unique");
  const introspectionEndpoint = httpsUrl(config.introspection.endpoint, "NEXUS_MCP_OAUTH_INTROSPECTION_ENDPOINT");
  if (!config.introspection.clientId || config.introspection.clientId.length > 512) throw new Error("NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_ID is required and bounded");
  if (!config.introspection.clientSecret || config.introspection.clientSecret.length > 4_096) throw new Error("NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET is required and bounded");
  const readScope = scopeName(config.readScope, NEXUS_MCP_OAUTH_READ_SCOPE, "NEXUS_MCP_OAUTH_READ_SCOPE");
  const writeScope = scopeName(config.writeScope, NEXUS_MCP_OAUTH_WRITE_SCOPE, "NEXUS_MCP_OAUTH_WRITE_SCOPE");
  if (readScope === writeScope) throw new Error("OAuth read and write scopes must be different");
  const resourceDocumentation = config.resourceDocumentation === undefined ? undefined : httpsUrl(config.resourceDocumentation, "NEXUS_MCP_OAUTH_RESOURCE_DOCUMENTATION");
  const metadataUrl = `${resource}${OAUTH_PROTECTED_RESOURCE_PATH}`;
  const basic = clientSecretBasic(config.introspection.clientId, config.introspection.clientSecret);

  async function authorize(authorizationHeader: string | undefined): Promise<OAuthAuthorization | null> {
    const token = bearerToken(authorizationHeader);
    if (!token) return null;
    let response: Response;
    try {
      response = await fetchImpl(introspectionEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
        redirect: "error",
      });
    } catch { return null; }
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 65_536) return null;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      payload = parsed as Record<string, unknown>;
    } catch { return null; }
    if (payload.active !== true || !audienceIncludes(payload.aud, resource)) return null;
    if (typeof payload.exp === "number" && (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1_000))) return null;
    const scopes = scopesFrom(payload.scope);
    if (!scopes.includes(readScope)) return null;
    return Object.freeze({
      authenticated: true as const,
      writeAuthorized: scopes.includes(writeScope),
      scopes,
      subject: typeof payload.sub === "string" && payload.sub.length <= 512 ? payload.sub : null,
    });
  }

  return Object.freeze({
    resource,
    metadataUrl,
    authorizationServers,
    readScope,
    writeScope,
    ...(resourceDocumentation ? { resourceDocumentation } : {}),
    authorize,
    protectedResourceMetadata: () => Object.freeze({
      resource,
      authorization_servers: authorizationServers,
      scopes_supported: Object.freeze([readScope, writeScope]),
      ...(resourceDocumentation ? { resource_documentation: resourceDocumentation } : {}),
    }),
    challenge: (scope = readScope) => `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`,
  });
}

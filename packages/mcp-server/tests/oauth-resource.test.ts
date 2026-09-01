import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { prepareOAuthResourceServer, type OAuthFetch } from "../src/oauth-resource.js";

const RESOURCE = "https://nexus.example.test";
const BASE_CONFIG = Object.freeze({
  resource: RESOURCE,
  authorizationServers: ["https://auth.example.test"],
  introspection: {
    endpoint: "https://auth.example.test/oauth/introspect",
    clientId: "nexus-resource-server",
    clientSecret: "server-secret",
  },
});

function introspection(payload: Record<string, unknown>, observe?: (init: RequestInit | undefined) => void): OAuthFetch {
  return async (_input, init) => {
    observe?.(init);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("OAuth protected resource", () => {
  it("publishes RFC 9728 metadata and a ChatGPT-discoverable challenge", () => {
    const oauth = prepareOAuthResourceServer(BASE_CONFIG, introspection({ active: false }));
    expect(oauth.protectedResourceMetadata()).toEqual({
      resource: RESOURCE,
      authorization_servers: ["https://auth.example.test"],
      scopes_supported: ["nexus:read", "nexus:write"],
    });
    expect(oauth.challenge()).toBe(`Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", scope="nexus:read"`);
  });

  it("accepts only active, resource-bound, non-expired tokens with the read scope", async () => {
    let observed: RequestInit | undefined;
    const oauth = prepareOAuthResourceServer(BASE_CONFIG, introspection({
      active: true,
      aud: RESOURCE,
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "nexus:read nexus:write",
      sub: "operator-owner",
    }, (init) => { observed = init; }));
    const authorization = await oauth.authorize("Bearer oauth-access-token");
    expect(authorization).toEqual({ authenticated: true, writeAuthorized: true, scopes: ["nexus:read", "nexus:write"], subject: "operator-owner" });
    expect(observed?.method).toBe("POST");
    expect(new Headers(observed?.headers).get("authorization")).toMatch(/^Basic /u);
    expect(String(observed?.body)).toContain("token=oauth-access-token");
  });

  it("form-encodes reserved client credentials before client_secret_basic authentication", async () => {
    let authorizationHeader: string | null = null;
    const oauth = prepareOAuthResourceServer({
      ...BASE_CONFIG,
      introspection: { ...BASE_CONFIG.introspection, clientId: "client:id a", clientSecret: "s:e/cret +%" },
    }, introspection({ active: true, aud: RESOURCE, scope: "nexus:read" }, (init) => {
      authorizationHeader = new Headers(init?.headers).get("authorization");
    }));
    await expect(oauth.authorize("Bearer encoded-client-test")).resolves.toMatchObject({ authenticated: true });
    expect(authorizationHeader).toMatch(/^Basic /u);
    const decoded = Buffer.from(authorizationHeader!.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("client%3Aid+a:s%3Ae%2Fcret+%2B%25");
  });

  it("rejects active tokens for another audience or without the required read scope", async () => {
    const wrongAudience = prepareOAuthResourceServer(BASE_CONFIG, introspection({ active: true, aud: "https://other.example.test", scope: "nexus:read" }));
    await expect(wrongAudience.authorize("Bearer token-one")).resolves.toBeNull();
    const missingScope = prepareOAuthResourceServer(BASE_CONFIG, introspection({ active: true, aud: RESOURCE, scope: "profile" }));
    await expect(missingScope.authorize("Bearer token-two")).resolves.toBeNull();
  });

  it("fails closed on expired tokens, failed introspection, and insecure configuration", async () => {
    const expired = prepareOAuthResourceServer(BASE_CONFIG, introspection({ active: true, aud: RESOURCE, exp: Math.floor(Date.now() / 1_000) - 1, scope: "nexus:read" }));
    await expect(expired.authorize("Bearer expired")).resolves.toBeNull();
    const networkFailure = prepareOAuthResourceServer(BASE_CONFIG, async () => { throw new Error("network down"); });
    await expect(networkFailure.authorize("Bearer unavailable")).resolves.toBeNull();
    expect(() => prepareOAuthResourceServer({ ...BASE_CONFIG, resource: "http://nexus.example.test" }, introspection({ active: true }))).toThrow(/HTTPS/u);
  });
});

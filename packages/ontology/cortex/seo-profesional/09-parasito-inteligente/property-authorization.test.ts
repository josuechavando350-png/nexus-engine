import { describe, expect, it, vi } from "vitest";
import {
  DnsTxtProgrammaticPropertyAuthorizer,
  createDnsTxtProgrammaticAuthorizationToken,
  type DnsTxtResolverPort,
  type ProgrammaticAuthorizationKeyProvider,
} from "./property-authorization.js";

const NOW = Date.parse("2026-09-08T20:45:00.000Z");
const KEY = new Uint8Array(32).fill(7);

function keyProvider(): ProgrammaticAuthorizationKeyProvider {
  return { getKey: vi.fn(async () => KEY) };
}

function resolver(records: readonly (readonly string[])[]): DnsTxtResolverPort {
  return { resolveTxt: vi.fn(async () => records) };
}

describe("DnsTxtProgrammaticPropertyAuthorizer", () => {
  it("accepts the canonical first-party origin without DNS or key access", async () => {
    const key = keyProvider();
    const dns = resolver([]);
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", key, dns, () => NOW);
    await expect(authorizer.verify({ siteId: "site-main", propertyBaseUrl: "https://example.test/guides/", operatorWebsiteOrigin: "https://example.test" }))
      .resolves.toMatchObject({ kind: "FIRST_PARTY_CANONICAL_ORIGIN", propertyBaseUrl: "https://example.test/guides/", propertyOrigin: "https://example.test", expiresAt: null });
    expect(key.getKey).not.toHaveBeenCalled();
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it("accepts a short-lived signed DNS delegation scoped to the exact external base path", async () => {
    const token = createDnsTxtProgrammaticAuthorizationToken({
      v: 1,
      siteId: "site-client",
      propertyBaseUrl: "https://client.example/catalog/",
      operatorWebsiteOrigin: "https://example.test",
      issuedAt: "2026-09-08T20:40:00.000Z",
      expiresAt: "2026-09-15T20:40:00.000Z",
    }, KEY);
    const dns = resolver([[token.slice(0, 30), token.slice(30)]]);
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", keyProvider(), dns, () => NOW);
    await expect(authorizer.verify({ siteId: "site-client", propertyBaseUrl: "https://client.example/catalog/", operatorWebsiteOrigin: "https://example.test" }))
      .resolves.toMatchObject({ kind: "DNS_TXT_DELEGATION", propertyBaseUrl: "https://client.example/catalog/", dnsName: "_nexus-pseo.client.example", expiresAt: "2026-09-15T20:40:00.000Z" });
    expect(dns.resolveTxt).toHaveBeenCalledWith("_nexus-pseo.client.example");
  });

  it("rejects reusing a valid delegation for another base path on the same host", async () => {
    const token = createDnsTxtProgrammaticAuthorizationToken({
      v: 1,
      siteId: "site-client",
      propertyBaseUrl: "https://client.example/catalog/",
      operatorWebsiteOrigin: "https://example.test",
      issuedAt: "2026-09-08T20:40:00.000Z",
      expiresAt: "2026-09-15T20:40:00.000Z",
    }, KEY);
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", keyProvider(), resolver([[token]]), () => NOW);
    await expect(authorizer.verify({ siteId: "site-client", propertyBaseUrl: "https://client.example/news/", operatorWebsiteOrigin: "https://example.test" }))
      .rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
  });

  it("rejects expired delegation even when the signature is authentic", async () => {
    const token = createDnsTxtProgrammaticAuthorizationToken({
      v: 1,
      siteId: "site-client",
      propertyBaseUrl: "https://client.example/",
      operatorWebsiteOrigin: "https://example.test",
      issuedAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, KEY);
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", keyProvider(), resolver([[token]]), () => NOW);
    await expect(authorizer.verify({ siteId: "site-client", propertyBaseUrl: "https://client.example/", operatorWebsiteOrigin: "https://example.test" }))
      .rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  });

  it("rejects a token bound to a different siteId", async () => {
    const token = createDnsTxtProgrammaticAuthorizationToken({
      v: 1,
      siteId: "site-other",
      propertyBaseUrl: "https://client.example/",
      operatorWebsiteOrigin: "https://example.test",
      issuedAt: "2026-09-08T20:40:00.000Z",
      expiresAt: "2026-09-15T20:40:00.000Z",
    }, KEY);
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", keyProvider(), resolver([[token]]), () => NOW);
    await expect(authorizer.verify({ siteId: "site-client", propertyBaseUrl: "https://client.example/", operatorWebsiteOrigin: "https://example.test" }))
      .rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
  });

  it("fails closed when delegated authorization DNS is unavailable", async () => {
    const dns: DnsTxtResolverPort = { resolveTxt: vi.fn(async () => { throw new Error("dns unavailable"); }) };
    const authorizer = new DnsTxtProgrammaticPropertyAuthorizer("https://example.test", keyProvider(), dns, () => NOW);
    await expect(authorizer.verify({ siteId: "site-client", propertyBaseUrl: "https://client.example/", operatorWebsiteOrigin: "https://example.test" }))
      .rejects.toMatchObject({ code: "AUTHORIZATION_UNAVAILABLE" });
  });
});

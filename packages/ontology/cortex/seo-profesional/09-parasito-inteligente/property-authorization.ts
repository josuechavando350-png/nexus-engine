import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

export const PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY = "seo9-property-authorization-v1" as const;
const TOKEN_PREFIX = "nexus-pseo-v1=";
const SITE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_AUTHORIZATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class ProgrammaticPropertyAuthorizationError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "AUTHORIZATION_REQUIRED" | "AUTHORIZATION_INVALID" | "AUTHORIZATION_EXPIRED" | "AUTHORIZATION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ProgrammaticPropertyAuthorizationError";
  }
}

export interface ProgrammaticPropertyAuthorizationRequest {
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly operatorWebsiteOrigin: string;
}

export interface ProgrammaticPropertyAuthorizationEvidence {
  readonly kind: "FIRST_PARTY_CANONICAL_ORIGIN" | "DNS_TXT_DELEGATION";
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly propertyOrigin: string;
  readonly operatorWebsiteOrigin: string;
  readonly verifiedAt: string;
  readonly expiresAt: string | null;
  readonly dnsName: string | null;
  readonly proofDigest: string;
  readonly policyVersion: typeof PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY;
}

export interface ProgrammaticPropertyAuthorizationPort {
  verify(input: ProgrammaticPropertyAuthorizationRequest): Promise<ProgrammaticPropertyAuthorizationEvidence>;
}

export interface ProgrammaticAuthorizationKeyProvider {
  getKey(siteId: string): Promise<Uint8Array>;
}

export interface DnsTxtResolverPort {
  resolveTxt(name: string): Promise<readonly (readonly string[])[]>;
}

export interface DnsTxtProgrammaticAuthorizationPayload {
  readonly v: 1;
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly operatorWebsiteOrigin: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function canonicalUtc(value: string, field: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", `${field} must be canonical UTC`);
  }
  return parsed.getTime();
}

export function normalizeProgrammaticPropertyBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "propertyBaseUrl must be absolute"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) {
    throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "propertyBaseUrl must be clean HTTPS on the default port");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url.toString();
}

export function normalizeProgrammaticOperatorOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "operatorWebsiteOrigin must be absolute"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || url.pathname !== "/") {
    throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

function siteId(value: string): string {
  const normalized = value.trim();
  if (!SITE_ID.test(normalized)) throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "siteId is malformed");
  return normalized;
}

function keyBytes(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) {
    throw new ProgrammaticPropertyAuthorizationError("INVALID_CONFIG", "programmatic property authorization key must contain 32..128 bytes");
  }
  return Buffer.from(key);
}

function canonicalPayload(input: DnsTxtProgrammaticAuthorizationPayload): DnsTxtProgrammaticAuthorizationPayload {
  if (input.v !== 1) throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "authorization token version must be 1");
  const normalizedSiteId = siteId(input.siteId);
  const propertyBaseUrl = normalizeProgrammaticPropertyBaseUrl(input.propertyBaseUrl);
  const operatorWebsiteOrigin = normalizeProgrammaticOperatorOrigin(input.operatorWebsiteOrigin);
  const issuedMs = canonicalUtc(input.issuedAt, "issuedAt");
  const expiresMs = canonicalUtc(input.expiresAt, "expiresAt");
  if (expiresMs <= issuedMs || expiresMs - issuedMs > MAX_AUTHORIZATION_LIFETIME_MS) {
    throw new ProgrammaticPropertyAuthorizationError("INVALID_INPUT", "authorization token lifetime must be positive and no longer than 30 days");
  }
  return Object.freeze({ v: 1, siteId: normalizedSiteId, propertyBaseUrl, operatorWebsiteOrigin, issuedAt: input.issuedAt, expiresAt: input.expiresAt });
}

function encodePayload(payload: DnsTxtProgrammaticAuthorizationPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signature(encodedPayload: string, key: Uint8Array): string {
  return createHmac("sha256", keyBytes(key)).update(encodedPayload, "utf8").digest("base64url");
}

export function createDnsTxtProgrammaticAuthorizationToken(input: DnsTxtProgrammaticAuthorizationPayload, key: Uint8Array): string {
  const payload = canonicalPayload(input);
  const encoded = encodePayload(payload);
  return `${TOKEN_PREFIX}${encoded}.${signature(encoded, key)}`;
}

function parseToken(record: string): Readonly<{ encoded: string; signature: string; payload: DnsTxtProgrammaticAuthorizationPayload }> | null {
  if (!record.startsWith(TOKEN_PREFIX) || record.length > 4096) return null;
  const value = record.slice(TOKEN_PREFIX.length);
  const split = value.lastIndexOf(".");
  if (split <= 0) return null;
  const encoded = value.slice(0, split);
  const suppliedSignature = value.slice(split + 1);
  if (!/^[A-Za-z0-9_-]{8,3000}$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.siteId !== "string" || typeof raw.propertyBaseUrl !== "string" || typeof raw.operatorWebsiteOrigin !== "string" || typeof raw.issuedAt !== "string" || typeof raw.expiresAt !== "string") return null;
  try {
    return Object.freeze({
      encoded,
      signature: suppliedSignature,
      payload: canonicalPayload({ v: 1, siteId: raw.siteId, propertyBaseUrl: raw.propertyBaseUrl, operatorWebsiteOrigin: raw.operatorWebsiteOrigin, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt }),
    });
  } catch {
    return null;
  }
}

function equalSignature(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, "ascii");
  const right = Buffer.from(supplied, "ascii");
  return left.length === right.length && timingSafeEqual(left, right);
}

const defaultResolver: DnsTxtResolverPort = Object.freeze({ resolveTxt: (name: string) => resolveTxt(name) });

export class DnsTxtProgrammaticPropertyAuthorizer implements ProgrammaticPropertyAuthorizationPort {
  private readonly operatorWebsiteOrigin: string;
  private readonly now: () => number;

  constructor(
    operatorWebsiteOrigin: string,
    private readonly keyProvider: ProgrammaticAuthorizationKeyProvider,
    private readonly resolver: DnsTxtResolverPort = defaultResolver,
    now: () => number = Date.now,
  ) {
    this.operatorWebsiteOrigin = normalizeProgrammaticOperatorOrigin(operatorWebsiteOrigin);
    if (!keyProvider || typeof keyProvider.getKey !== "function" || !resolver || typeof resolver.resolveTxt !== "function" || typeof now !== "function") {
      throw new ProgrammaticPropertyAuthorizationError("INVALID_CONFIG", "programmatic property authorizer dependencies are invalid");
    }
    this.now = now;
  }

  async verify(input: ProgrammaticPropertyAuthorizationRequest): Promise<ProgrammaticPropertyAuthorizationEvidence> {
    const normalizedSiteId = siteId(input.siteId);
    const propertyBaseUrl = normalizeProgrammaticPropertyBaseUrl(input.propertyBaseUrl);
    const propertyOrigin = new URL(propertyBaseUrl).origin;
    const operatorWebsiteOrigin = normalizeProgrammaticOperatorOrigin(input.operatorWebsiteOrigin);
    if (operatorWebsiteOrigin !== this.operatorWebsiteOrigin) {
      throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_INVALID", "authorization request operator does not match configured operator identity");
    }
    const nowMs = this.now();
    if (!Number.isFinite(nowMs)) throw new ProgrammaticPropertyAuthorizationError("INVALID_CONFIG", "authorization clock is invalid");
    const verifiedAt = new Date(nowMs).toISOString();
    if (propertyOrigin === operatorWebsiteOrigin) {
      const core = { kind: "FIRST_PARTY_CANONICAL_ORIGIN", siteId: normalizedSiteId, propertyBaseUrl, propertyOrigin, operatorWebsiteOrigin, policyVersion: PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY };
      return Object.freeze({ ...core, verifiedAt, expiresAt: null, dnsName: null, proofDigest: `sha256:${createHash("sha256").update(JSON.stringify(core), "utf8").digest("hex")}` });
    }

    const dnsName = `_nexus-pseo.${new URL(propertyOrigin).hostname}`;
    let records: readonly (readonly string[])[];
    try { records = await this.resolver.resolveTxt(dnsName); }
    catch { throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_UNAVAILABLE", "programmatic property authorization TXT lookup failed"); }
    if (!Array.isArray(records) || records.length > 32) throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_INVALID", "programmatic property authorization TXT response is invalid");
    const candidateRecords = records.map((chunks) => chunks.join("")).filter((value) => value.startsWith(TOKEN_PREFIX));
    if (candidateRecords.length === 0) throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_REQUIRED", `missing ${dnsName} authorization token`);

    let key: Uint8Array;
    try { key = await this.keyProvider.getKey(normalizedSiteId); }
    catch { throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_UNAVAILABLE", "programmatic property authorization key is unavailable"); }
    keyBytes(key);
    let expiredMatch = false;
    for (const record of candidateRecords) {
      const parsed = parseToken(record);
      if (!parsed) continue;
      const payload = parsed.payload;
      if (payload.siteId !== normalizedSiteId || payload.propertyBaseUrl !== propertyBaseUrl || payload.operatorWebsiteOrigin !== operatorWebsiteOrigin) continue;
      const expected = signature(parsed.encoded, key);
      if (!equalSignature(expected, parsed.signature)) continue;
      const issuedMs = Date.parse(payload.issuedAt);
      const expiresMs = Date.parse(payload.expiresAt);
      if (issuedMs > nowMs + MAX_CLOCK_SKEW_MS) continue;
      if (expiresMs <= nowMs) { expiredMatch = true; continue; }
      const proofCore = { record, siteId: normalizedSiteId, propertyBaseUrl, propertyOrigin, operatorWebsiteOrigin, dnsName, expiresAt: payload.expiresAt, policyVersion: PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY };
      return Object.freeze({
        kind: "DNS_TXT_DELEGATION" as const,
        siteId: normalizedSiteId,
        propertyBaseUrl,
        propertyOrigin,
        operatorWebsiteOrigin,
        verifiedAt,
        expiresAt: payload.expiresAt,
        dnsName,
        proofDigest: `sha256:${createHash("sha256").update(JSON.stringify(proofCore), "utf8").digest("hex")}`,
        policyVersion: PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY,
      });
    }
    if (expiredMatch) throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_EXPIRED", "programmatic property authorization token is expired");
    throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_INVALID", "no valid programmatic property authorization token matched this site/property/operator tuple");
  }
}

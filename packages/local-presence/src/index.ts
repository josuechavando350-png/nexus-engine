import { createHash } from "node:crypto";

export type PresenceState = "IN_SYNC" | "DRIFT" | "UNAVAILABLE" | "UNSUPPORTED" | "FAIL";
export type ProviderAuthority = "GOOGLE_BUSINESS_PROFILE_API" | "CONTROLLED_TEST";

export interface PostalAddress {
  addressLines: readonly string[];
  locality: string;
  administrativeArea: string;
  postalCode: string;
  regionCode: string;
}

export interface CanonicalLocationInput {
  locationId: string;
  name: string;
  phone: string;
  website: string;
  address: PostalAddress;
  categories?: readonly string[];
}

export interface CanonicalLocation extends CanonicalLocationInput {
  categories: readonly string[];
  canonicalDigest: string;
}

export interface ProviderLocation {
  providerId: "google-business-profile" | string;
  externalId: string;
  name: string;
  phone: string | null;
  website: string | null;
  address: PostalAddress | null;
  sourceAuthority: ProviderAuthority;
  snapshotDigest: string;
}

export interface LocationComparison {
  state: PresenceState;
  differences: readonly ("name" | "phone" | "website" | "address")[];
  canonicalDigest: string;
  providerDigest: string | null;
  comparisonDigest: string;
}

export interface SyncPlan {
  providerId: string;
  externalId: string;
  canonicalDigest: string;
  providerDigest: string;
  updateMask: readonly string[];
  patch: Readonly<Record<string, unknown>>;
  planDigest: string;
}

export interface Review {
  reviewId: string;
  reviewerName: string;
  starRating: string;
  comment: string | null;
  createTime: string | null;
  updateTime: string | null;
  reply: { comment: string; updateTime: string | null } | null;
  reviewDigest: string;
}

export interface ProviderResult<T> {
  status: "PASS" | "UNAVAILABLE" | "FAIL" | "UNSUPPORTED";
  value?: T;
  reason?: string;
}

const liveProviderSnapshots = new WeakSet<object>();

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic values");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON rejects non-plain object");
    seen.add(object);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
export function digestValue(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function text(value: string, label: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} required`);
  return normalized;
}

function normalizedText(value: string): string { return text(value, "value").toLocaleLowerCase("en-US"); }
function normalizedPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error("phone must contain 7-15 digits");
  return digits;
}
function normalizedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("website must be HTTP(S)");
  url.hash = "";
  url.search = "";
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

function validateAddress(input: PostalAddress): PostalAddress {
  if (!Array.isArray(input.addressLines) || input.addressLines.length === 0 || input.addressLines.length > 5) throw new Error("addressLines must contain 1-5 lines");
  const addressLines = input.addressLines.map((line) => text(line, "address line"));
  const regionCode = text(input.regionCode, "regionCode").toUpperCase();
  if (!/^[A-Z]{2}$/.test(regionCode)) throw new Error("regionCode must be ISO 3166-1 alpha-2");
  return Object.freeze({
    addressLines: Object.freeze(addressLines),
    locality: text(input.locality, "locality"),
    administrativeArea: text(input.administrativeArea, "administrativeArea"),
    postalCode: text(input.postalCode, "postalCode"),
    regionCode,
  });
}

export function createCanonicalLocation(input: CanonicalLocationInput): CanonicalLocation {
  const website = input.website.trim();
  normalizedUrl(website);
  normalizedPhone(input.phone);
  const categories = Object.freeze([...(input.categories ?? [])].map((item) => text(item, "category")).sort());
  const core = {
    locationId: text(input.locationId, "locationId"),
    name: text(input.name, "name"),
    phone: text(input.phone, "phone"),
    website,
    address: validateAddress(input.address),
    categories,
  };
  return Object.freeze({ ...core, canonicalDigest: digestValue(core) });
}

function providerSnapshotCore(input: Omit<ProviderLocation, "snapshotDigest">) {
  if (!input.externalId.trim()) throw new Error("provider externalId required");
  if (input.phone !== null) normalizedPhone(input.phone);
  if (input.website !== null) normalizedUrl(input.website);
  return {
    providerId: text(input.providerId, "providerId"),
    externalId: text(input.externalId, "externalId"),
    name: text(input.name, "provider name"),
    phone: input.phone === null ? null : text(input.phone, "provider phone"),
    website: input.website === null ? null : input.website.trim(),
    address: input.address === null ? null : validateAddress(input.address),
    sourceAuthority: input.sourceAuthority,
  };
}

export function createControlledProviderLocation(input: Omit<ProviderLocation, "snapshotDigest" | "sourceAuthority">): ProviderLocation {
  const core = providerSnapshotCore({ ...input, sourceAuthority: "CONTROLLED_TEST" });
  return Object.freeze({ ...core, snapshotDigest: digestValue(core) });
}

export function validateProviderLocation(input: ProviderLocation): void {
  const core = providerSnapshotCore(input);
  if (input.snapshotDigest !== digestValue(core)) throw new Error("provider snapshot replay mismatch");
}

export function validateLiveProviderLocation(input: ProviderLocation): void {
  validateProviderLocation(input);
  if (input.sourceAuthority !== "GOOGLE_BUSINESS_PROFILE_API" || !liveProviderSnapshots.has(input)) throw new Error("provider snapshot not live-attested by GBP adapter");
}

function sameAddress(left: PostalAddress, right: PostalAddress): boolean {
  return canonicalJson({
    addressLines: left.addressLines.map(normalizedText), locality: normalizedText(left.locality), administrativeArea: normalizedText(left.administrativeArea), postalCode: normalizedText(left.postalCode), regionCode: left.regionCode.toUpperCase(),
  }) === canonicalJson({
    addressLines: right.addressLines.map(normalizedText), locality: normalizedText(right.locality), administrativeArea: normalizedText(right.administrativeArea), postalCode: normalizedText(right.postalCode), regionCode: right.regionCode.toUpperCase(),
  });
}

export function compareLocation(canonical: CanonicalLocation, provider: ProviderLocation | null): LocationComparison {
  if (provider === null) {
    const core = { state: "UNAVAILABLE" as const, differences: [] as const, canonicalDigest: canonical.canonicalDigest, providerDigest: null };
    return Object.freeze({ ...core, comparisonDigest: digestValue(core) });
  }
  validateProviderLocation(provider);
  const differences: LocationComparison["differences"][number][] = [];
  if (normalizedText(canonical.name) !== normalizedText(provider.name)) differences.push("name");
  if (provider.phone === null || normalizedPhone(canonical.phone) !== normalizedPhone(provider.phone)) differences.push("phone");
  if (provider.website === null || normalizedUrl(canonical.website) !== normalizedUrl(provider.website)) differences.push("website");
  if (provider.address === null || !sameAddress(canonical.address, provider.address)) differences.push("address");
  differences.sort();
  const core = { state: differences.length ? "DRIFT" as const : "IN_SYNC" as const, differences: Object.freeze(differences), canonicalDigest: canonical.canonicalDigest, providerDigest: provider.snapshotDigest };
  return Object.freeze({ ...core, comparisonDigest: digestValue(core) });
}

export function planGoogleBusinessProfileSync(canonical: CanonicalLocation, provider: ProviderLocation): SyncPlan {
  validateProviderLocation(provider);
  if (provider.providerId !== "google-business-profile") throw new Error("GBP sync requires google-business-profile snapshot");
  const comparison = compareLocation(canonical, provider);
  const updateMask: string[] = [];
  const patch: Record<string, unknown> = { name: provider.externalId };
  if (comparison.differences.includes("name")) { updateMask.push("title"); patch.title = canonical.name; }
  if (comparison.differences.includes("phone")) { updateMask.push("phoneNumbers.primaryPhone"); patch.phoneNumbers = { primaryPhone: canonical.phone }; }
  if (comparison.differences.includes("website")) { updateMask.push("websiteUri"); patch.websiteUri = canonical.website; }
  if (comparison.differences.includes("address")) {
    updateMask.push("storefrontAddress");
    patch.storefrontAddress = {
      addressLines: canonical.address.addressLines,
      locality: canonical.address.locality,
      administrativeArea: canonical.address.administrativeArea,
      postalCode: canonical.address.postalCode,
      regionCode: canonical.address.regionCode,
    };
  }
  updateMask.sort();
  const core = { providerId: provider.providerId, externalId: provider.externalId, canonicalDigest: canonical.canonicalDigest, providerDigest: provider.snapshotDigest, updateMask: Object.freeze(updateMask), patch: Object.freeze(patch) };
  return Object.freeze({ ...core, planDigest: digestValue(core) });
}

function ensureToken(accessToken: string | undefined): string | null {
  const token = accessToken?.trim();
  return token ? token : null;
}
function headers(token: string): Record<string, string> { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
async function parseJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider returned non-object JSON");
  return value as Record<string, unknown>;
}

function fromGoogleLocation(body: Record<string, unknown>): ProviderLocation {
  const name = typeof body.name === "string" ? body.name : "";
  const title = typeof body.title === "string" ? body.title : "";
  const phoneNumbers = body.phoneNumbers && typeof body.phoneNumbers === "object" && !Array.isArray(body.phoneNumbers) ? body.phoneNumbers as Record<string, unknown> : {};
  const address = body.storefrontAddress && typeof body.storefrontAddress === "object" && !Array.isArray(body.storefrontAddress) ? body.storefrontAddress as Record<string, unknown> : null;
  const parsedAddress: PostalAddress | null = address ? {
    addressLines: Array.isArray(address.addressLines) ? address.addressLines.filter((item): item is string => typeof item === "string") : [],
    locality: typeof address.locality === "string" ? address.locality : "",
    administrativeArea: typeof address.administrativeArea === "string" ? address.administrativeArea : "",
    postalCode: typeof address.postalCode === "string" ? address.postalCode : "",
    regionCode: typeof address.regionCode === "string" ? address.regionCode : "",
  } : null;
  const core = providerSnapshotCore({
    providerId: "google-business-profile",
    externalId: name,
    name: title,
    phone: typeof phoneNumbers.primaryPhone === "string" ? phoneNumbers.primaryPhone : null,
    website: typeof body.websiteUri === "string" ? body.websiteUri : null,
    address: parsedAddress,
    sourceAuthority: "GOOGLE_BUSINESS_PROFILE_API",
  });
  const result = Object.freeze({ ...core, snapshotDigest: digestValue(core) });
  liveProviderSnapshots.add(result);
  return result;
}

export async function fetchGoogleBusinessProfileLocation(locationName: string, accessToken: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ProviderResult<ProviderLocation>> {
  const token = ensureToken(accessToken);
  if (!token) return { status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" };
  const match = /^locations\/([A-Za-z0-9_-]+)$/.exec(locationName);
  if (!match) return { status: "FAIL", reason: "locationName must match locations/{locationId}" };
  const readMask = ["name", "title", "phoneNumbers", "websiteUri", "storefrontAddress"].join(",");
  try {
    const response = await fetchImpl(`https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=${encodeURIComponent(readMask)}`, { headers: { authorization: `Bearer ${token}` }, signal });
    if (!response.ok) return { status: "FAIL", reason: `GBP location fetch failed with HTTP ${response.status}` };
    const value = fromGoogleLocation(await parseJsonObject(response));
    validateLiveProviderLocation(value);
    return { status: "PASS", value };
  } catch (error) {
    return { status: "FAIL", reason: error instanceof Error ? error.message : "GBP location fetch failed" };
  }
}

export async function executeGoogleBusinessProfileSync(plan: SyncPlan, canonical: CanonicalLocation, current: ProviderLocation, accessToken: string | undefined, approved: boolean, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ProviderResult<ProviderLocation>> {
  if (!approved) return { status: "FAIL", reason: "explicit write approval required" };
  const token = ensureToken(accessToken);
  if (!token) return { status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" };
  validateLiveProviderLocation(current);
  const expected = planGoogleBusinessProfileSync(canonical, current);
  if (plan.planDigest !== expected.planDigest) return { status: "FAIL", reason: "sync plan replay mismatch" };
  if (plan.updateMask.length === 0) return { status: "PASS", value: current };
  try {
    const response = await fetchImpl(`https://mybusinessbusinessinformation.googleapis.com/v1/${plan.externalId}?updateMask=${encodeURIComponent(plan.updateMask.join(","))}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(plan.patch), signal });
    if (!response.ok) return { status: "FAIL", reason: `GBP location update failed with HTTP ${response.status}` };
    const updated = fromGoogleLocation(await parseJsonObject(response));
    return { status: "PASS", value: updated };
  } catch (error) {
    return { status: "FAIL", reason: error instanceof Error ? error.message : "GBP location update failed" };
  }
}

function reviewFromGoogle(value: unknown): Review {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid review object");
  const row = value as Record<string, unknown>;
  const reviewer = row.reviewer && typeof row.reviewer === "object" && !Array.isArray(row.reviewer) ? row.reviewer as Record<string, unknown> : {};
  const reply = row.reviewReply && typeof row.reviewReply === "object" && !Array.isArray(row.reviewReply) ? row.reviewReply as Record<string, unknown> : null;
  const core = {
    reviewId: text(String(row.reviewId ?? ""), "reviewId"),
    reviewerName: typeof reviewer.displayName === "string" ? reviewer.displayName : "Anonymous",
    starRating: text(String(row.starRating ?? ""), "starRating"),
    comment: typeof row.comment === "string" ? row.comment : null,
    createTime: typeof row.createTime === "string" ? row.createTime : null,
    updateTime: typeof row.updateTime === "string" ? row.updateTime : null,
    reply: reply && typeof reply.comment === "string" ? { comment: reply.comment, updateTime: typeof reply.updateTime === "string" ? reply.updateTime : null } : null,
  };
  return Object.freeze({ ...core, reviewDigest: digestValue(core) });
}

export async function fetchGoogleBusinessProfileReviews(accountId: string, locationId: string, accessToken: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ProviderResult<readonly Review[]>> {
  const token = ensureToken(accessToken);
  if (!token) return { status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" };
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^[A-Za-z0-9_-]+$/.test(locationId)) return { status: "FAIL", reason: "invalid account/location id" };
  try {
    const response = await fetchImpl(`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`, { headers: { authorization: `Bearer ${token}` }, signal });
    if (!response.ok) return { status: "FAIL", reason: `GBP review fetch failed with HTTP ${response.status}` };
    const body = await parseJsonObject(response);
    const rows = body.reviews === undefined ? [] : body.reviews;
    if (!Array.isArray(rows)) return { status: "FAIL", reason: "GBP reviews payload is not an array" };
    return { status: "PASS", value: Object.freeze(rows.map(reviewFromGoogle)) };
  } catch (error) {
    return { status: "FAIL", reason: error instanceof Error ? error.message : "GBP review fetch failed" };
  }
}

export async function replyGoogleBusinessProfileReview(accountId: string, locationId: string, reviewId: string, approvedReply: string, accessToken: string | undefined, approved: boolean, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ProviderResult<true>> {
  if (!approved) return { status: "FAIL", reason: "explicit review reply approval required" };
  const token = ensureToken(accessToken);
  if (!token) return { status: "UNAVAILABLE", reason: "Google Business Profile OAuth access token unavailable" };
  const comment = approvedReply.normalize("NFKC").trim();
  if (comment.length < 2 || comment.length > 4096) return { status: "FAIL", reason: "approved review reply length invalid" };
  if (![accountId, locationId, reviewId].every((value) => /^[A-Za-z0-9_-]+$/.test(value))) return { status: "FAIL", reason: "invalid account/location/review id" };
  try {
    const response = await fetchImpl(`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`, { method: "PUT", headers: headers(token), body: JSON.stringify({ comment }), signal });
    if (!response.ok) return { status: "FAIL", reason: `GBP review reply failed with HTTP ${response.status}` };
    return { status: "PASS", value: true };
  } catch (error) {
    return { status: "FAIL", reason: error instanceof Error ? error.message : "GBP review reply failed" };
  }
}

export function localBusinessJsonLd(location: CanonicalLocation, schemaType = "LocalBusiness"): Readonly<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(schemaType)) throw new Error("invalid Schema.org type token");
  return Object.freeze({
    "@context": "https://schema.org",
    "@type": schemaType,
    "@id": `${location.website.replace(/\/+$/, "")}/#${encodeURIComponent(location.locationId)}`,
    name: location.name,
    url: location.website,
    telephone: location.phone,
    address: {
      "@type": "PostalAddress",
      streetAddress: location.address.addressLines.join(", "),
      addressLocality: location.address.locality,
      addressRegion: location.address.administrativeArea,
      postalCode: location.address.postalCode,
      addressCountry: location.address.regionCode,
    },
  });
}

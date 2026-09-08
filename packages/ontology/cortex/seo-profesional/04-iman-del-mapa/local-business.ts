import { createHash } from "node:crypto";

const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "ProfessionalService",
  "LegalService",
  "Attorney",
  "Dentist",
  "MedicalBusiness",
  "FinancialService",
  "HomeAndConstructionBusiness",
  "HealthAndBeautyBusiness",
  "AutomotiveBusiness",
  "Restaurant",
  "Store",
  "LodgingBusiness",
] as const);
const COUNTRY = /^[A-Z]{2}$/u;
const PHONE = /^[+0-9][0-9() .-]{6,31}$/u;
const EMAIL = /^[^\s@]{1,128}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/u;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export type SchemaOrgLocalBusinessType =
  | "LocalBusiness"
  | "ProfessionalService"
  | "LegalService"
  | "Attorney"
  | "Dentist"
  | "MedicalBusiness"
  | "FinancialService"
  | "HomeAndConstructionBusiness"
  | "HealthAndBeautyBusiness"
  | "AutomotiveBusiness"
  | "Restaurant"
  | "Store"
  | "LodgingBusiness";

export type SchemaOrgDayOfWeek =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface LocalBusinessPostalAddress {
  readonly regionCode: string;
  readonly addressLines: readonly string[];
  readonly locality?: string;
  readonly administrativeArea?: string;
  readonly postalCode?: string;
}

export interface LocalBusinessOpeningHours {
  readonly dayOfWeek: SchemaOrgDayOfWeek;
  readonly opens: string;
  readonly closes: string;
}

export interface LocalBusinessProfile {
  readonly schemaType: SchemaOrgLocalBusinessType;
  readonly name: string;
  readonly websiteUri: string;
  readonly primaryPhone?: string;
  readonly email?: string;
  readonly storefrontAddress?: LocalBusinessPostalAddress;
  readonly areaServed?: readonly string[];
  readonly sameAs?: readonly string[];
  readonly priceRange?: string;
  readonly openingHours?: readonly LocalBusinessOpeningHours[];
}

export interface LocalBusinessPresenceSnapshot {
  readonly profile: Readonly<LocalBusinessProfile>;
  readonly canonicalWebsiteOrigin: string;
  readonly profileDigest: `sha256:${string}`;
  readonly jsonLd: Readonly<Record<string, unknown>>;
  readonly serializedJsonLd: string;
}

export class LocalBusinessProfileError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "INVALID_PROFILE",
    message: string,
  ) {
    super(message);
    this.name = "LocalBusinessProfileError";
  }
}

function clean(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} is empty or too long`);
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} contains a control character`);
  }
  return normalized;
}

function websiteUri(value: unknown): string {
  const normalized = clean(value, "websiteUri", 2048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new LocalBusinessProfileError("INVALID_PROFILE", "websiteUri must be an absolute URL");
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.search || url.hash) {
    throw new LocalBusinessProfileError("INVALID_PROFILE", "websiteUri must be an http(s) URL without credentials, query, or fragment");
  }
  return url.href;
}

function externalUri(value: unknown, field: string): string {
  const normalized = clean(value, field, 2048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} must be an absolute URL`);
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) {
    throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} must be a safe http(s) URL`);
  }
  return url.href;
}

function postalAddress(value: unknown): Readonly<LocalBusinessPostalAddress> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalBusinessProfileError("INVALID_PROFILE", "storefrontAddress must be an object");
  const raw = value as LocalBusinessPostalAddress;
  const allowed = new Set(["regionCode", "addressLines", "locality", "administrativeArea", "postalCode"]);
  for (const key of Object.keys(value as Record<string, unknown>)) if (!allowed.has(key)) throw new LocalBusinessProfileError("INVALID_PROFILE", `unsupported storefrontAddress field ${key}`);
  const regionCode = clean(raw.regionCode, "storefrontAddress.regionCode", 2).toUpperCase();
  if (!COUNTRY.test(regionCode)) throw new LocalBusinessProfileError("INVALID_PROFILE", "storefrontAddress.regionCode must use ISO alpha-2 form");
  if (!Array.isArray(raw.addressLines) || raw.addressLines.length < 1 || raw.addressLines.length > 3) {
    throw new LocalBusinessProfileError("INVALID_PROFILE", "storefrontAddress.addressLines must contain 1..3 lines");
  }
  const addressLines = Object.freeze(raw.addressLines.map((line, index) => clean(line, `storefrontAddress.addressLines[${index}]`, 120)));
  return Object.freeze({
    regionCode,
    addressLines,
    ...(raw.locality === undefined ? {} : { locality: clean(raw.locality, "storefrontAddress.locality", 100) }),
    ...(raw.administrativeArea === undefined ? {} : { administrativeArea: clean(raw.administrativeArea, "storefrontAddress.administrativeArea", 100) }),
    ...(raw.postalCode === undefined ? {} : { postalCode: clean(raw.postalCode, "storefrontAddress.postalCode", 24) }),
  });
}

function uniqueText(values: readonly string[] | undefined, field: string, maxItems: number, maxLength: number): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > maxItems) throw new LocalBusinessProfileError("INVALID_PROFILE", `${field} exceeds its item limit`);
  return Object.freeze([...new Set(values.map((value, index) => clean(value, `${field}[${index}]`, maxLength)))]);
}

function uniqueUris(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > 20) throw new LocalBusinessProfileError("INVALID_PROFILE", "sameAs must contain at most 20 URLs");
  return Object.freeze([...new Set(values.map((value, index) => externalUri(value, `sameAs[${index}]`)))]);
}

function openingHours(values: readonly LocalBusinessOpeningHours[] | undefined): readonly LocalBusinessOpeningHours[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > 21) throw new LocalBusinessProfileError("INVALID_PROFILE", "openingHours must contain at most 21 intervals");
  const allowedDays = new Set<SchemaOrgDayOfWeek>(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  return Object.freeze(values.map((value, index) => {
    if (!value || typeof value !== "object" || !allowedDays.has(value.dayOfWeek) || !CLOCK.test(value.opens) || !CLOCK.test(value.closes) || value.opens === value.closes) {
      throw new LocalBusinessProfileError("INVALID_PROFILE", `openingHours[${index}] is malformed`);
    }
    return Object.freeze({ dayOfWeek: value.dayOfWeek, opens: value.opens, closes: value.closes });
  }));
}

export function createLocalBusinessProfile(input: LocalBusinessProfile): Readonly<LocalBusinessProfile> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalBusinessProfileError("INVALID_INPUT", "local business profile is required");
  const allowed = new Set(["schemaType", "name", "websiteUri", "primaryPhone", "email", "storefrontAddress", "areaServed", "sameAs", "priceRange", "openingHours"]);
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) if (!allowed.has(key)) throw new LocalBusinessProfileError("INVALID_PROFILE", `unsupported local business profile field ${key}`);
  if (!LOCAL_BUSINESS_TYPES.has(input.schemaType)) throw new LocalBusinessProfileError("INVALID_PROFILE", "schemaType is not an allowed LocalBusiness subtype");
  const name = clean(input.name, "name", 200);
  const canonicalWebsite = websiteUri(input.websiteUri);
  const primaryPhone = input.primaryPhone === undefined ? undefined : clean(input.primaryPhone, "primaryPhone", 32);
  if (primaryPhone !== undefined && !PHONE.test(primaryPhone)) throw new LocalBusinessProfileError("INVALID_PROFILE", "primaryPhone is malformed");
  const email = input.email === undefined ? undefined : clean(input.email, "email", 254).toLowerCase();
  if (email !== undefined && !EMAIL.test(email)) throw new LocalBusinessProfileError("INVALID_PROFILE", "email is malformed");
  const address = input.storefrontAddress === undefined ? undefined : postalAddress(input.storefrontAddress);
  const areas = uniqueText(input.areaServed, "areaServed", 50, 120);
  if (address === undefined && areas.length === 0) throw new LocalBusinessProfileError("INVALID_PROFILE", "a storefrontAddress or at least one areaServed value is required");
  const sameAs = uniqueUris(input.sameAs);
  const priceRange = input.priceRange === undefined ? undefined : clean(input.priceRange, "priceRange", 11);
  const hours = openingHours(input.openingHours);

  return Object.freeze({
    schemaType: input.schemaType,
    name,
    websiteUri: canonicalWebsite,
    ...(primaryPhone === undefined ? {} : { primaryPhone }),
    ...(email === undefined ? {} : { email }),
    ...(address === undefined ? {} : { storefrontAddress: address }),
    ...(areas.length === 0 ? {} : { areaServed: areas }),
    ...(sameAs.length === 0 ? {} : { sameAs }),
    ...(priceRange === undefined ? {} : { priceRange }),
    ...(hours.length === 0 ? {} : { openingHours: hours }),
  });
}

function schemaAddress(address: LocalBusinessPostalAddress): Readonly<Record<string, unknown>> {
  return Object.freeze({
    "@type": "PostalAddress",
    streetAddress: address.addressLines.join(", "),
    ...(address.locality === undefined ? {} : { addressLocality: address.locality }),
    ...(address.administrativeArea === undefined ? {} : { addressRegion: address.administrativeArea }),
    ...(address.postalCode === undefined ? {} : { postalCode: address.postalCode }),
    addressCountry: address.regionCode,
  });
}

export function buildLocalBusinessJsonLd(input: LocalBusinessProfile): Readonly<Record<string, unknown>> {
  const profile = createLocalBusinessProfile(input);
  const website = new URL(profile.websiteUri);
  return Object.freeze({
    "@context": "https://schema.org",
    "@type": profile.schemaType,
    "@id": `${website.href}#local-business`,
    name: profile.name,
    url: website.href,
    ...(profile.primaryPhone === undefined ? {} : { telephone: profile.primaryPhone }),
    ...(profile.email === undefined ? {} : { email: profile.email }),
    ...(profile.storefrontAddress === undefined ? {} : { address: schemaAddress(profile.storefrontAddress) }),
    ...(profile.areaServed === undefined ? {} : { areaServed: profile.areaServed }),
    ...(profile.sameAs === undefined ? {} : { sameAs: profile.sameAs }),
    ...(profile.priceRange === undefined ? {} : { priceRange: profile.priceRange }),
    ...(profile.openingHours === undefined ? {} : {
      openingHoursSpecification: Object.freeze(profile.openingHours.map((entry) => Object.freeze({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: entry.dayOfWeek,
        opens: entry.opens,
        closes: entry.closes,
      }))),
    }),
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function localBusinessProfileDigest(input: LocalBusinessProfile): `sha256:${string}` {
  const profile = createLocalBusinessProfile(input);
  return `sha256:${createHash("sha256").update(canonical(profile), "utf8").digest("hex")}`;
}

export function serializeLocalBusinessJsonLd(input: LocalBusinessProfile): string {
  return JSON.stringify(buildLocalBusinessJsonLd(input))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function createLocalBusinessPresenceSnapshot(input: LocalBusinessProfile): LocalBusinessPresenceSnapshot {
  const profile = createLocalBusinessProfile(input);
  return Object.freeze({
    profile,
    canonicalWebsiteOrigin: new URL(profile.websiteUri).origin,
    profileDigest: localBusinessProfileDigest(profile),
    jsonLd: buildLocalBusinessJsonLd(profile),
    serializedJsonLd: serializeLocalBusinessJsonLd(profile),
  });
}

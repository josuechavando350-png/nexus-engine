import { assertCanonicalId, assertNonEmpty, assertScope, canonicalTimestamp, lexicalCompare, type CreativeScope } from "../shared";
import type { AssetIdentity } from "../vault";

export type GalleryKind = "IMAGE" | "VIDEO" | "MOTION" | "SHADER" | "INTERACTION" | "TYPOGRAPHY" | "PALETTE" | "LAYOUT" | "SITE" | "RECIPE" | "OTHER";

export type GalleryErrorCode = "INVALID_ENTRY" | "DUPLICATE_ID" | "IDENTITY_COLLISION" | "SCOPE_MISMATCH" | "STORE_OUTAGE" | "INVALID_QUERY";

export class GalleryError extends Error {
  constructor(readonly code: GalleryErrorCode, message: string) {
    super(message);
    this.name = "GalleryError";
  }
}

export type GallerySource = Readonly<{
  sourceId: string;
  sourceType: "OWNED" | "LICENSED" | "REFERENCE" | "RESEARCH";
  sourceUri: string;
  creator?: string;
  capturedAt: string;
  licenseIds: readonly string[];
}>;

export type GalleryEntry = Readonly<{
  schemaVersion: 1;
  entryId: string;
  scope: CreativeScope;
  kind: GalleryKind;
  title: string;
  description: string;
  asset?: AssetIdentity;
  source: GallerySource;
  tags: readonly string[];
  intents: readonly string[];
  techniques: readonly string[];
  relatedEntryIds: readonly string[];
  createdAt: string;
}>;

export interface GalleryStore {
  append(entry: GalleryEntry): Promise<void>;
  get(scope: CreativeScope, entryId: string): Promise<GalleryEntry | undefined>;
  list(scope: CreativeScope): Promise<readonly GalleryEntry[]>;
}

export type GalleryQuery = Readonly<{
  scope: CreativeScope;
  text?: string;
  kinds?: readonly GalleryKind[];
  tags?: readonly string[];
  intents?: readonly string[];
  techniques?: readonly string[];
  limit: number;
}>;

export type RankedGalleryEntry = Readonly<{
  entry: GalleryEntry;
  score: number;
  matched: Readonly<{
    text: readonly string[];
    tags: readonly string[];
    intents: readonly string[];
    techniques: readonly string[];
  }>;
}>;

const KINDS = new Set<GalleryKind>(["IMAGE", "VIDEO", "MOTION", "SHADER", "INTERACTION", "TYPOGRAPHY", "PALETTE", "LAYOUT", "SITE", "RECIPE", "OTHER"]);
const normalize = (value: string): string => value.trim().toLowerCase();
const normalizedUnique = (values: readonly string[]): string[] => [...new Set(values.map(normalize).filter(Boolean))].sort(lexicalCompare);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => lexicalCompare(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function freezeEntry(entry: GalleryEntry): GalleryEntry {
  return Object.freeze({
    ...entry,
    scope: Object.freeze({ ...entry.scope }),
    asset: entry.asset ? Object.freeze({ ...entry.asset }) : undefined,
    source: Object.freeze({ ...entry.source, licenseIds: Object.freeze([...entry.source.licenseIds]) }),
    tags: Object.freeze([...entry.tags]),
    intents: Object.freeze([...entry.intents]),
    techniques: Object.freeze([...entry.techniques]),
    relatedEntryIds: Object.freeze([...entry.relatedEntryIds])
  });
}

function validateStringList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 128)) {
    throw new GalleryError("INVALID_ENTRY", `${field} must contain non-empty strings up to 128 characters`);
  }
  const normalized = normalizedUnique(values);
  if (normalized.length !== values.length) throw new GalleryError("INVALID_ENTRY", `${field} must be unique after normalization`);
  return normalized;
}

export function validateGalleryEntry(entry: GalleryEntry): GalleryEntry {
  if (!entry || entry.schemaVersion !== 1 || !entry.scope || !entry.source || !Array.isArray(entry.tags) || !Array.isArray(entry.intents) || !Array.isArray(entry.techniques) || !Array.isArray(entry.relatedEntryIds)) {
    throw new GalleryError("INVALID_ENTRY", "gallery entry structure is invalid");
  }
  try {
    assertScope(entry.scope);
    assertCanonicalId(entry.entryId, "entry.entryId");
    assertCanonicalId(entry.source.sourceId, "entry.source.sourceId");
    assertNonEmpty(entry.title, "entry.title");
    assertNonEmpty(entry.description, "entry.description");
    assertNonEmpty(entry.source.sourceUri, "entry.source.sourceUri");
    canonicalTimestamp(entry.source.capturedAt, "entry.source.capturedAt");
    canonicalTimestamp(entry.createdAt, "entry.createdAt");
  } catch (error) {
    throw new GalleryError("INVALID_ENTRY", error instanceof Error ? error.message : "invalid gallery entry");
  }
  if (!KINDS.has(entry.kind)) throw new GalleryError("INVALID_ENTRY", "gallery kind is invalid");
  if (!(["OWNED", "LICENSED", "REFERENCE", "RESEARCH"] as const).includes(entry.source.sourceType)) throw new GalleryError("INVALID_ENTRY", "source type is invalid");
  validateStringList(entry.tags, "tags");
  validateStringList(entry.intents, "intents");
  validateStringList(entry.techniques, "techniques");
  if (!Array.isArray(entry.source.licenseIds) || entry.source.licenseIds.some((value) => typeof value !== "string" || !value.trim())) throw new GalleryError("INVALID_ENTRY", "licenseIds must contain non-empty strings");
  if (entry.source.sourceType === "LICENSED" && !entry.source.licenseIds.length) throw new GalleryError("INVALID_ENTRY", "licensed references require at least one licenseId");
  for (const related of entry.relatedEntryIds) {
    try { assertCanonicalId(related, "entry.relatedEntryIds"); } catch (error) { throw new GalleryError("INVALID_ENTRY", error instanceof Error ? error.message : "invalid related entry"); }
    if (related === entry.entryId) throw new GalleryError("INVALID_ENTRY", "entry cannot relate to itself");
  }
  if (new Set(entry.relatedEntryIds).size !== entry.relatedEntryIds.length) throw new GalleryError("INVALID_ENTRY", "relatedEntryIds must be unique");
  if (entry.asset) {
    for (const [field, value] of Object.entries(entry.asset)) {
      if (typeof value !== "string" || !value.trim()) throw new GalleryError("INVALID_ENTRY", `asset.${field} is required`);
    }
  }
  return freezeEntry(entry);
}

export class AppendOnlyCreativeGallery {
  constructor(private readonly store: GalleryStore) {}

  async append(entry: GalleryEntry): Promise<void> {
    const immutable = validateGalleryEntry(entry);
    let existing: GalleryEntry | undefined;
    try {
      const raw = await this.store.get(immutable.scope, immutable.entryId);
      existing = raw ? validateGalleryEntry(raw) : undefined;
    } catch (error) {
      if (error instanceof GalleryError) throw error;
      throw new GalleryError("STORE_OUTAGE", "gallery store unavailable");
    }
    if (existing) {
      if (stableJson(existing) === stableJson(immutable)) throw new GalleryError("DUPLICATE_ID", `entry ${immutable.entryId} already exists`);
      throw new GalleryError("IDENTITY_COLLISION", `entry ${immutable.entryId} collides with different content`);
    }
    try {
      await this.store.append(immutable);
    } catch (error) {
      if (error instanceof GalleryError) throw error;
      throw new GalleryError("STORE_OUTAGE", "gallery store unavailable");
    }
  }
}

function matches(queryValues: readonly string[] | undefined, entryValues: readonly string[]): readonly string[] {
  if (!queryValues?.length) return Object.freeze([]);
  const wanted = new Set(normalizedUnique(queryValues));
  return Object.freeze(normalizedUnique(entryValues).filter((value) => wanted.has(value)));
}

export class DeterministicGallerySearch {
  constructor(private readonly store: GalleryStore) {}

  async search(query: GalleryQuery): Promise<readonly RankedGalleryEntry[]> {
    try { assertScope(query.scope); } catch (error) { throw new GalleryError("INVALID_QUERY", error instanceof Error ? error.message : "invalid scope"); }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) throw new GalleryError("INVALID_QUERY", "limit must be an integer in [1,500]");
    if (query.kinds?.some((kind) => !KINDS.has(kind))) throw new GalleryError("INVALID_QUERY", "query contains invalid kind");
    for (const [name, values] of [["tags", query.tags], ["intents", query.intents], ["techniques", query.techniques]] as const) {
      if (values && values.some((value) => typeof value !== "string" || !value.trim())) throw new GalleryError("INVALID_QUERY", `${name} must contain non-empty strings`);
    }
    const textTokens = query.text ? normalizedUnique(query.text.split(/\s+/)) : [];
    let entries: readonly GalleryEntry[];
    try { entries = (await this.store.list(query.scope)).map(validateGalleryEntry); } catch (error) {
      if (error instanceof GalleryError) throw error;
      throw new GalleryError("STORE_OUTAGE", "gallery store unavailable");
    }
    const scoped = entries.filter((entry) => entry.scope.tenantId === query.scope.tenantId && entry.scope.brandId === query.scope.brandId);
    const kindSet = query.kinds?.length ? new Set(query.kinds) : undefined;
    const ranked = scoped.filter((entry) => !kindSet || kindSet.has(entry.kind)).map((entry): RankedGalleryEntry => {
      const corpus = normalizedUnique([entry.title, entry.description, ...entry.tags, ...entry.intents, ...entry.techniques]);
      const text = Object.freeze(textTokens.filter((token) => corpus.some((item) => item.includes(token))));
      const tags = matches(query.tags, entry.tags);
      const intents = matches(query.intents, entry.intents);
      const techniques = matches(query.techniques, entry.techniques);
      const dimensions = [textTokens.length, query.tags?.length ?? 0, query.intents?.length ?? 0, query.techniques?.length ?? 0].filter((count) => count > 0).length;
      const score = dimensions === 0 ? 1 : ((textTokens.length ? text.length / textTokens.length : 0) + (query.tags?.length ? tags.length / normalizedUnique(query.tags).length : 0) + (query.intents?.length ? intents.length / normalizedUnique(query.intents).length : 0) + (query.techniques?.length ? techniques.length / normalizedUnique(query.techniques).length : 0)) / dimensions;
      return Object.freeze({ entry, score, matched: Object.freeze({ text, tags, intents, techniques }) });
    }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score || lexicalCompare(a.entry.entryId, b.entry.entryId)).slice(0, query.limit);
    return Object.freeze(ranked);
  }
}

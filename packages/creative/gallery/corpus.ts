import { sourceCatalogForUri } from "./sources";

export type CuratedReferenceCorpusEntry = Readonly<{
  entryId: string;
  title: string;
  catalogId: "siteinspire" | "motionsites-ai";
  sourceUri: string;
  targetUri?: string;
  verifiedOn: string;
  publishedOn?: string;
  publicSignals: readonly string[];
  attribution?: readonly string[];
  rightsMode: "REFERENCE_METADATA_ONLY";
  analysisStatus: "METADATA_VERIFIED";
}>;

export const CURATED_REFERENCE_CORPUS: readonly CuratedReferenceCorpusEntry[] = Object.freeze([
  Object.freeze({
    entryId: "siteinspire-r100-2026",
    title: "R100",
    catalogId: "siteinspire",
    sourceUri: "https://www.siteinspire.com/website/13495-r100",
    targetUri: "https://www.r-100.no/",
    verifiedOn: "2026-08-16",
    publishedOn: "2026-08-13",
    publicSignals: Object.freeze(["grid-layout", "minimal", "environment-sustainability", "industry-energy", "product-catalogue"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "siteinspire-focal-glow-2026",
    title: "Focal Glow",
    catalogId: "siteinspire",
    sourceUri: "https://www.siteinspire.com/website/13493-focal-glow",
    targetUri: "https://focalglow.co/",
    verifiedOn: "2026-08-16",
    publishedOn: "2026-08-13",
    publicSignals: Object.freeze(["luxury", "minimal", "architectural-products", "interior-design", "ecommerce"]),
    attribution: Object.freeze(["Carl Beaverson — development"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "siteinspire-huts-2026",
    title: "Huts",
    catalogId: "siteinspire",
    sourceUri: "https://www.siteinspire.com/website/13492-huts",
    targetUri: "https://huts.com/",
    verifiedOn: "2026-08-16",
    publishedOn: "2026-07-07",
    publicSignals: Object.freeze(["minimal", "typographic", "building-construction", "property-real-estate", "property"]),
    attribution: Object.freeze(["Milkshake Studio — branding, art direction, development"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "siteinspire-zauberberg-2026",
    title: "Zauberberg",
    catalogId: "siteinspire",
    sourceUri: "https://www.siteinspire.com/website/13487-zauberberg",
    targetUri: "https://zauberbergproductions.com/",
    verifiedOn: "2026-08-16",
    publishedOn: "2026-07-06",
    publicSignals: Object.freeze(["unusual-layout", "unusual-navigation", "animation-moving-image", "movies", "agency"]),
    attribution: Object.freeze(["Antinomy Studio — development, art direction, branding"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "motionsites-animated-cards-2026",
    title: "Animated Cards",
    catalogId: "motionsites-ai",
    sourceUri: "https://motionsites.ai/sections?prompt=animated-cards",
    verifiedOn: "2026-08-16",
    publicSignals: Object.freeze(["component", "animated-cards", "motion-reference"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "motionsites-vize-footer-2026",
    title: "Vize Footer",
    catalogId: "motionsites-ai",
    sourceUri: "https://motionsites.ai/sections?prompt=vize-footer",
    verifiedOn: "2026-08-16",
    publicSignals: Object.freeze(["footer-section", "motion-reference"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "motionsites-blog-showcase-2026",
    title: "Blog Showcase",
    catalogId: "motionsites-ai",
    sourceUri: "https://motionsites.ai/sections?prompt=blog-showcase",
    verifiedOn: "2026-08-16",
    publicSignals: Object.freeze(["blog", "section", "motion-reference"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
  Object.freeze({
    entryId: "motionsites-rivr-defi-2026",
    title: "RIVR DeFi",
    catalogId: "motionsites-ai",
    sourceUri: "https://motionsites.ai/",
    verifiedOn: "2026-08-16",
    publicSignals: Object.freeze(["landing-page", "defi", "motion-reference"]),
    rightsMode: "REFERENCE_METADATA_ONLY",
    analysisStatus: "METADATA_VERIFIED",
  }),
]);

export function validateCuratedReferenceCorpus(entries: readonly CuratedReferenceCorpusEntry[] = CURATED_REFERENCE_CORPUS): void {
  if (!entries.length) throw new Error("curated reference corpus cannot be empty");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.entryId.trim() || ids.has(entry.entryId)) throw new Error(`duplicate or empty corpus entryId: ${entry.entryId}`);
    ids.add(entry.entryId);
    if (!entry.title.trim()) throw new Error(`corpus entry ${entry.entryId} requires a title`);
    if (entry.rightsMode !== "REFERENCE_METADATA_ONLY") throw new Error(`corpus entry ${entry.entryId} must remain metadata-only`);
    if (entry.analysisStatus !== "METADATA_VERIFIED") throw new Error(`corpus entry ${entry.entryId} has unsupported analysis status`);
    if (!entry.publicSignals.length || entry.publicSignals.some((signal) => !signal.trim())) throw new Error(`corpus entry ${entry.entryId} requires public signals`);
    if (/example\.com/i.test(entry.sourceUri) || /example\.com/i.test(entry.targetUri ?? "")) throw new Error(`placeholder URI forbidden in corpus entry ${entry.entryId}`);
    const catalog = sourceCatalogForUri(entry.sourceUri);
    if (!catalog || catalog.catalogId !== entry.catalogId) throw new Error(`source catalog mismatch for corpus entry ${entry.entryId}`);
    const verified = new Date(`${entry.verifiedOn}T00:00:00.000Z`);
    if (!Number.isFinite(verified.getTime()) || verified.toISOString().slice(0, 10) !== entry.verifiedOn) throw new Error(`invalid verifiedOn for ${entry.entryId}`);
    if (entry.publishedOn) {
      const published = new Date(`${entry.publishedOn}T00:00:00.000Z`);
      if (!Number.isFinite(published.getTime()) || published.toISOString().slice(0, 10) !== entry.publishedOn) throw new Error(`invalid publishedOn for ${entry.entryId}`);
      if (published.getTime() > verified.getTime()) throw new Error(`publishedOn cannot be after verifiedOn for ${entry.entryId}`);
    }
  }
}

export function queryCuratedReferenceCorpus(signals: readonly string[]): CuratedReferenceCorpusEntry[] {
  validateCuratedReferenceCorpus();
  const normalized = new Set(signals.map((signal) => signal.trim().toLowerCase()).filter(Boolean));
  if (!normalized.size) return [];
  return CURATED_REFERENCE_CORPUS.filter((entry) => entry.publicSignals.some((signal) => normalized.has(signal.toLowerCase())));
}

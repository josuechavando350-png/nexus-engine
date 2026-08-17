export type CreativeSourceCatalog = Readonly<{
  catalogId: string;
  label: string;
  baseUri: string;
  mode: "REFERENCE_METADATA_ONLY";
  strengths: readonly string[];
  ingestionRule: string;
}>;

export const CURATED_CREATIVE_SOURCE_CATALOGS: readonly CreativeSourceCatalog[] = Object.freeze([
  Object.freeze({
    catalogId: "awwwards",
    label: "Awwwards",
    baseUri: "https://www.awwwards.com/",
    mode: "REFERENCE_METADATA_ONLY",
    strengths: Object.freeze(["art-direction", "animation", "interaction", "webgl", "3d", "typography", "layout"]),
    ingestionRule: "Store source URI, provenance, observed techniques and abstract design principles only; do not mirror third-party assets.",
  }),
  Object.freeze({
    catalogId: "motionsites-ai",
    label: "MotionSites AI",
    baseUri: "https://motionsites.ai/",
    mode: "REFERENCE_METADATA_ONLY",
    strengths: Object.freeze(["motion", "animated-backgrounds", "sections", "interaction", "ai-design-patterns"]),
    ingestionRule: "Store source URI and NEXUS-authored analysis only; never copy or persist paid prompt text or third-party assets.",
  }),
  Object.freeze({
    catalogId: "godly",
    label: "Godly",
    baseUri: "https://godly.design/sites/",
    mode: "REFERENCE_METADATA_ONLY",
    strengths: Object.freeze(["layout", "motion", "typography", "interaction", "product-sites"]),
    ingestionRule: "Store source URI, provenance and abstract principles only; do not mirror screenshots or source assets without rights.",
  }),
  Object.freeze({
    catalogId: "siteinspire",
    label: "Siteinspire",
    baseUri: "https://www.siteinspire.com/",
    mode: "REFERENCE_METADATA_ONLY",
    strengths: Object.freeze(["art-direction", "typography", "unusual-layout", "editorial", "portfolio", "ecommerce"]),
    ingestionRule: "Store source URI, provenance and NEXUS-authored analysis only; preserve original creator attribution where available.",
  }),
]);

export function sourceCatalogForUri(uri: string): CreativeSourceCatalog | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  return CURATED_CREATIVE_SOURCE_CATALOGS.find((catalog) => {
    const base = new URL(catalog.baseUri);
    return parsed.protocol === "https:" && parsed.hostname === base.hostname;
  });
}

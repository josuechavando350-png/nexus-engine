import { describe, expect, it } from "vitest";
import { CURATED_CREATIVE_SOURCE_CATALOGS, sourceCatalogForUri } from "../gallery/sources";

describe("curated creative source catalogs", () => {
  it("registers the intended external inspiration catalogs as metadata-only sources", () => {
    expect(CURATED_CREATIVE_SOURCE_CATALOGS.map((catalog) => catalog.catalogId)).toEqual([
      "awwwards",
      "motionsites-ai",
      "godly",
      "siteinspire",
    ]);
    expect(CURATED_CREATIVE_SOURCE_CATALOGS.every((catalog) => catalog.mode === "REFERENCE_METADATA_ONLY")).toBe(true);
    expect(CURATED_CREATIVE_SOURCE_CATALOGS.every((catalog) => catalog.ingestionRule.length > 40)).toBe(true);
  });

  it("maps only HTTPS URIs on exact curated catalog hosts", () => {
    expect(sourceCatalogForUri("https://www.awwwards.com/websites/")?.catalogId).toBe("awwwards");
    expect(sourceCatalogForUri("https://motionsites.ai/sections")?.catalogId).toBe("motionsites-ai");
    expect(sourceCatalogForUri("https://godly.design/sites/")?.catalogId).toBe("godly");
    expect(sourceCatalogForUri("https://www.siteinspire.com/websites")?.catalogId).toBe("siteinspire");
    expect(sourceCatalogForUri("http://www.awwwards.com/websites/")).toBeUndefined();
    expect(sourceCatalogForUri("https://awwwards.com.evil.example/reference")).toBeUndefined();
    expect(sourceCatalogForUri("not-a-url")).toBeUndefined();
  });
});

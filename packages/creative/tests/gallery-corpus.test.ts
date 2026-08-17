import { describe, expect, it } from "vitest";
import {
  CURATED_REFERENCE_CORPUS,
  queryCuratedReferenceCorpus,
  validateCuratedReferenceCorpus,
} from "../gallery/corpus";

describe("curated reference corpus", () => {
  it("contains verified non-placeholder metadata from real curated catalogs", () => {
    expect(() => validateCuratedReferenceCorpus()).not.toThrow();
    expect(CURATED_REFERENCE_CORPUS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(CURATED_REFERENCE_CORPUS.map((entry) => entry.catalogId))).toEqual(new Set(["siteinspire", "motionsites-ai"]));
    expect(CURATED_REFERENCE_CORPUS.every((entry) => entry.rightsMode === "REFERENCE_METADATA_ONLY")).toBe(true);
    expect(CURATED_REFERENCE_CORPUS.every((entry) => entry.analysisStatus === "METADATA_VERIFIED")).toBe(true);
    expect(CURATED_REFERENCE_CORPUS.some((entry) => entry.targetUri?.includes("r-100.no"))).toBe(true);
    expect(CURATED_REFERENCE_CORPUS.some((entry) => entry.targetUri?.includes("zauberbergproductions.com"))).toBe(true);
    expect(CURATED_REFERENCE_CORPUS.some((entry) => /example\.com/i.test(entry.sourceUri))).toBe(false);
  });

  it("queries by verified public signals rather than prompt text", () => {
    expect(queryCuratedReferenceCorpus(["unusual-layout"]).map((entry) => entry.title)).toEqual(["Zauberberg"]);
    expect(queryCuratedReferenceCorpus(["luxury"]).map((entry) => entry.title)).toEqual(["Focal Glow"]);
    expect(queryCuratedReferenceCorpus(["motion-reference"]).length).toBeGreaterThanOrEqual(4);
  });

  it("fails closed on duplicate IDs, placeholders or rights-mode escalation", () => {
    const first = CURATED_REFERENCE_CORPUS[0]!;
    expect(() => validateCuratedReferenceCorpus([first, { ...first }])).toThrow(/duplicate/);
    expect(() => validateCuratedReferenceCorpus([{ ...first, entryId: "placeholder", sourceUri: "https://example.com/fake" }])).toThrow(/placeholder/);
    expect(() => validateCuratedReferenceCorpus([{ ...first, entryId: "wrong-catalog", catalogId: "motionsites-ai" }])).toThrow(/catalog mismatch/);
  });
});

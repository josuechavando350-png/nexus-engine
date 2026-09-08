import { describe, expect, it } from "vitest";
import {
  keywordFitsGoogleLimits,
  normalizeSearchTerm,
  selectExactMatchCandidates,
  type ExactMatchSelectionPolicy,
  type SearchTermObservation,
} from "./search-term-synthesizer.js";

const policy: ExactMatchSelectionPolicy = {
  startDate: "2026-08-01",
  endDate: "2026-08-31",
  minimumClicks: 10,
  minimumConversions: 2,
  minimumConversionRate: 0.1,
  maximumCostPerConversionMicros: 6_000_000,
  minimumConversionValuePerCost: 2,
  maximumCandidates: 10,
};

function observation(overrides: Partial<SearchTermObservation> = {}): SearchTermObservation {
  return {
    campaignId: "1111111111",
    adGroupId: "2222222222",
    searchTerm: "abogado penalista cdmx",
    targetingStatus: "NONE",
    searchTermMatchType: "BROAD",
    impressions: 100,
    clicks: 20,
    conversions: 4,
    conversionValue: 100,
    costMicros: 20_000_000,
    ...overrides,
  };
}

describe("exact search-term selection", () => {
  it("aggregates the literal query across ad groups and chooses the strongest source ad group", () => {
    const result = selectExactMatchCandidates([
      observation({ adGroupId: "2222222222", searchTerm: "Abogado   Penalista CDMX", clicks: 12, conversions: 2, conversionValue: 50, costMicros: 10_000_000 }),
      observation({ adGroupId: "3333333333", searchTerm: "abogado penalista cdmx", clicks: 18, conversions: 5, conversionValue: 120, costMicros: 20_000_000, searchTermMatchType: "NEAR_EXACT" }),
    ], policy);

    expect(result.rejected).toEqual([]);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      campaignId: "1111111111",
      sourceAdGroupId: "3333333333",
      normalizedSearchTerm: "abogado penalista cdmx",
      clicks: 30,
      conversions: 7,
      conversionValue: 170,
      costMicros: 30_000_000,
      observedMatchTypes: ["BROAD", "NEAR_EXACT"],
    });
    expect(result.selected[0]!.conversionRate).toBeCloseTo(7 / 30);
    expect(result.selected[0]!.costPerConversionMicros).toBeCloseTo(30_000_000 / 7);
    expect(result.selected[0]!.conversionValuePerCost).toBeCloseTo(170 / 30);
    expect(result.selected[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("will not synthesize a term that Google already reports as targeted or excluded", () => {
    const result = selectExactMatchCandidates([
      observation({ targetingStatus: "NONE" }),
      observation({ adGroupId: "3333333333", targetingStatus: "ADDED" }),
    ], policy);

    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([{
      campaignId: "1111111111",
      searchTerm: "abogado penalista cdmx",
      normalizedSearchTerm: "abogado penalista cdmx",
      reasons: ["ALREADY_TARGETED_OR_EXCLUDED"],
    }]);
  });

  it("enforces Google keyword length and word-count limits before a mutation is planned", () => {
    const tooManyWords = "uno dos tres cuatro cinco seis siete ocho nueve diez once";
    const tooLong = "a".repeat(81);
    expect(keywordFitsGoogleLimits("uno dos tres")).toBe(true);
    expect(keywordFitsGoogleLimits(tooManyWords)).toBe(false);
    expect(keywordFitsGoogleLimits(tooLong)).toBe(false);

    const result = selectExactMatchCandidates([
      observation({ searchTerm: tooManyWords }),
      observation({ searchTerm: tooLong, adGroupId: "3333333333" }),
    ], policy);
    expect(result.selected).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((item) => item.reasons.includes("KEYWORD_LIMIT_EXCEEDED"))).toBe(true);
  });

  it("applies economics thresholds and the bounded per-run candidate cap deterministically", () => {
    const cappedPolicy = { ...policy, maximumCandidates: 1 };
    const result = selectExactMatchCandidates([
      observation({ searchTerm: "termino ganador a", conversions: 5, clicks: 20, conversionValue: 100, costMicros: 20_000_000 }),
      observation({ searchTerm: "termino ganador b", adGroupId: "3333333333", conversions: 3, clicks: 20, conversionValue: 80, costMicros: 20_000_000 }),
      observation({ searchTerm: "termino caro", adGroupId: "4444444444", conversions: 2, clicks: 20, conversionValue: 5, costMicros: 30_000_000 }),
    ], cappedPolicy);

    expect(result.selected.map((item) => item.normalizedSearchTerm)).toEqual(["termino ganador a"]);
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedSearchTerm: "termino ganador b", reasons: ["RUN_CAP_REACHED"] }),
      expect.objectContaining({ normalizedSearchTerm: "termino caro", reasons: ["ABOVE_MAXIMUM_COST_PER_CONVERSION", "BELOW_MINIMUM_CONVERSION_VALUE_PER_COST"] }),
    ]));
  });

  it("normalizes Unicode width/case/whitespace without inventing synonyms", () => {
    expect(normalizeSearchTerm("  ABOGADO\tPenalista  CDMX  ")).toBe("abogado penalista cdmx");
    expect(normalizeSearchTerm("ＡＢＣ")).toBe("abc");
  });
});

import { describe, expect, test } from "vitest";
import { assessFanOut, simulateFanOut, type FanOutInput } from "./index.js";

const input: FanOutInput = {
  rootQuery: "abogado fiscal colima",
  locale: "es-MX",
  intents: [{ id: "compare", label: "comparar opciones", weight: 0.8 }],
  entities: [{ id: "colima", label: "Colima", weight: 1 }],
  attributes: [{ id: "cost", label: "costos", weight: 0.7 }],
  constraints: [{ id: "urgent", label: "consulta urgente", weight: 0.5 }],
  evidenceNeeds: ["EXPERIENCE"],
};

describe("query fan-out", () => {
  test("is deterministic and explicitly simulated", () => {
    expect(simulateFanOut(input)).toEqual(simulateFanOut(input));
    const report = assessFanOut(input, []);
    expect(report.interpretation).toBe("SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES");
    expect(report.reportDigest).toHaveLength(64);
  });

  test("finds coverage without creating search-engine claims", () => {
    const report = assessFanOut(input, [{
      id: "p1",
      url: "https://example.com/fiscal",
      heading: "Defensa fiscal en Colima",
      text: "Atendemos controversias fiscales y explicamos costos y proceso de consulta.",
      topics: ["defensa fiscal"],
      entities: ["colima"],
      evidence: ["EXPERIENCE"],
    }]);
    expect(report.weightedCoverage).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/Google executed|observed Google internal/i);
  });

  test("fails closed on invalid factors and query bounds", () => {
    expect(() => simulateFanOut({ ...input, rootQuery: " " })).toThrow(/rootQuery/);
    expect(() => simulateFanOut({ ...input, maximumQueries: 0 })).toThrow(/maximumQueries/);
    expect(() => simulateFanOut({ ...input, intents: [{ id: "x", label: "x", weight: Number.NaN }] })).toThrow(/weight/);
    expect(() => simulateFanOut({ ...input, intents: [{ id: "x", label: "x", weight: 0.5 }, { id: "x", label: "dup", weight: 0.5 }] })).toThrow(/duplicate/);
  });

  test("bounds combinatorial fan-out and remains stable across input factor ordering", () => {
    const expanded: FanOutInput = {
      ...input,
      maximumQueries: 7,
      intents: [{ id: "b", label: "B", weight: 0.4 }, { id: "a", label: "A", weight: 0.9 }],
      attributes: [{ id: "z", label: "Z", weight: 0.8 }, { id: "a", label: "A2", weight: 0.6 }],
    };
    const reversed: FanOutInput = { ...expanded, intents: [...expanded.intents].reverse(), attributes: [...expanded.attributes].reverse() };
    expect(simulateFanOut(expanded)).toEqual(simulateFanOut(reversed));
    expect(simulateFanOut(expanded)).toHaveLength(7);
  });

  test("does not recommend doorway/scaled pages when coverage is missing", () => {
    const report = assessFanOut(input, []);
    expect(report.uncoveredQueryIds.length).toBeGreaterThan(0);
    expect(report.recommendations.join(" ")).toMatch(/do not create doorway or scaled pages/i);
  });

  test("rejects duplicate corpus passage ids", () => {
    const passage = { id: "p", url: "https://example.com/a", heading: "A", text: "B", topics: [], entities: [], evidence: [] } as const;
    expect(() => assessFanOut(input, [passage, { ...passage, url: "https://example.com/b" }])).toThrow(/duplicate corpus/);
  });
});

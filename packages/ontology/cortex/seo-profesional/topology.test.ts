import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertConnectedSeoProfessionalTopology,
  SEO_PROFESSIONAL_CONNECTIONS,
  SEO_PROFESSIONAL_STRATEGIES,
} from "./topology.js";

function implementedStrategyFolders(): number[] {
  const root = resolve(process.cwd(), "packages/ontology/cortex/seo-profesional");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{2}-/u.test(entry.name))
    .map((entry) => Number(entry.name.slice(0, 2)))
    .sort((left, right) => left - right);
}

describe("SEO Profesional connected topology", () => {
  it("registers every implemented numbered strategy folder", () => {
    const folders = implementedStrategyFolders();
    const registered = SEO_PROFESSIONAL_STRATEGIES.map((strategy) => strategy.number).sort((left, right) => left - right);
    expect(folders).toEqual([1, 2, 3, 4]);
    expect(registered).toEqual(folders);
    expect(() => assertConnectedSeoProfessionalTopology()).not.toThrow();
  });

  it("keeps all four strategies in one strongly connected acquisition/local-presence graph", () => {
    expect(SEO_PROFESSIONAL_CONNECTIONS).toEqual([
      { from: 1, to: 2, channel: "QUALIFIED_CONVERSION_FEEDBACK", boundary: "GOOGLE_ADS" },
      { from: 2, to: 3, channel: "PAID_SEARCH_TRAFFIC", boundary: "GOOGLE_ADS" },
      { from: 3, to: 1, channel: "ATTRIBUTED_LANDING_FEEDBACK", boundary: "WEB_REQUEST" },
      { from: 3, to: 4, channel: "LOCAL_STRUCTURED_PRESENCE", boundary: "WEB_REQUEST" },
      { from: 4, to: 1, channel: "VERIFIED_LOCAL_ENTITY_CONTEXT", boundary: "WEB_REQUEST" },
    ]);
    for (const strategy of SEO_PROFESSIONAL_STRATEGIES) {
      expect(SEO_PROFESSIONAL_CONNECTIONS.some((edge) => edge.from === strategy.number)).toBe(true);
      expect(SEO_PROFESSIONAL_CONNECTIONS.some((edge) => edge.to === strategy.number)).toBe(true);
    }
  });

  it("rejects a graph that isolates Iman del Mapa", () => {
    expect(() => assertConnectedSeoProfessionalTopology(
      SEO_PROFESSIONAL_STRATEGIES,
      SEO_PROFESSIONAL_CONNECTIONS.filter((edge) => edge.from !== 4 && edge.to !== 4),
    )).toThrow(/strategy 4|strongly connected|connection/u);
  });
});

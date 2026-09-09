import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertConnectedSeoProfessionalMasterTopology,
  SEO_PROFESSIONAL_MASTER_CONNECTIONS,
  SEO_PROFESSIONAL_MASTER_STRATEGIES,
} from "./master-topology.js";
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
  it("keeps the certified #1-#4 core stable while the master registers every implemented numbered strategy folder", () => {
    const folders = implementedStrategyFolders();
    const coreRegistered = SEO_PROFESSIONAL_STRATEGIES.map((strategy) => strategy.number).sort((left, right) => left - right);
    const masterRegistered = SEO_PROFESSIONAL_MASTER_STRATEGIES.map((strategy) => strategy.number).sort((left, right) => left - right);
    expect(folders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(coreRegistered).toEqual([1, 2, 3, 4]);
    expect(masterRegistered).toEqual(folders);
    expect(() => assertConnectedSeoProfessionalTopology()).not.toThrow();
    expect(() => assertConnectedSeoProfessionalMasterTopology()).not.toThrow();
  });

  it("keeps all four core strategies in their original strongly connected acquisition/local-presence graph", () => {
    expect(SEO_PROFESSIONAL_CONNECTIONS).toEqual([
      { from: 1, to: 2, channel: "QUALIFIED_CONVERSION_FEEDBACK", boundary: "GOOGLE_ADS" },
      { from: 2, to: 3, channel: "PAID_SEARCH_TRAFFIC", boundary: "GOOGLE_ADS" },
      { from: 3, to: 1, channel: "ATTRIBUTED_LANDING_FEEDBACK", boundary: "WEB_REQUEST" },
      { from: 3, to: 4, channel: "LOCAL_STRUCTURED_PRESENCE", boundary: "WEB_REQUEST" },
      { from: 4, to: 1, channel: "VERIFIED_LOCAL_ENTITY_CONTEXT", boundary: "WEB_REQUEST" },
    ]);
  });

  it("extends the master graph with #5 through #10 without mutating core edges", () => {
    expect(SEO_PROFESSIONAL_MASTER_CONNECTIONS.slice(0, SEO_PROFESSIONAL_CONNECTIONS.length)).toEqual(SEO_PROFESSIONAL_CONNECTIONS);
    expect(SEO_PROFESSIONAL_MASTER_CONNECTIONS.slice(SEO_PROFESSIONAL_CONNECTIONS.length)).toEqual([
      { from: 4, to: 5, channel: "VERIFIED_SENDER_IDENTITY", boundary: "WHATSAPP_BUSINESS" },
      { from: 5, to: 1, channel: "CONSENTED_DOMAIN_BIRTH_OUTREACH", boundary: "WHATSAPP_BUSINESS" },
      { from: 4, to: 6, channel: "VERIFIED_SELLER_IDENTITY", boundary: "PUBLIC_PROCUREMENT" },
      { from: 6, to: 1, channel: "QUALIFIED_PROCUREMENT_HANDOFF", boundary: "WEB_REQUEST" },
      { from: 4, to: 7, channel: "VERIFIED_PUBLISHER_IDENTITY", boundary: "WEB_REQUEST" },
      { from: 7, to: 1, channel: "GROUNDED_STRUCTURED_LANDING", boundary: "WEB_REQUEST" },
      { from: 4, to: 8, channel: "VERIFIED_REVIVAL_OPERATOR_IDENTITY", boundary: "WEB_REQUEST" },
      { from: 8, to: 1, channel: "QUALIFIED_REVIVAL_HANDOFF", boundary: "WEB_REQUEST" },
      { from: 4, to: 9, channel: "VERIFIED_PSEO_OPERATOR_IDENTITY", boundary: "WEB_REQUEST" },
      { from: 9, to: 1, channel: "AUTHORIZED_PROGRAMMATIC_LANDING", boundary: "WEB_REQUEST" },
      { from: 4, to: 10, channel: "VERIFIED_EDGE_OPERATOR_IDENTITY", boundary: "EDGE_DELIVERY" },
      { from: 10, to: 1, channel: "RESILIENT_WEB_LANDING", boundary: "EDGE_DELIVERY" },
    ]);
    for (const strategy of SEO_PROFESSIONAL_MASTER_STRATEGIES) {
      expect(SEO_PROFESSIONAL_MASTER_CONNECTIONS.some((edge) => edge.from === strategy.number)).toBe(true);
      expect(SEO_PROFESSIONAL_MASTER_CONNECTIONS.some((edge) => edge.to === strategy.number)).toBe(true);
    }
  });

  it("rejects a master graph that isolates Candado Invisible", () => {
    expect(() => assertConnectedSeoProfessionalMasterTopology(
      SEO_PROFESSIONAL_MASTER_STRATEGIES,
      SEO_PROFESSIONAL_MASTER_CONNECTIONS.filter((edge) => edge.from !== 10 && edge.to !== 10),
    )).toThrow(/strategy 10|strongly connected|connection/u);
  });
});

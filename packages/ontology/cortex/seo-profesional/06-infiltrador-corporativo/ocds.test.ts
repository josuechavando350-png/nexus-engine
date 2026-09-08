import { describe, expect, it } from "vitest";
import { parseOcdsOpportunities } from "./ocds.js";

describe("parseOcdsOpportunities", () => {
  it("extracts bounded procurement evidence from an OCDS release package", () => {
    const results = parseOcdsOpportunities({
      releases: [{
        id: "release-1",
        ocid: "ocds-test-1",
        buyer: { name: "Secretaría de Infraestructura" },
        tender: {
          title: "Servicio de seguridad administrada",
          description: "Contratación anual de monitoreo y respuesta.",
          status: "active",
          procurementMethod: "open",
          tenderPeriod: { endDate: "2026-10-01T18:00:00Z" },
          value: { amount: 1500000, currency: "MXN" },
          documents: [{ url: "https://compras.example/docs/rfp.pdf" }],
        },
      }],
    }, new URL("https://compras.example/ocds/releases.json"), "2026-09-08T12:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceKind: "OCDS", buyerName: "Secretaría de Infraestructura", status: "active", amount: 1500000, currency: "MXN" });
    expect(results[0]!.opportunityId).toMatch(/^ocds_[a-f0-9]{64}$/u);
  });

  it("never emits non-HTTPS document URLs", () => {
    const [result] = parseOcdsOpportunities({ releases: [{ id: "r", tender: { title: "RFP", documents: [{ url: "http://private.test/doc" }] } }] }, new URL("https://compras.example/data"), "2026-09-08T12:00:00.000Z");
    expect(result?.documentUrls).toEqual([]);
  });
});

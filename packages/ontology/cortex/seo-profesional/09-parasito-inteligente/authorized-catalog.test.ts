import { describe, expect, it } from "vitest";
import { createProgrammaticSeoCatalogSnapshot, type ProgrammaticSeoCatalogProvider } from "../../headless-programmatic-seo/index.js";
import { AuthorizedProgrammaticSeoCatalogBoundary } from "./authorized-catalog.js";

function catalog(sourceId = "editorial-main", baseUrl = "https://client.example/") {
  return createProgrammaticSeoCatalogSnapshot({
    sourceId,
    siteId: "site-client",
    baseUrl,
    observedAt: "2026-09-08T20:45:00.000Z",
    pages: [{
      pageId: "root",
      routeSegments: [],
      parentPageId: null,
      locale: "es-MX",
      title: "Servicios digitales para empresas",
      description: "Arquitectura web y automatización con evidencia first-party.",
      heading: "Servicios digitales",
      bodyText: "Servicios digitales. Esta propiedad publica contenido editorial controlado por su propietario. Contenido editorial propio y útil para la propiedad autorizada.",
      distinctiveStatements: ["Esta propiedad publica contenido editorial controlado por su propietario."],
      evidenceRefs: ["first-party:service-catalog:2026-09"],
      updatedAt: "2026-09-08T20:40:00.000Z",
      indexable: true,
    }],
  });
}

function provider(value: ReturnType<typeof catalog>): ProgrammaticSeoCatalogProvider {
  return { getCatalog: async () => value };
}

describe("AuthorizedProgrammaticSeoCatalogBoundary", () => {
  it("passes an exact authorized property catalog from a governed first-party source", async () => {
    const boundary = new AuthorizedProgrammaticSeoCatalogBoundary({ siteId: "site-client", propertyBaseUrl: "https://client.example/", allowedSources: [{ sourceId: "editorial-main", relationship: "PROPERTY_OWNER_FIRST_PARTY" }], catalog: provider(catalog()) });
    await expect(boundary.getCatalog("site-client")).resolves.toMatchObject({ siteId: "site-client", sourceId: "editorial-main", baseUrl: "https://client.example/" });
  });

  it("rejects an ungoverned source even when the catalog itself is structurally valid", async () => {
    const boundary = new AuthorizedProgrammaticSeoCatalogBoundary({ siteId: "site-client", propertyBaseUrl: "https://client.example/", allowedSources: [{ sourceId: "editorial-main", relationship: "PROPERTY_OWNER_FIRST_PARTY" }], catalog: provider(catalog("affiliate-feed")) });
    await expect(boundary.getCatalog("site-client")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("rejects a catalog that attempts to switch to another property base path", async () => {
    const boundary = new AuthorizedProgrammaticSeoCatalogBoundary({ siteId: "site-client", propertyBaseUrl: "https://client.example/guides/", allowedSources: [{ sourceId: "editorial-main", relationship: "PROPERTY_OWNER_FIRST_PARTY" }], catalog: provider(catalog("editorial-main", "https://client.example/other/")) });
    await expect(boundary.getCatalog("site-client")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});

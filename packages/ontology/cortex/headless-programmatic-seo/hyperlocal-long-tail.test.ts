import { describe, expect, it } from "vitest";
import {
  compileProgrammaticSeoBundle,
  createProgrammaticSeoCatalogSnapshot,
  createProgrammaticSeoPolicy,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoPageInput,
} from "./index";
import { HyperlocalLongTailCatalogProvider } from "./hyperlocal-long-tail";

const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const SITE_ID = "nexus-site";
const BASE_URL = "https://example.com/";

function root(): ProgrammaticSeoPageInput {
  return {
    pageId: "home",
    routeSegments: [],
    parentPageId: null,
    locale: "es-MX",
    title: "Defensa penal especializada",
    description: "Información jurídica general y rutas de atención penal.",
    heading: "Defensa penal especializada",
    bodyText: "Nuestro sitio explica rutas de atención penal, etapas procesales y criterios para solicitar orientación jurídica. La página principal organiza las áreas y recursos disponibles para cada asunto.",
    distinctiveStatements: ["La página principal organiza las áreas y recursos disponibles para cada asunto.", "Nuestro sitio explica rutas de atención penal, etapas procesales y criterios para solicitar orientación jurídica."],
    evidenceRefs: ["editorial:home-v1"],
    updatedAt: new Date(NOW).toISOString(),
    indexable: true,
  };
}

function service(): ProgrammaticSeoPageInput {
  return {
    pageId: "criminal-defense",
    routeSegments: ["defensa-penal"],
    parentPageId: "home",
    locale: "es-MX",
    title: "Defensa penal y estrategia procesal",
    description: "Guía sobre defensa penal, investigación y estrategia procesal.",
    heading: "Defensa penal y estrategia procesal",
    bodyText: "Esta guía describe investigación inicial, audiencias, preparación de evidencia y coordinación de defensa. Incluye criterios procesales aplicables a asuntos penales complejos y explica cómo organizar documentación relevante.",
    distinctiveStatements: ["Esta guía describe investigación inicial, audiencias, preparación de evidencia y coordinación de defensa.", "Incluye criterios procesales aplicables a asuntos penales complejos y explica cómo organizar documentación relevante."],
    evidenceRefs: ["editorial:defensa-v3"],
    updatedAt: new Date(NOW).toISOString(),
    indexable: true,
  };
}

function local(overrides: Partial<ProgrammaticSeoPageInput> = {}): ProgrammaticSeoPageInput {
  return {
    pageId: "criminal-defense-monterrey",
    routeSegments: ["defensa-penal", "monterrey"],
    parentPageId: "criminal-defense",
    locale: "es-MX",
    title: "Defensa penal en Monterrey: juzgados y atención local",
    description: "Información local verificada para asuntos penales en Monterrey, con referencias operativas y judiciales específicas.",
    heading: "Defensa penal en Monterrey",
    bodyText: "La atención de un asunto penal en Monterrey exige identificar la sede judicial y la autoridad que lleva la carpeta antes de definir traslados o entregas documentales. El material local registra horarios operativos verificados y referencias de acceso a las sedes utilizadas en la zona metropolitana. También distingue qué diligencias requieren presencia física y cuáles admiten coordinación previa, de acuerdo con la evidencia editorial disponible.",
    distinctiveStatements: ["La atención de un asunto penal en Monterrey exige identificar la sede judicial y la autoridad que lleva la carpeta antes de definir traslados o entregas documentales.", "El material local registra horarios operativos verificados y referencias de acceso a las sedes utilizadas en la zona metropolitana."],
    evidenceRefs: ["geo:monterrey-court-directory-v4", "geo:monterrey-access-v2", "demand:gsc-longtail-mty-v7", "demand:first-party-intent-mty-v3"],
    updatedAt: new Date(NOW).toISOString(),
    indexable: true,
    ...overrides,
  };
}

function catalog(sourceId: string, pages: readonly ProgrammaticSeoPageInput[], observedAt = new Date(NOW).toISOString()): ProgrammaticSeoCatalogSnapshot {
  return createProgrammaticSeoCatalogSnapshot({ sourceId, siteId: SITE_ID, baseUrl: BASE_URL, observedAt, pages });
}

class Source implements ProgrammaticSeoCatalogProvider {
  constructor(readonly snapshot: ProgrammaticSeoCatalogSnapshot) {}
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { return this.snapshot; }
}

function wrapper(hyperlocal: ProgrammaticSeoCatalogSnapshot) {
  return new HyperlocalLongTailCatalogProvider({
    baseCatalog: new Source(catalog("editorial-catalog-v1", [root(), service()])),
    hyperlocalCatalog: new Source(hyperlocal),
    policy: {
      version: 1,
      maxHyperlocalCatalogAgeMs: 3_600_000,
      maxHyperlocalPages: 100,
      minimumHyperlocalDistinctiveStatements: 2,
      minimumGeoEvidenceRefs: 2,
      minimumDemandEvidenceRefs: 2,
      geoEvidencePrefix: "geo:",
      demandEvidencePrefix: "demand:",
      allowedHyperlocalSourceIds: ["hyperlocal-editorial-v1"],
    },
    now: () => NOW,
  });
}

const compilePolicy = createProgrammaticSeoPolicy({
  policyId: "hyperlocal-long-tail",
  version: "v1",
  maxCatalogAgeMs: 3_600_000,
  maxPages: 100,
  minDistinctiveStatements: 2,
  maxPairwiseShingleSimilarity: 0.7,
  maxRouteDepth: 5,
  maxWriteRetries: 3,
  mode: "ACTIVE",
});

describe("CORTEX #25 hyperlocal long-tail", () => {
  it("merges only evidence-backed hyperlocal pages and passes them through the real #5 anti-doorway compiler", async () => {
    const merged = await wrapper(catalog("hyperlocal-editorial-v1", [local()])).getCatalog(SITE_ID);
    expect(merged.pages.map((page) => page.pageId)).toEqual(["home", "criminal-defense", "criminal-defense-monterrey"]);
    const bundle = compileProgrammaticSeoBundle(merged, compilePolicy);
    expect(bundle.pages).toHaveLength(3);
    expect(bundle.sitemap.map((entry) => entry.url)).toContain("https://example.com/defensa-penal/monterrey/");
  });

  it("rejects hyperlocal pages without both geographic and long-tail demand evidence", async () => {
    const missingGeo = catalog("hyperlocal-editorial-v1", [local({ evidenceRefs: ["geo:one", "demand:one", "demand:two"] })]);
    await expect(wrapper(missingGeo).getCatalog(SITE_ID)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const missingDemand = catalog("hyperlocal-editorial-v1", [local({ evidenceRefs: ["geo:one", "geo:two", "demand:one"] })]);
    await expect(wrapper(missingDemand).getCatalog(SITE_ID)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("rejects stale or unapproved hyperlocal sources before they enter the publish bundle", async () => {
    const stale = catalog("hyperlocal-editorial-v1", [local()], new Date(NOW - 3_600_001).toISOString());
    await expect(wrapper(stale).getCatalog(SITE_ID)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const foreign = catalog("unknown-source", [local()]);
    await expect(wrapper(foreign).getCatalog(SITE_ID)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("does not bypass #5 duplicate-route and scaled-content guardrails", async () => {
    const collision = catalog("hyperlocal-editorial-v1", [local({ pageId: "new-id", routeSegments: ["defensa-penal"] })]);
    await expect(wrapper(collision).getCatalog(SITE_ID)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });

    const nearDuplicate = local({
      bodyText: service().bodyText,
      distinctiveStatements: service().distinctiveStatements,
      evidenceRefs: ["geo:one", "geo:two", "demand:one", "demand:two"],
    });
    const merged = await wrapper(catalog("hyperlocal-editorial-v1", [nearDuplicate])).getCatalog(SITE_ID);
    expect(() => compileProgrammaticSeoBundle(merged, compilePolicy)).toThrowError(/distinctive|similar|reused/u);
  });
});
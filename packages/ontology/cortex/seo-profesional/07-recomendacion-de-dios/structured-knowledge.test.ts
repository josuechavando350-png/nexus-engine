import { describe, expect, it } from "vitest";
import { validateSchema, type OntologyScope, type SchemaVersion } from "../../../index.js";
import type { OntologyReadPort } from "../../../persistence-query.js";
import { buildUnifiedSemanticGraph } from "../../../semantic-graph.js";
import type { ObjectRecord } from "../../../transaction.js";
import {
  VerifiedStructuredKnowledgeEngine,
  verifyGroundedStructuredDataArtifact,
  type GroundedRichResultRule,
} from "./structured-knowledge.js";

const NOW = Date.parse("2026-09-08T18:40:00.000Z");
const scope: OntologyScope = { tenantId: "tenant-rich", organizationId: "org-rich", brandId: "brand-rich" };

function graphFor(input: {
  typeId: string;
  typeName: string;
  id: string;
  properties: Readonly<Record<string, string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>>>;
}) {
  const propertyIds = Object.keys(input.properties).sort();
  const schemaInput: SchemaVersion = {
    version: "1.0.0",
    scope,
    properties: propertyIds.map((id, index) => ({
      id,
      name: `P${index}`,
      valueKind: typeof input.properties[id] === "object" ? "JSON" : typeof input.properties[id] === "number" ? "NUMBER" : typeof input.properties[id] === "boolean" ? "BOOLEAN" : "STRING",
      cardinality: "OPTIONAL",
      unique: false,
      immutable: false,
    })),
    interfaces: [],
    objects: [{ id: input.typeId, name: input.typeName, propertyIds, interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  const schema = validateSchema(schemaInput);
  const record: ObjectRecord = { id: input.id, typeId: input.typeId, scope, properties: input.properties as ObjectRecord["properties"], revision: 1 };
  const read: OntologyReadPort = {
    getObject: (_scope, id) => id === record.id ? record : undefined,
    getRelationship: () => undefined,
    queryObjects: () => ({ items: [record] }),
    queryRelationships: () => ({ items: [] }),
  };
  return buildUnifiedSemanticGraph(read, schema, "2026-09-08T18:30:00.000Z");
}

function evidence(textContent: string, pageUrl = "https://example.test/about") {
  return {
    pageUrl,
    finalUrl: pageUrl,
    capturedAt: "2026-09-08T18:35:00.000Z",
    source: "PLAYWRIGHT_RENDERED_DOM" as const,
    textContent,
  };
}

describe("VerifiedStructuredKnowledgeEngine", () => {
  it("projects only selected graph nodes into first-party JSON-LD and binds graph/page/output by hash", () => {
    const graph = graphFor({
      typeId: "company.organization",
      typeName: "CompanyOrganization",
      id: "org-1",
      properties: { "org.name": "Example <Corp>", "org.url": "https://example.test/" },
    });
    const rules: readonly GroundedRichResultRule[] = [{
      feature: "ORGANIZATION",
      objectTypeId: "company.organization",
      schemaType: "Organization",
      nodeIds: ["org-1"],
      propertyMap: { "org.name": "name", "org.url": "url" },
    }];
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    const artifact = engine.build({ graph, pageUrl: "https://example.test/about", pageEvidence: evidence("About Example <Corp> and our services"), rules });

    expect(artifact.status).toBe("READY_FOR_RICH_RESULTS_TEST");
    expect(artifact.googleAppearanceGuaranteed).toBe(false);
    expect(artifact.jsonLd["@graph"]).toHaveLength(1);
    expect(artifact.jsonLd["@graph"][0]).toMatchObject({ "@type": "Organization", name: "Example <Corp>", url: "https://example.test/" });
    expect(String(artifact.jsonLd["@graph"][0]?.["@id"])).toMatch(/^https:\/\/example\.test\/about#nexus-/u);
    expect(artifact.serializedJsonLd).toContain("\\u003cCorp\\u003e");
    expect(JSON.stringify(artifact.receipt)).not.toContain("our services");
    expect(artifact.receipt.graphDigest).toBe(graph.digest);
    expect(verifyGroundedStructuredDataArtifact(artifact)).toBe(true);
  });

  it("rejects tampered semantic graphs before projection", () => {
    const graph = graphFor({ typeId: "company.organization", typeName: "CompanyOrganization", id: "org-1", properties: { "org.name": "Example Corp", "org.url": "https://example.test/" } });
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    expect(() => engine.build({
      graph: { ...graph, digest: "graph:sha256:tampered" },
      pageUrl: "https://example.test/about",
      pageEvidence: evidence("Example Corp"),
      rules: [{ feature: "ORGANIZATION", objectTypeId: "company.organization", schemaType: "Organization", nodeIds: ["org-1"], propertyMap: { "org.name": "name", "org.url": "url" } }],
    })).toThrow(/integrity/u);
  });

  it("requires key grounded properties to be visible in the rendered page evidence", () => {
    const graph = graphFor({ typeId: "company.organization", typeName: "CompanyOrganization", id: "org-1", properties: { "org.name": "Example Corp", "org.url": "https://example.test/" } });
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    expect(() => engine.build({
      graph,
      pageUrl: "https://example.test/about",
      pageEvidence: evidence("A page that does not name the organization"),
      rules: [{ feature: "ORGANIZATION", objectTypeId: "company.organization", schemaType: "Organization", nodeIds: ["org-1"], propertyMap: { "org.name": "name", "org.url": "url" } }],
    })).toThrow(/visibly contain grounded property name/u);
  });

  it("blocks LocalBusiness self-rating/review markup even when the graph contains the field", () => {
    const graph = graphFor({
      typeId: "company.local",
      typeName: "CompanyLocal",
      id: "local-1",
      properties: {
        "local.name": "Example Legal",
        "local.address": { "@type": "PostalAddress", streetAddress: "1 Example Ave", addressCountry: "MX" },
        "local.rating": { "@type": "AggregateRating", ratingValue: 5, reviewCount: 1 },
      },
    });
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    expect(() => engine.build({
      graph,
      pageUrl: "https://example.test/about",
      pageEvidence: evidence("Example Legal"),
      rules: [{
        feature: "LOCAL_BUSINESS",
        objectTypeId: "company.local",
        schemaType: "LegalService",
        nodeIds: ["local-1"],
        propertyMap: { "local.name": "name", "local.address": "address", "local.rating": "aggregateRating" },
      }],
    })).toThrow(/self-rating\/review/u);
  });


  it("rejects Product eligibility fields that are present but not valid Schema.org objects", () => {
    const graph = graphFor({
      typeId: "catalog.product",
      typeName: "CatalogProduct",
      id: "product-1",
      properties: { "product.name": "Nexus Plan", "product.offers": "call for price" },
    });
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    expect(() => engine.build({
      graph,
      pageUrl: "https://example.test/about",
      pageEvidence: evidence("Nexus Plan"),
      rules: [{
        feature: "PRODUCT_SNIPPET",
        objectTypeId: "catalog.product",
        schemaType: "Product",
        nodeIds: ["product-1"],
        propertyMap: { "product.name": "name", "product.offers": "offers" },
      }],
    })).toThrow(/Product\.offers/u);
  });

  it("rejects structured data for a page outside the verified publisher origin", () => {
    const graph = graphFor({ typeId: "company.organization", typeName: "CompanyOrganization", id: "org-1", properties: { "org.name": "Example Corp", "org.url": "https://example.test/" } });
    const engine = new VerifiedStructuredKnowledgeEngine({ publisherWebsiteOrigin: "https://example.test", now: () => NOW });
    expect(() => engine.build({
      graph,
      pageUrl: "https://other.example/about",
      pageEvidence: evidence("Example Corp", "https://other.example/about"),
      rules: [{ feature: "ORGANIZATION", objectTypeId: "company.organization", schemaType: "Organization", nodeIds: ["org-1"], propertyMap: { "org.name": "name", "org.url": "url" } }],
    })).toThrow(/verified publisher origin/u);
  });
});

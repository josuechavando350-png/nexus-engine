import { describe, expect, it, vi } from "vitest";
import { validateSchema, type OntologyScope } from "../../../index.js";
import type { OntologyReadPort } from "../../../persistence-query.js";
import type { ObjectRecord } from "../../../transaction.js";
import { CanonicalSemanticGraphProvider, VerifiedStructuredKnowledgeRuntime } from "./runtime.js";

const scope: OntologyScope = { tenantId: "tenant-runtime", organizationId: "org-runtime" };
const NOW = Date.parse("2026-09-08T18:40:00.000Z");

function fixture() {
  const schema = validateSchema({
    version: "1.0.0",
    scope,
    properties: [
      { id: "org.name", name: "Name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: "org.url", name: "Url", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
    ],
    interfaces: [],
    objects: [{ id: "company.organization", name: "CompanyOrganization", propertyIds: ["org.name", "org.url"], interfaceIds: [] }],
    relationships: [], actions: [], functions: [], events: [],
  });
  const record: ObjectRecord = { id: "org-runtime-1", typeId: "company.organization", scope, properties: { "org.name": "Runtime Corp", "org.url": "https://example.test/" }, revision: 2 };
  const read: OntologyReadPort = {
    getObject: (_scope, id) => id === record.id ? record : undefined,
    getRelationship: () => undefined,
    queryObjects: () => ({ items: [record] }),
    queryRelationships: () => ({ items: [] }),
  };
  return { schema, read };
}

describe("VerifiedStructuredKnowledgeRuntime", () => {
  it("uses the canonical Unified Semantic Graph provider and rendered page evidence through ports", async () => {
    const { schema, read } = fixture();
    const graphProvider = new CanonicalSemanticGraphProvider(read, schema, () => Date.parse("2026-09-08T18:30:00.000Z"));
    const pageEvidence = { capture: vi.fn(async (pageUrl: string) => ({ pageUrl, finalUrl: pageUrl, capturedAt: "2026-09-08T18:35:00.000Z", source: "PLAYWRIGHT_RENDERED_DOM" as const, textContent: "Runtime Corp" })) };
    const runtime = new VerifiedStructuredKnowledgeRuntime({ publisherWebsiteOrigin: "https://example.test", graphProvider, pageEvidence, now: () => NOW });
    expect(runtime.identity()).toEqual({ strategy: 7, provider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS", publisherWebsiteOrigin: "https://example.test" });
    const artifact = await runtime.publish({
      pageUrl: "https://example.test/about",
      rules: [{ feature: "ORGANIZATION", objectTypeId: "company.organization", schemaType: "Organization", nodeIds: ["org-runtime-1"], propertyMap: { "org.name": "name", "org.url": "url" } }],
    });
    expect(pageEvidence.capture).toHaveBeenCalledWith("https://example.test/about");
    expect(artifact.receipt.groundedNodeDigests).toHaveLength(1);
  });
});

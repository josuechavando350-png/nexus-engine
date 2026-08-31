import { describe, expect, it } from "vitest";
import { validateSchema, type OntologyScope, type SchemaVersion } from "./index";
import { InMemoryOntologyPersistence } from "./persistence-query";
import {
  buildUnifiedSemanticGraph,
  projectSchemaOrg,
  queryUnifiedSemanticGraph,
  verifyUnifiedSemanticGraph,
} from "./semantic-graph";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const otherScope: OntologyScope = { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" };

function schema() {
  const value: SchemaVersion = {
    version: "20.0.0",
    scope,
    properties: [
      { id: "name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: "valid_from", name: "validFrom", valueKind: "DATETIME", cardinality: "OPTIONAL", unique: false, immutable: false },
      { id: "valid_until", name: "validUntil", valueKind: "DATETIME", cardinality: "OPTIONAL", unique: false, immutable: false },
    ],
    interfaces: [],
    objects: [
      { id: "entity.person", name: "Person", propertyIds: ["name", "valid_from", "valid_until"], interfaceIds: [] },
      { id: "entity.org", name: "Organization", propertyIds: ["name"], interfaceIds: [] },
    ],
    relationships: [{
      id: "rel.member", name: "MemberOf", roles: [
        { name: "person", endpointTypeIds: ["entity.person"] },
        { name: "organization", endpointTypeIds: ["entity.org"] },
      ],
    }],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(value);
}

function populated() {
  const persistence = new InMemoryOntologyPersistence();
  persistence.upsertObject({ id: "p1", typeId: "entity.person", scope, revision: 2, properties: { name: "Ada", validFrom: "2026-01-01T00:00:00.000Z" } });
  persistence.upsertObject({ id: "o1", typeId: "entity.org", scope, revision: 1, properties: { name: "NEXUS" } });
  persistence.upsertRelationship({ id: "r1", typeId: "rel.member", scope, revision: 1, endpoints: { person: "p1", organization: "o1" } });
  persistence.upsertObject({ id: "foreign", typeId: "entity.person", scope: otherScope, revision: 1, properties: { name: "Foreign" } });
  return persistence;
}

describe("Unified Semantic Graph", () => {
  it("builds a deterministic tenant-bound graph from canonical ontology reads", () => {
    const first = buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z");
    const second = buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z");
    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.id)).toEqual(["o1", "p1"]);
    expect(first.edges.map((edge) => edge.id)).toEqual(["r1"]);
    expect(first.nodes.some((node) => node.id === "foreign")).toBe(false);
    expect(first.evidenceState).toBe("OBSERVED_ONTOLOGY_STATE");
    expect(verifyUnifiedSemanticGraph(first)).toBe(true);
  });

  it("fails replay/tamper verification when node data, provenance or edges are modified", () => {
    const graph = buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z");
    const nodeTamper = structuredClone(graph);
    (nodeTamper.nodes[0]!.properties as Record<string, unknown>).name = "forged";
    expect(verifyUnifiedSemanticGraph(nodeTamper)).toBe(false);

    const scopeTamper = structuredClone(graph);
    (scopeTamper.nodes[0]!.provenance.scope as { tenantId: string }).tenantId = "tenant-b";
    expect(verifyUnifiedSemanticGraph(scopeTamper)).toBe(false);

    const edgeTamper = structuredClone(graph);
    (edgeTamper.edges[0]!.endpoints as Record<string, string>).organization = "missing";
    expect(verifyUnifiedSemanticGraph(edgeTamper)).toBe(false);
  });

  it("rejects stale or malformed temporal provenance rather than silently normalizing it", () => {
    const invalid = populated();
    invalid.upsertObject({ id: "bad", typeId: "entity.person", scope, revision: 1, properties: { name: "Bad", validFrom: "2026-01-01" } });
    expect(() => buildUnifiedSemanticGraph(invalid, schema(), "2026-08-31T08:30:00.000Z")).toThrow(/canonical ISO-8601 UTC/);

    const reversed = populated();
    reversed.upsertObject({ id: "bad", typeId: "entity.person", scope, revision: 1, properties: { name: "Bad", validFrom: "2026-02-01T00:00:00.000Z", validUntil: "2026-01-01T00:00:00.000Z" } });
    expect(() => buildUnifiedSemanticGraph(reversed, schema(), "2026-08-31T08:30:00.000Z")).toThrow(/invalid temporal interval/);
  });

  it("executes bounded deterministic traversal without cross-graph roots", () => {
    const graph = buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z");
    const result = queryUnifiedSemanticGraph(graph, { rootIds: ["p1"], maxHops: 1, maxNodes: 2 });
    expect(result.nodes.map((node) => node.id)).toEqual(["o1", "p1"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["r1"]);
    expect(result.truncated).toBe(false);
    expect(() => queryUnifiedSemanticGraph(graph, { rootIds: ["foreign"] })).toThrow(/does not exist/);
    expect(() => queryUnifiedSemanticGraph(graph, { rootIds: ["p1"], maxHops: 5 }, { maxQueryNodes: 10, maxQueryHops: 2 })).toThrow(/maxHops/);
  });

  it("keeps Schema.org as an explicit projection instead of a second mutable graph", () => {
    const graph = buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z");
    const projected = projectSchemaOrg(graph, [
      { objectTypeId: "entity.person", schemaType: "Person", propertyMap: { name: "name" } },
      { objectTypeId: "entity.org", schemaType: "Organization", propertyMap: { name: "name" } },
    ]);
    expect(projected).toEqual([
      { "@context": "https://schema.org", "@type": "Organization", "@id": "urn:nexus:tenant-a:o1", name: "NEXUS" },
      { "@context": "https://schema.org", "@type": "Person", "@id": "urn:nexus:tenant-a:p1", name: "Ada" },
    ]);
  });

  it("reports insufficient evidence for an empty canonical scope and enforces build budgets", () => {
    const empty = buildUnifiedSemanticGraph(new InMemoryOntologyPersistence(), schema(), "2026-08-31T08:30:00.000Z");
    expect(empty.evidenceState).toBe("NOT_ENOUGH_EVIDENCE");

    expect(() => buildUnifiedSemanticGraph(populated(), schema(), "2026-08-31T08:30:00.000Z", {
      maxObjects: 1,
      maxRelationships: 10,
      maxQueryNodes: 10,
      maxQueryHops: 2,
    })).toThrow(/exceeds configured limit/);
  });
});

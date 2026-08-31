import { createHash } from "node:crypto";
import { canonicalJson, type OntologyScope, type ValidatedSchema } from "./index";
import type { ObjectRecord, PropertyValue, RelationshipRecord } from "./transaction";
import type { OntologyReadPort } from "./persistence-query";

export type SemanticGraphEvidenceState = "OBSERVED_ONTOLOGY_STATE" | "NOT_ENOUGH_EVIDENCE";

export interface SemanticGraphLimits {
  readonly maxObjects: number;
  readonly maxRelationships: number;
  readonly maxQueryNodes: number;
  readonly maxQueryHops: number;
}

export interface SemanticGraphProvenance {
  readonly schemaId: string;
  readonly scope: OntologyScope;
  readonly objectRevision: number;
  readonly sourceKind: "ONTOLOGY_OBJECT";
}

export interface SemanticGraphNode {
  readonly id: string;
  readonly typeId: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly provenance: SemanticGraphProvenance;
  readonly digest: string;
}

export interface SemanticGraphEdge {
  readonly id: string;
  readonly typeId: string;
  readonly endpoints: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly digest: string;
}

export interface UnifiedSemanticGraph {
  readonly formatVersion: "nexus-unified-semantic-graph-v1";
  readonly graphVersion: string;
  readonly evidenceState: SemanticGraphEvidenceState;
  readonly scope: OntologyScope;
  readonly schemaId: string;
  readonly asOf: string;
  readonly nodes: readonly SemanticGraphNode[];
  readonly edges: readonly SemanticGraphEdge[];
  readonly digest: string;
}

export interface SemanticGraphQuery {
  readonly rootIds: readonly string[];
  readonly typeIds?: readonly string[];
  readonly maxHops?: number;
  readonly maxNodes?: number;
}

export interface SemanticGraphQueryResult {
  readonly graphDigest: string;
  readonly nodes: readonly SemanticGraphNode[];
  readonly edges: readonly SemanticGraphEdge[];
  readonly truncated: boolean;
  readonly digest: string;
}

export interface SchemaOrgProjectionRule {
  readonly objectTypeId: string;
  readonly schemaType: string;
  readonly propertyMap: Readonly<Record<string, string>>;
}

export interface SchemaOrgEntity {
  readonly "@context": "https://schema.org";
  readonly "@type": string;
  readonly "@id": string;
  readonly [key: string]: unknown;
}

const DEFAULT_LIMITS: SemanticGraphLimits = {
  maxObjects: 10_000,
  maxRelationships: 20_000,
  maxQueryNodes: 500,
  maxQueryHops: 4,
};

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function assertCanonicalUtc(value: string, field: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${field} must be canonical ISO-8601 UTC`);
}

function assertPositiveLimit(value: number, field: string, ceiling: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > ceiling) throw new Error(`${field} must be an integer from 1 to ${ceiling}`);
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}:sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function readTemporal(record: ObjectRecord): { validFrom?: string; validUntil?: string } {
  const validFrom = record.properties.validFrom;
  const validUntil = record.properties.validUntil;
  if (validFrom !== undefined && typeof validFrom !== "string") throw new Error(`object ${record.id} validFrom must be a string`);
  if (validUntil !== undefined && typeof validUntil !== "string") throw new Error(`object ${record.id} validUntil must be a string`);
  if (validFrom !== undefined) assertCanonicalUtc(validFrom, `object ${record.id} validFrom`);
  if (validUntil !== undefined) assertCanonicalUtc(validUntil, `object ${record.id} validUntil`);
  if (validFrom !== undefined && validUntil !== undefined && validFrom > validUntil) throw new Error(`object ${record.id} has an invalid temporal interval`);
  return { ...(validFrom !== undefined ? { validFrom } : {}), ...(validUntil !== undefined ? { validUntil } : {}) };
}

function nodeFromRecord(record: ObjectRecord, schema: ValidatedSchema): SemanticGraphNode {
  if (!sameScope(record.scope, schema.scope)) throw new Error(`object ${record.id} escaped schema scope`);
  const temporal = readTemporal(record);
  const unsigned = {
    id: record.id,
    typeId: record.typeId,
    properties: record.properties,
    ...temporal,
    provenance: {
      schemaId: schema.schemaId,
      scope: record.scope,
      objectRevision: record.revision,
      sourceKind: "ONTOLOGY_OBJECT" as const,
    },
  };
  return { ...unsigned, digest: digest("node", unsigned) };
}

function edgeFromRecord(record: RelationshipRecord, scope: OntologyScope): SemanticGraphEdge {
  if (!sameScope(record.scope, scope)) throw new Error(`relationship ${record.id} escaped graph scope`);
  const unsigned = { id: record.id, typeId: record.typeId, endpoints: record.endpoints, revision: record.revision };
  return { ...unsigned, digest: digest("edge", unsigned) };
}

function collectAll<T extends { readonly id: string }>(
  fetch: (cursor?: string) => { readonly items: readonly T[]; readonly nextCursor?: string },
  maxItems: number,
): readonly T[] {
  const out: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = fetch(cursor);
    if (page.items.length === 0 && page.nextCursor) throw new Error("read port returned an empty page with a continuation cursor");
    out.push(...page.items);
    if (out.length > maxItems) throw new Error(`semantic graph input exceeds configured limit ${maxItems}`);
    if (page.nextCursor) {
      if (seenCursors.has(page.nextCursor)) throw new Error("read port cursor replay detected");
      seenCursors.add(page.nextCursor);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const ids = new Set<string>();
  for (const item of out) {
    if (ids.has(item.id)) throw new Error(`duplicate semantic graph record id ${item.id}`);
    ids.add(item.id);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function buildUnifiedSemanticGraph(
  readPort: OntologyReadPort,
  schema: ValidatedSchema,
  asOf: string,
  limits: SemanticGraphLimits = DEFAULT_LIMITS,
): UnifiedSemanticGraph {
  assertCanonicalUtc(asOf, "asOf");
  assertPositiveLimit(limits.maxObjects, "maxObjects", 100_000);
  assertPositiveLimit(limits.maxRelationships, "maxRelationships", 200_000);
  assertPositiveLimit(limits.maxQueryNodes, "maxQueryNodes", 10_000);
  assertPositiveLimit(limits.maxQueryHops, "maxQueryHops", 16);

  const objects = collectAll(
    (cursor) => readPort.queryObjects(schema.scope, { limit: Math.min(1000, limits.maxObjects), ...(cursor ? { cursor } : {}) }),
    limits.maxObjects,
  );
  const relationships = collectAll(
    (cursor) => readPort.queryRelationships(schema.scope, { limit: Math.min(1000, limits.maxRelationships), ...(cursor ? { cursor } : {}) }),
    limits.maxRelationships,
  );

  const nodes = objects.map((record) => nodeFromRecord(record, schema));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = relationships.map((record) => {
    for (const endpointId of Object.values(record.endpoints)) {
      if (!nodeIds.has(endpointId)) throw new Error(`relationship ${record.id} references missing object ${endpointId}`);
    }
    return edgeFromRecord(record, schema.scope);
  });

  const body = {
    formatVersion: "nexus-unified-semantic-graph-v1" as const,
    graphVersion: `${schema.version}+${schema.schemaId.slice(0, 20)}`,
    evidenceState: nodes.length === 0 ? "NOT_ENOUGH_EVIDENCE" as const : "OBSERVED_ONTOLOGY_STATE" as const,
    scope: schema.scope,
    schemaId: schema.schemaId,
    asOf,
    nodes,
    edges,
  };
  return { ...body, digest: digest("graph", body) };
}

export function verifyUnifiedSemanticGraph(graph: UnifiedSemanticGraph): boolean {
  try {
    assertCanonicalUtc(graph.asOf, "asOf");
    if (graph.formatVersion !== "nexus-unified-semantic-graph-v1") return false;
    const nodeIds = new Set<string>();
    for (const node of graph.nodes) {
      if (nodeIds.has(node.id)) return false;
      nodeIds.add(node.id);
      if (!sameScope(node.provenance.scope, graph.scope) || node.provenance.schemaId !== graph.schemaId) return false;
      const { digest: supplied, ...unsigned } = node;
      if (digest("node", unsigned) !== supplied) return false;
      readTemporal({ id: node.id, typeId: node.typeId, scope: node.provenance.scope, properties: node.properties, revision: node.provenance.objectRevision });
    }
    const edgeIds = new Set<string>();
    for (const edge of graph.edges) {
      if (edgeIds.has(edge.id)) return false;
      edgeIds.add(edge.id);
      if (Object.values(edge.endpoints).some((id) => !nodeIds.has(id))) return false;
      const { digest: supplied, ...unsigned } = edge;
      if (digest("edge", unsigned) !== supplied) return false;
    }
    const { digest: suppliedGraphDigest, ...body } = graph;
    return digest("graph", body) === suppliedGraphDigest;
  } catch {
    return false;
  }
}

export function queryUnifiedSemanticGraph(
  graph: UnifiedSemanticGraph,
  query: SemanticGraphQuery,
  limits: Pick<SemanticGraphLimits, "maxQueryNodes" | "maxQueryHops"> = DEFAULT_LIMITS,
): SemanticGraphQueryResult {
  if (!verifyUnifiedSemanticGraph(graph)) throw new Error("semantic graph integrity verification failed");
  assertPositiveLimit(limits.maxQueryNodes, "maxQueryNodes", 10_000);
  assertPositiveLimit(limits.maxQueryHops, "maxQueryHops", 16);
  const maxNodes = query.maxNodes ?? limits.maxQueryNodes;
  const maxHops = query.maxHops ?? limits.maxQueryHops;
  assertPositiveLimit(maxNodes, "query.maxNodes", limits.maxQueryNodes);
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > limits.maxQueryHops) throw new Error(`query.maxHops must be an integer from 0 to ${limits.maxQueryHops}`);
  if (query.rootIds.length === 0 || query.rootIds.length > maxNodes) throw new Error("query.rootIds must be non-empty and bounded by maxNodes");

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const allowedTypes = query.typeIds ? new Set(query.typeIds) : undefined;
  const queue: Array<{ id: string; depth: number }> = [];
  const visited = new Set<string>();
  for (const rootId of [...new Set(query.rootIds)].sort()) {
    if (!byId.has(rootId)) throw new Error(`query root ${rootId} does not exist`);
    queue.push({ id: rootId, depth: 0 });
  }

  const selectedNodes: SemanticGraphNode[] = [];
  const selectedEdges = new Map<string, SemanticGraphEdge>();
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const node = byId.get(current.id)!;
    if (!allowedTypes || allowedTypes.has(node.typeId)) {
      if (selectedNodes.length >= maxNodes) { truncated = true; break; }
      selectedNodes.push(node);
    }
    if (current.depth >= maxHops) continue;
    for (const edge of graph.edges) {
      const endpoints = Object.values(edge.endpoints);
      if (!endpoints.includes(current.id)) continue;
      selectedEdges.set(edge.id, edge);
      for (const endpointId of endpoints.sort()) if (!visited.has(endpointId)) queue.push({ id: endpointId, depth: current.depth + 1 });
    }
  }

  selectedNodes.sort((a, b) => a.id.localeCompare(b.id, "en"));
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const edges = [...selectedEdges.values()]
    .filter((edge) => Object.values(edge.endpoints).every((id) => selectedNodeIds.has(id)))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  const body = { graphDigest: graph.digest, nodes: selectedNodes, edges, truncated };
  return { ...body, digest: digest("query", body) };
}

export function projectSchemaOrg(
  graph: UnifiedSemanticGraph,
  rules: readonly SchemaOrgProjectionRule[],
): readonly SchemaOrgEntity[] {
  if (!verifyUnifiedSemanticGraph(graph)) throw new Error("semantic graph integrity verification failed");
  if (rules.length > 1000) throw new Error("schema.org projection rule limit exceeded");
  const ruleByType = new Map<string, SchemaOrgProjectionRule>();
  for (const rule of rules) {
    if (!rule.objectTypeId.trim() || !rule.schemaType.trim()) throw new Error("schema.org projection rules require non-empty type identifiers");
    if (ruleByType.has(rule.objectTypeId)) throw new Error(`duplicate schema.org projection rule for ${rule.objectTypeId}`);
    if (Object.keys(rule.propertyMap).length > 100) throw new Error(`schema.org property map for ${rule.objectTypeId} is too large`);
    ruleByType.set(rule.objectTypeId, rule);
  }
  return graph.nodes.flatMap((node) => {
    const rule = ruleByType.get(node.typeId);
    if (!rule) return [];
    const entity: Record<string, unknown> = { "@context": "https://schema.org", "@type": rule.schemaType, "@id": `urn:nexus:${graph.scope.tenantId}:${node.id}` };
    for (const [propertyId, schemaProperty] of Object.entries(rule.propertyMap).sort(([a], [b]) => a.localeCompare(b, "en"))) {
      if (!schemaProperty.trim()) throw new Error(`schema.org property name for ${propertyId} is empty`);
      if (propertyId in node.properties) entity[schemaProperty] = node.properties[propertyId];
    }
    return [entity as SchemaOrgEntity];
  });
}

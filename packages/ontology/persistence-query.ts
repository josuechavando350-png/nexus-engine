import { createHash } from "node:crypto";
import type { OntologyScope } from "./index";
import type { ObjectRecord, RelationshipRecord } from "./transaction";

export interface QueryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ObjectQuery {
  readonly typeId?: string;
  readonly propertyEquals?: Readonly<Record<string, string | number | boolean | null>>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RelationshipQuery {
  readonly typeId?: string;
  readonly endpointId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OntologyReadPort {
  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined;
  getRelationship(scope: OntologyScope, id: string): RelationshipRecord | undefined;
  queryObjects(scope: OntologyScope, query?: ObjectQuery): QueryPage<ObjectRecord>;
  queryRelationships(scope: OntologyScope, query?: RelationshipQuery): QueryPage<RelationshipRecord>;
}

export interface OntologySnapshot {
  readonly formatVersion: "nexus-ontology-snapshot-v2";
  readonly scope: OntologyScope;
  readonly createdAt: string;
  readonly sourceWatermark: string;
  readonly objectCount: number;
  readonly relationshipCount: number;
  readonly complete: true;
  readonly digest: string;
  readonly objects: readonly ObjectRecord[];
  readonly relationships: readonly RelationshipRecord[];
}

export interface RestoreAuthorizationPort {
  authorizeRestore(sourceScope: OntologyScope, targetScope: OntologyScope): boolean;
}

export interface OntologyPersistencePort extends OntologyReadPort {
  upsertObject(record: ObjectRecord): void;
  deleteObject(scope: OntologyScope, id: string): void;
  upsertRelationship(record: RelationshipRecord): void;
  deleteRelationship(scope: OntologyScope, id: string): void;
  exportSnapshot(scope: OntologyScope, createdAt: string): OntologySnapshot;
  restoreSnapshot(snapshot: OntologySnapshot, targetScope: OntologyScope): void;
}

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function recordKey(scope: OntologyScope, id: string): string {
  return `${scopeKey(scope)}\u0000${id}`;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function assertCanonicalUtc(value: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("snapshot createdAt must be canonical ISO-8601 UTC");
}

function cloneObject(record: ObjectRecord, scope: OntologyScope = record.scope): ObjectRecord {
  return { ...record, scope: { ...scope }, properties: { ...record.properties } };
}

function cloneRelationship(record: RelationshipRecord, scope: OntologyScope = record.scope): RelationshipRecord {
  return { ...record, scope: { ...scope }, endpoints: { ...record.endpoints } };
}

function page<T>(items: readonly T[], limit = 100, cursor?: string): QueryPage<T> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error("query limit must be an integer from 1 to 1000");
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid query cursor");
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : undefined;
  return next ? { items: slice, nextCursor: next } : { items: slice };
}

function collectAll<T>(load: (cursor?: string) => QueryPage<T>): T[] {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = load(cursor);
    items.push(...result.items);
    if (result.nextCursor !== undefined) {
      if (seenCursors.has(result.nextCursor)) throw new Error("snapshot pagination cursor repeated");
      seenCursors.add(result.nextCursor);
    }
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function stableRecordPayload(snapshot: Pick<OntologySnapshot, "formatVersion" | "scope" | "createdAt" | "sourceWatermark" | "objectCount" | "relationshipCount" | "complete" | "objects" | "relationships">): string {
  const objects = [...snapshot.objects]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((record) => ({
      id: record.id,
      typeId: record.typeId,
      scope: record.scope,
      revision: record.revision,
      properties: Object.fromEntries(Object.entries(record.properties).sort(([a], [b]) => a.localeCompare(b)))
    }));
  const relationships = [...snapshot.relationships]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((record) => ({
      id: record.id,
      typeId: record.typeId,
      scope: record.scope,
      revision: record.revision,
      endpoints: Object.fromEntries(Object.entries(record.endpoints).sort(([a], [b]) => a.localeCompare(b)))
    }));
  return JSON.stringify({
    formatVersion: snapshot.formatVersion,
    scope: snapshot.scope,
    createdAt: snapshot.createdAt,
    sourceWatermark: snapshot.sourceWatermark,
    objectCount: snapshot.objectCount,
    relationshipCount: snapshot.relationshipCount,
    complete: snapshot.complete,
    objects,
    relationships
  });
}

function snapshotDigest(snapshot: Pick<OntologySnapshot, "formatVersion" | "scope" | "createdAt" | "sourceWatermark" | "objectCount" | "relationshipCount" | "complete" | "objects" | "relationships">): string {
  return `sha256:${createHash("sha256").update(stableRecordPayload(snapshot)).digest("hex")}`;
}

function sourceWatermark(objects: readonly ObjectRecord[], relationships: readonly RelationshipRecord[]): string {
  const objectRevision = objects.reduce((max, record) => Math.max(max, record.revision), 0);
  const relationshipRevision = relationships.reduce((max, record) => Math.max(max, record.revision), 0);
  return `objects:${objects.length}@${objectRevision};relationships:${relationships.length}@${relationshipRevision}`;
}

function assertUniqueIds(records: readonly { readonly id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`snapshot contains duplicate ${kind} id ${record.id}`);
    seen.add(record.id);
  }
}

function validateSnapshot(snapshot: OntologySnapshot): void {
  if (snapshot.formatVersion !== "nexus-ontology-snapshot-v2") throw new Error("unsupported snapshot format version");
  assertCanonicalUtc(snapshot.createdAt);
  if (snapshot.complete !== true) throw new Error("snapshot is not marked complete");
  if (snapshot.objectCount !== snapshot.objects.length) throw new Error("snapshot object count mismatch");
  if (snapshot.relationshipCount !== snapshot.relationships.length) throw new Error("snapshot relationship count mismatch");
  assertUniqueIds(snapshot.objects, "object");
  assertUniqueIds(snapshot.relationships, "relationship");
  for (const record of snapshot.objects) if (!sameScope(record.scope, snapshot.scope)) throw new Error("snapshot contains cross-scope object");
  for (const record of snapshot.relationships) if (!sameScope(record.scope, snapshot.scope)) throw new Error("snapshot contains cross-scope relationship");
  if (snapshot.sourceWatermark !== sourceWatermark(snapshot.objects, snapshot.relationships)) throw new Error("snapshot source watermark mismatch");
  if (snapshot.digest !== snapshotDigest(snapshot)) throw new Error("snapshot digest mismatch");
}

export class InMemoryOntologyPersistence implements OntologyPersistencePort {
  private objects = new Map<string, ObjectRecord>();
  private relationships = new Map<string, RelationshipRecord>();

  constructor(
    private readonly restoreAuthorization?: RestoreAuthorizationPort,
    private readonly beforeRestoreCommit?: (snapshot: OntologySnapshot, targetScope: OntologyScope) => void
  ) {}

  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined {
    const value = this.objects.get(recordKey(scope, id));
    return value ? cloneObject(value) : undefined;
  }

  getRelationship(scope: OntologyScope, id: string): RelationshipRecord | undefined {
    const value = this.relationships.get(recordKey(scope, id));
    return value ? cloneRelationship(value) : undefined;
  }

  upsertObject(record: ObjectRecord): void {
    this.objects.set(recordKey(record.scope, record.id), cloneObject(record));
  }

  deleteObject(scope: OntologyScope, id: string): void {
    this.objects.delete(recordKey(scope, id));
  }

  upsertRelationship(record: RelationshipRecord): void {
    this.relationships.set(recordKey(record.scope, record.id), cloneRelationship(record));
  }

  deleteRelationship(scope: OntologyScope, id: string): void {
    this.relationships.delete(recordKey(scope, id));
  }

  queryObjects(scope: OntologyScope, query: ObjectQuery = {}): QueryPage<ObjectRecord> {
    const matches = [...this.objects.values()]
      .filter((record) => sameScope(record.scope, scope))
      .filter((record) => query.typeId === undefined || record.typeId === query.typeId)
      .filter((record) => Object.entries(query.propertyEquals ?? {}).every(([key, value]) => record.properties[key] === value))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneObject);
    return page(matches, query.limit, query.cursor);
  }

  queryRelationships(scope: OntologyScope, query: RelationshipQuery = {}): QueryPage<RelationshipRecord> {
    const matches = [...this.relationships.values()]
      .filter((record) => sameScope(record.scope, scope))
      .filter((record) => query.typeId === undefined || record.typeId === query.typeId)
      .filter((record) => query.endpointId === undefined || Object.values(record.endpoints).includes(query.endpointId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneRelationship);
    return page(matches, query.limit, query.cursor);
  }

  exportSnapshot(scope: OntologyScope, createdAt: string): OntologySnapshot {
    assertCanonicalUtc(createdAt);
    const objects = collectAll((cursor) => this.queryObjects(scope, { limit: 1000, cursor }));
    const relationships = collectAll((cursor) => this.queryRelationships(scope, { limit: 1000, cursor }));
    const unsigned = {
      formatVersion: "nexus-ontology-snapshot-v2" as const,
      scope: { ...scope },
      createdAt,
      sourceWatermark: sourceWatermark(objects, relationships),
      objectCount: objects.length,
      relationshipCount: relationships.length,
      complete: true as const,
      objects,
      relationships
    };
    return { ...unsigned, digest: snapshotDigest(unsigned) };
  }

  restoreSnapshot(snapshot: OntologySnapshot, targetScope: OntologyScope): void {
    validateSnapshot(snapshot);
    if (!sameScope(snapshot.scope, targetScope)) {
      if (!this.restoreAuthorization?.authorizeRestore(snapshot.scope, targetScope)) {
        throw new Error("cross-scope restore is not explicitly authorized");
      }
    }

    // Build and verify a complete replacement in staging. Nothing in the live maps changes
    // until every validation and failure-injection hook has succeeded.
    const stagedObjects = new Map(this.objects);
    const stagedRelationships = new Map(this.relationships);
    const prefix = `${scopeKey(targetScope)}\u0000`;
    for (const key of [...stagedObjects.keys()]) if (key.startsWith(prefix)) stagedObjects.delete(key);
    for (const key of [...stagedRelationships.keys()]) if (key.startsWith(prefix)) stagedRelationships.delete(key);
    for (const record of snapshot.objects) stagedObjects.set(recordKey(targetScope, record.id), cloneObject(record, targetScope));
    for (const record of snapshot.relationships) stagedRelationships.set(recordKey(targetScope, record.id), cloneRelationship(record, targetScope));

    const stagedObjectCount = [...stagedObjects.values()].filter((record) => sameScope(record.scope, targetScope)).length;
    const stagedRelationshipCount = [...stagedRelationships.values()].filter((record) => sameScope(record.scope, targetScope)).length;
    if (stagedObjectCount !== snapshot.objectCount || stagedRelationshipCount !== snapshot.relationshipCount) {
      throw new Error("staged restore verification failed");
    }

    this.beforeRestoreCommit?.(snapshot, targetScope);
    this.objects = stagedObjects;
    this.relationships = stagedRelationships;
  }
}

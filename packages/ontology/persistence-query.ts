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
  readonly scope: OntologyScope;
  readonly createdAt: string;
  readonly objects: readonly ObjectRecord[];
  readonly relationships: readonly RelationshipRecord[];
}

export interface OntologyPersistencePort extends OntologyReadPort {
  upsertObject(record: ObjectRecord): void;
  deleteObject(scope: OntologyScope, id: string): void;
  upsertRelationship(record: RelationshipRecord): void;
  deleteRelationship(scope: OntologyScope, id: string): void;
  exportSnapshot(scope: OntologyScope, createdAt: string): OntologySnapshot;
  restoreSnapshot(snapshot: OntologySnapshot): void;
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

function cloneObject(record: ObjectRecord): ObjectRecord {
  return { ...record, scope: { ...record.scope }, properties: { ...record.properties } };
}

function cloneRelationship(record: RelationshipRecord): RelationshipRecord {
  return { ...record, scope: { ...record.scope }, endpoints: { ...record.endpoints } };
}

function page<T>(items: readonly T[], limit = 100, cursor?: string): QueryPage<T> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error("query limit must be an integer from 1 to 1000");
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid query cursor");
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : undefined;
  return next ? { items: slice, nextCursor: next } : { items: slice };
}

export class InMemoryOntologyPersistence implements OntologyPersistencePort {
  private objects = new Map<string, ObjectRecord>();
  private relationships = new Map<string, RelationshipRecord>();

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
    return {
      scope: { ...scope },
      createdAt,
      objects: this.queryObjects(scope, { limit: 1000 }).items,
      relationships: this.queryRelationships(scope, { limit: 1000 }).items
    };
  }

  restoreSnapshot(snapshot: OntologySnapshot): void {
    assertCanonicalUtc(snapshot.createdAt);
    for (const record of snapshot.objects) if (!sameScope(record.scope, snapshot.scope)) throw new Error("snapshot contains cross-scope object");
    for (const record of snapshot.relationships) if (!sameScope(record.scope, snapshot.scope)) throw new Error("snapshot contains cross-scope relationship");

    const prefix = `${scopeKey(snapshot.scope)}\u0000`;
    this.objects = new Map([...this.objects.entries()].filter(([key]) => !key.startsWith(prefix)));
    this.relationships = new Map([...this.relationships.entries()].filter(([key]) => !key.startsWith(prefix)));
    for (const record of snapshot.objects) this.upsertObject(record);
    for (const record of snapshot.relationships) this.upsertRelationship(record);
  }
}

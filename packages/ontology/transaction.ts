import type { OntologyScope, ValidatedSchema } from "./index";

export type PropertyValue = string | number | boolean | null;

export interface ObjectRecord {
  readonly id: string;
  readonly typeId: string;
  readonly scope: OntologyScope;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly revision: number;
}

export interface RelationshipRecord {
  readonly id: string;
  readonly typeId: string;
  readonly scope: OntologyScope;
  readonly endpoints: Readonly<Record<string, string>>;
  readonly revision: number;
}

export type TransactionOperation =
  | { readonly kind: "CREATE_OBJECT"; readonly record: Omit<ObjectRecord, "revision"> }
  | { readonly kind: "UPDATE_OBJECT"; readonly id: string; readonly expectedRevision: number; readonly properties: Readonly<Record<string, PropertyValue>> }
  | { readonly kind: "DELETE_OBJECT"; readonly id: string; readonly expectedRevision: number }
  | { readonly kind: "CREATE_RELATIONSHIP"; readonly record: Omit<RelationshipRecord, "revision"> }
  | { readonly kind: "DELETE_RELATIONSHIP"; readonly id: string; readonly expectedRevision: number };

export interface TransactionResult {
  readonly committed: true;
  readonly objectIds: readonly string[];
  readonly relationshipIds: readonly string[];
}

export interface OntologyTransactionPort {
  transact(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult;
  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined;
  getRelationship(scope: OntologyScope, id: string): RelationshipRecord | undefined;
}

export class OntologyTransactionError extends Error {
  constructor(public readonly code: "INVALID_SCOPE" | "INVALID_SCHEMA" | "NOT_FOUND" | "CONFLICT" | "INVALID_OPERATION" | "IMMUTABLE_PROPERTY", message: string) {
    super(message);
    this.name = "OntologyTransactionError";
  }
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function key(scope: OntologyScope, id: string): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}\u0000${id}`;
}

function cloneObject(record: ObjectRecord): ObjectRecord {
  return { ...record, properties: { ...record.properties } };
}

function cloneRelationship(record: RelationshipRecord): RelationshipRecord {
  return { ...record, endpoints: { ...record.endpoints } };
}

export class InMemoryOntologyTransactionStore implements OntologyTransactionPort {
  private objects = new Map<string, ObjectRecord>();
  private relationships = new Map<string, RelationshipRecord>();

  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined {
    const value = this.objects.get(key(scope, id));
    return value ? cloneObject(value) : undefined;
  }

  getRelationship(scope: OntologyScope, id: string): RelationshipRecord | undefined {
    const value = this.relationships.get(key(scope, id));
    return value ? cloneRelationship(value) : undefined;
  }

  transact(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult {
    if (!sameScope(scope, schema.scope)) throw new OntologyTransactionError("INVALID_SCOPE", "transaction scope must match schema scope");
    if (operations.length === 0) throw new OntologyTransactionError("INVALID_OPERATION", "transaction requires at least one operation");

    const objects = new Map(this.objects);
    const relationships = new Map(this.relationships);
    const objectTypes = new Map(schema.objects.map((item) => [item.id, item]));
    const propertyTypes = new Map(schema.properties.map((item) => [item.id, item]));
    const relationshipTypes = new Map(schema.relationships.map((item) => [item.id, item]));
    const touchedObjects = new Set<string>();
    const touchedRelationships = new Set<string>();

    const requireObject = (id: string): ObjectRecord => {
      const value = objects.get(key(scope, id));
      if (!value) throw new OntologyTransactionError("NOT_FOUND", `object ${id} not found`);
      return value;
    };

    for (const operation of operations) {
      switch (operation.kind) {
        case "CREATE_OBJECT": {
          if (!sameScope(scope, operation.record.scope)) throw new OntologyTransactionError("INVALID_SCOPE", "object scope mismatch");
          const type = objectTypes.get(operation.record.typeId);
          if (!type) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown object type ${operation.record.typeId}`);
          const objectKey = key(scope, operation.record.id);
          if (objects.has(objectKey)) throw new OntologyTransactionError("CONFLICT", `object ${operation.record.id} already exists`);
          for (const propertyId of Object.keys(operation.record.properties)) if (!type.propertyIds.includes(propertyId)) throw new OntologyTransactionError("INVALID_OPERATION", `property ${propertyId} is not declared on ${type.id}`);
          objects.set(objectKey, { ...operation.record, properties: { ...operation.record.properties }, revision: 1 });
          touchedObjects.add(operation.record.id);
          break;
        }
        case "UPDATE_OBJECT": {
          const current = requireObject(operation.id);
          if (current.revision !== operation.expectedRevision) throw new OntologyTransactionError("CONFLICT", `object ${operation.id} revision conflict`);
          const type = objectTypes.get(current.typeId);
          if (!type) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown object type ${current.typeId}`);
          for (const [propertyId, value] of Object.entries(operation.properties)) {
            if (!type.propertyIds.includes(propertyId)) throw new OntologyTransactionError("INVALID_OPERATION", `property ${propertyId} is not declared on ${type.id}`);
            const property = propertyTypes.get(propertyId);
            if (!property) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown property ${propertyId}`);
            if (property.immutable && propertyId in current.properties && current.properties[propertyId] !== value) throw new OntologyTransactionError("IMMUTABLE_PROPERTY", `property ${propertyId} is immutable`);
          }
          objects.set(key(scope, operation.id), { ...current, properties: { ...current.properties, ...operation.properties }, revision: current.revision + 1 });
          touchedObjects.add(operation.id);
          break;
        }
        case "DELETE_OBJECT": {
          const current = requireObject(operation.id);
          if (current.revision !== operation.expectedRevision) throw new OntologyTransactionError("CONFLICT", `object ${operation.id} revision conflict`);
          for (const relationship of relationships.values()) if (Object.values(relationship.endpoints).includes(operation.id)) throw new OntologyTransactionError("INVALID_OPERATION", `object ${operation.id} is still referenced by relationship ${relationship.id}`);
          objects.delete(key(scope, operation.id));
          touchedObjects.add(operation.id);
          break;
        }
        case "CREATE_RELATIONSHIP": {
          if (!sameScope(scope, operation.record.scope)) throw new OntologyTransactionError("INVALID_SCOPE", "relationship scope mismatch");
          const type = relationshipTypes.get(operation.record.typeId);
          if (!type) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown relationship type ${operation.record.typeId}`);
          const relationshipKey = key(scope, operation.record.id);
          if (relationships.has(relationshipKey)) throw new OntologyTransactionError("CONFLICT", `relationship ${operation.record.id} already exists`);
          const declaredRoles = new Map(type.roles.map((role) => [role.name, role]));
          if (Object.keys(operation.record.endpoints).length !== type.roles.length) throw new OntologyTransactionError("INVALID_OPERATION", `relationship ${type.id} requires exactly ${type.roles.length} roles`);
          for (const [roleName, objectId] of Object.entries(operation.record.endpoints)) {
            const role = declaredRoles.get(roleName);
            if (!role) throw new OntologyTransactionError("INVALID_OPERATION", `unknown relationship role ${roleName}`);
            const endpoint = requireObject(objectId);
            if (!role.endpointTypeIds.includes(endpoint.typeId)) throw new OntologyTransactionError("INVALID_OPERATION", `object ${objectId} is invalid for role ${roleName}`);
          }
          relationships.set(relationshipKey, { ...operation.record, endpoints: { ...operation.record.endpoints }, revision: 1 });
          touchedRelationships.add(operation.record.id);
          break;
        }
        case "DELETE_RELATIONSHIP": {
          const relationshipKey = key(scope, operation.id);
          const current = relationships.get(relationshipKey);
          if (!current) throw new OntologyTransactionError("NOT_FOUND", `relationship ${operation.id} not found`);
          if (current.revision !== operation.expectedRevision) throw new OntologyTransactionError("CONFLICT", `relationship ${operation.id} revision conflict`);
          relationships.delete(relationshipKey);
          touchedRelationships.add(operation.id);
          break;
        }
      }
    }

    this.objects = objects;
    this.relationships = relationships;
    return { committed: true, objectIds: [...touchedObjects], relationshipIds: [...touchedRelationships] };
  }
}

import { canonicalJson, type OntologyScope, type PropertyType, type ValidatedSchema } from "./index";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type PropertyValue = JsonValue;

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

export interface OntologyTransactionCheckpoint {
  readonly objects: readonly ObjectRecord[];
  readonly relationships: readonly RelationshipRecord[];
}

export interface RecoverableOntologyTransactionPort extends OntologyTransactionPort {
  checkpoint(): OntologyTransactionCheckpoint;
  restore(checkpoint: OntologyTransactionCheckpoint): void;
}

export class OntologyTransactionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SCOPE"
      | "INVALID_SCHEMA"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_OPERATION"
      | "IMMUTABLE_PROPERTY"
      | "INVALID_PROPERTY_VALUE"
      | "REQUIRED_PROPERTY"
      | "UNIQUE_CONSTRAINT"
      | "DERIVED_PROPERTY",
    message: string,
  ) {
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

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, cloneJson(item)]));
  }
  return value;
}

function cloneProperties(properties: Readonly<Record<string, PropertyValue>>): Readonly<Record<string, PropertyValue>> {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, cloneJson(value)]));
}

function cloneObject(record: ObjectRecord): ObjectRecord {
  return { ...record, scope: { ...record.scope }, properties: cloneProperties(record.properties) };
}

function cloneRelationship(record: RelationshipRecord): RelationshipRecord {
  return { ...record, scope: { ...record.scope }, endpoints: { ...record.endpoints } };
}

function canonicalUtc(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validJson(value: JsonValue): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJson);
  return Object.values(value).every(validJson);
}

function assertPropertyValue(property: PropertyType, value: PropertyValue): void {
  if (value === null) {
    if (property.cardinality === "REQUIRED") {
      throw new OntologyTransactionError("REQUIRED_PROPERTY", `required property ${property.id} cannot be null`);
    }
    return;
  }

  const valid = (() => {
    switch (property.valueKind) {
      case "STRING":
        return typeof value === "string";
      case "NUMBER":
        return typeof value === "number" && Number.isFinite(value);
      case "BOOLEAN":
        return typeof value === "boolean";
      case "DATETIME":
        return typeof value === "string" && canonicalUtc(value);
      case "JSON":
        return validJson(value);
    }
  })();

  if (!valid) {
    throw new OntologyTransactionError(
      "INVALID_PROPERTY_VALUE",
      `property ${property.id} requires ${property.valueKind}`,
    );
  }
}

function propertyEquals(a: PropertyValue, b: PropertyValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export class InMemoryOntologyTransactionStore implements RecoverableOntologyTransactionPort {
  private objects = new Map<string, ObjectRecord>();
  private relationships = new Map<string, RelationshipRecord>();

  checkpoint(): OntologyTransactionCheckpoint {
    return {
      objects: [...this.objects.values()].map(cloneObject),
      relationships: [...this.relationships.values()].map(cloneRelationship),
    };
  }

  restore(checkpoint: OntologyTransactionCheckpoint): void {
    this.objects = new Map(checkpoint.objects.map((record) => [key(record.scope, record.id), cloneObject(record)]));
    this.relationships = new Map(checkpoint.relationships.map((record) => [key(record.scope, record.id), cloneRelationship(record)]));
  }

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

    const materializeAndValidate = (
      objectId: string,
      typeId: string,
      incoming: Readonly<Record<string, PropertyValue>>,
      current?: ObjectRecord,
    ): Readonly<Record<string, PropertyValue>> => {
      const type = objectTypes.get(typeId);
      if (!type) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown object type ${typeId}`);

      const next: Record<string, PropertyValue> = current ? { ...current.properties } : {};

      if (!current) {
        for (const propertyId of type.propertyIds) {
          const property = propertyTypes.get(propertyId);
          if (!property) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown property ${propertyId}`);
          if (property.defaultValue !== undefined) next[propertyId] = property.defaultValue;
        }
      }

      for (const [propertyId, value] of Object.entries(incoming)) {
        if (!type.propertyIds.includes(propertyId)) {
          throw new OntologyTransactionError("INVALID_OPERATION", `property ${propertyId} is not declared on ${type.id}`);
        }
        const property = propertyTypes.get(propertyId);
        if (!property) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown property ${propertyId}`);
        if (property.derived) {
          throw new OntologyTransactionError("DERIVED_PROPERTY", `property ${propertyId} is derived and cannot be written directly`);
        }
        if (current && property.immutable && propertyId in current.properties && !propertyEquals(current.properties[propertyId]!, value)) {
          throw new OntologyTransactionError("IMMUTABLE_PROPERTY", `property ${propertyId} is immutable`);
        }
        assertPropertyValue(property, value);
        next[propertyId] = cloneJson(value);
      }

      for (const propertyId of type.propertyIds) {
        const property = propertyTypes.get(propertyId);
        if (!property) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown property ${propertyId}`);
        if (property.cardinality === "REQUIRED" && (!(propertyId in next) || next[propertyId] === null)) {
          throw new OntologyTransactionError("REQUIRED_PROPERTY", `required property ${propertyId} is missing`);
        }
        if (propertyId in next) assertPropertyValue(property, next[propertyId]!);
        if (!property.unique || !(propertyId in next) || next[propertyId] === null) continue;

        for (const existing of objects.values()) {
          if (existing.id === objectId || existing.typeId !== typeId) continue;
          if (!(propertyId in existing.properties)) continue;
          if (propertyEquals(existing.properties[propertyId]!, next[propertyId]!)) {
            throw new OntologyTransactionError(
              "UNIQUE_CONSTRAINT",
              `property ${propertyId} must be unique within scope and object type`,
            );
          }
        }
      }

      return cloneProperties(next);
    };

    for (const operation of operations) {
      switch (operation.kind) {
        case "CREATE_OBJECT": {
          if (!sameScope(scope, operation.record.scope)) throw new OntologyTransactionError("INVALID_SCOPE", "object scope mismatch");
          const type = objectTypes.get(operation.record.typeId);
          if (!type) throw new OntologyTransactionError("INVALID_SCHEMA", `unknown object type ${operation.record.typeId}`);
          const objectKey = key(scope, operation.record.id);
          if (objects.has(objectKey)) throw new OntologyTransactionError("CONFLICT", `object ${operation.record.id} already exists`);
          const properties = materializeAndValidate(
            operation.record.id,
            operation.record.typeId,
            operation.record.properties,
          );
          objects.set(objectKey, { ...operation.record, scope: { ...operation.record.scope }, properties, revision: 1 });
          touchedObjects.add(operation.record.id);
          break;
        }
        case "UPDATE_OBJECT": {
          const current = requireObject(operation.id);
          if (current.revision !== operation.expectedRevision) throw new OntologyTransactionError("CONFLICT", `object ${operation.id} revision conflict`);
          const properties = materializeAndValidate(operation.id, current.typeId, operation.properties, current);
          objects.set(key(scope, operation.id), { ...current, properties, revision: current.revision + 1 });
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
            const endpointType = objectTypes.get(endpoint.typeId);
            const satisfiesType = role.endpointTypeIds.includes(endpoint.typeId);
            const satisfiesInterface = (role.endpointInterfaceIds ?? []).some((interfaceId) => endpointType?.interfaceIds.includes(interfaceId));
            if (!satisfiesType && !satisfiesInterface) {
              throw new OntologyTransactionError("INVALID_OPERATION", `object ${objectId} is invalid for role ${roleName}`);
            }
          }
          relationships.set(relationshipKey, { ...operation.record, scope: { ...operation.record.scope }, endpoints: { ...operation.record.endpoints }, revision: 1 });
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

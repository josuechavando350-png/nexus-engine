import { createHash } from "node:crypto";

export type ScalarKind = "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME" | "JSON";
export type Cardinality = "REQUIRED" | "OPTIONAL";
export type TypeId = string;

export interface OntologyScope {
  tenantId: string;
  organizationId: string;
  brandId?: string;
}

export interface PropertyType {
  id: TypeId;
  name: string;
  valueKind: ScalarKind;
  cardinality: Cardinality;
  unique: boolean;
  immutable: boolean;
  derived?: boolean;
  defaultValue?: string | number | boolean;
}

export interface InterfaceType {
  id: TypeId;
  name: string;
  propertyIds: readonly TypeId[];
}

export interface ObjectType {
  id: TypeId;
  name: string;
  propertyIds: readonly TypeId[];
  interfaceIds: readonly TypeId[];
}

export interface RelationshipRole {
  name: string;
  endpointTypeIds: readonly TypeId[];
  endpointInterfaceIds?: readonly TypeId[];
}

export interface RelationshipType {
  id: TypeId;
  name: string;
  roles: readonly RelationshipRole[];
}

export interface EventType {
  id: TypeId;
  name: string;
  propertyIds: readonly TypeId[];
}

export interface ActionType {
  id: TypeId;
  name: string;
  targetTypeId?: TypeId;
  targetInterfaceId?: TypeId;
  inputPropertyIds: readonly TypeId[];
  permission: string;
  preconditionRefs: readonly string[];
  effectRefs: readonly string[];
  emittedEventTypeIds: readonly TypeId[];
}

export interface FunctionType {
  id: TypeId;
  name: string;
  inputPropertyIds: readonly TypeId[];
  outputPropertyIds: readonly TypeId[];
  derivedRefs: readonly string[];
  mutationEffects?: readonly string[];
}

export interface SchemaVersion {
  version: string;
  scope: OntologyScope;
  properties: readonly PropertyType[];
  interfaces: readonly InterfaceType[];
  objects: readonly ObjectType[];
  relationships: readonly RelationshipType[];
  actions: readonly ActionType[];
  functions: readonly FunctionType[];
  events: readonly EventType[];
}

export interface ValidatedSchema extends SchemaVersion {
  schemaId: string;
}

export class OntologyValidationError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "DUPLICATE" | "INVALID_REFERENCE" | "INVALID_RELATIONSHIP" | "INVALID_ACTION" | "INVALID_FUNCTION" | "SCOPE_MISMATCH", message: string) {
    super(message);
    this.name = "OntologyValidationError";
  }
}

const TYPE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LOCAL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function nonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new OntologyValidationError("INVALID_INPUT", `${field} must be non-empty`);
}

function assertTypeId(value: string, field: string): void {
  nonEmpty(value, field);
  if (!TYPE_ID.test(value)) throw new OntologyValidationError("INVALID_INPUT", `${field} is malformed`);
}

function assertName(value: string, field: string): void {
  nonEmpty(value, field);
  if (!LOCAL_NAME.test(value)) throw new OntologyValidationError("INVALID_INPUT", `${field} is malformed`);
}

function assertScope(scope: OntologyScope): void {
  nonEmpty(scope.tenantId, "scope.tenantId");
  nonEmpty(scope.organizationId, "scope.organizationId");
  if (scope.brandId !== undefined) nonEmpty(scope.brandId, "scope.brandId");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function ontologyId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function assertUniqueIds<T extends { id: string; name: string }>(items: readonly T[], kind: string): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of items) {
    assertTypeId(item.id, `${kind}.id`);
    assertName(item.name, `${kind}.name`);
    if (ids.has(item.id)) throw new OntologyValidationError("DUPLICATE", `duplicate ${kind} id ${item.id}`);
    if (names.has(item.name)) throw new OntologyValidationError("DUPLICATE", `duplicate ${kind} name ${item.name}`);
    ids.add(item.id);
    names.add(item.name);
  }
}

function assertRefs(refs: readonly string[], known: Set<string>, field: string): void {
  for (const ref of refs) if (!known.has(ref)) throw new OntologyValidationError("INVALID_REFERENCE", `${field} references undeclared id ${ref}`);
}

export function validateSchema(schema: SchemaVersion): ValidatedSchema {
  nonEmpty(schema.version, "version");
  assertScope(schema.scope);
  assertUniqueIds(schema.properties, "property");
  assertUniqueIds(schema.interfaces, "interface");
  assertUniqueIds(schema.objects, "object");
  assertUniqueIds(schema.relationships, "relationship");
  assertUniqueIds(schema.actions, "action");
  assertUniqueIds(schema.functions, "function");
  assertUniqueIds(schema.events, "event");

  const propertyIds = new Set(schema.properties.map((item) => item.id));
  const interfaceIds = new Set(schema.interfaces.map((item) => item.id));
  const objectIds = new Set(schema.objects.map((item) => item.id));
  const eventIds = new Set(schema.events.map((item) => item.id));

  for (const property of schema.properties) {
    if (property.immutable && property.derived) throw new OntologyValidationError("INVALID_INPUT", `${property.id} cannot be immutable and derived`);
    if (typeof property.defaultValue === "number" && !Number.isFinite(property.defaultValue)) throw new OntologyValidationError("INVALID_INPUT", `${property.id} defaultValue must be finite`);
  }

  for (const iface of schema.interfaces) assertRefs(iface.propertyIds, propertyIds, `${iface.id}.propertyIds`);
  for (const object of schema.objects) {
    assertRefs(object.propertyIds, propertyIds, `${object.id}.propertyIds`);
    assertRefs(object.interfaceIds, interfaceIds, `${object.id}.interfaceIds`);
  }
  for (const event of schema.events) assertRefs(event.propertyIds, propertyIds, `${event.id}.propertyIds`);

  for (const relationship of schema.relationships) {
    if (relationship.roles.length < 2) throw new OntologyValidationError("INVALID_RELATIONSHIP", `${relationship.id} requires at least two roles`);
    const roleNames = new Set<string>();
    for (const role of relationship.roles) {
      assertName(role.name, `${relationship.id}.role.name`);
      if (roleNames.has(role.name)) throw new OntologyValidationError("DUPLICATE", `${relationship.id} has duplicate role ${role.name}`);
      roleNames.add(role.name);
      if (role.endpointTypeIds.length === 0 && (role.endpointInterfaceIds?.length ?? 0) === 0) throw new OntologyValidationError("INVALID_RELATIONSHIP", `${relationship.id}.${role.name} requires an endpoint`);
      assertRefs(role.endpointTypeIds, objectIds, `${relationship.id}.${role.name}.endpointTypeIds`);
      assertRefs(role.endpointInterfaceIds ?? [], interfaceIds, `${relationship.id}.${role.name}.endpointInterfaceIds`);
    }
  }

  for (const action of schema.actions) {
    nonEmpty(action.permission, `${action.id}.permission`);
    if (!action.targetTypeId && !action.targetInterfaceId) throw new OntologyValidationError("INVALID_ACTION", `${action.id} requires a target`);
    if (action.targetTypeId && !objectIds.has(action.targetTypeId)) throw new OntologyValidationError("INVALID_ACTION", `${action.id} target type is undeclared`);
    if (action.targetInterfaceId && !interfaceIds.has(action.targetInterfaceId)) throw new OntologyValidationError("INVALID_ACTION", `${action.id} target interface is undeclared`);
    assertRefs(action.inputPropertyIds, propertyIds, `${action.id}.inputPropertyIds`);
    assertRefs(action.emittedEventTypeIds, eventIds, `${action.id}.emittedEventTypeIds`);
  }

  for (const fn of schema.functions) {
    assertRefs(fn.inputPropertyIds, propertyIds, `${fn.id}.inputPropertyIds`);
    assertRefs(fn.outputPropertyIds, propertyIds, `${fn.id}.outputPropertyIds`);
    if ((fn.mutationEffects?.length ?? 0) > 0) throw new OntologyValidationError("INVALID_FUNCTION", `${fn.id} cannot declare mutation effects`);
  }

  const canonical = {
    ...schema,
    properties: [...schema.properties].sort((a, b) => a.id.localeCompare(b.id, "en")),
    interfaces: [...schema.interfaces].sort((a, b) => a.id.localeCompare(b.id, "en")),
    objects: [...schema.objects].sort((a, b) => a.id.localeCompare(b.id, "en")),
    relationships: [...schema.relationships].sort((a, b) => a.id.localeCompare(b.id, "en")),
    actions: [...schema.actions].sort((a, b) => a.id.localeCompare(b.id, "en")),
    functions: [...schema.functions].sort((a, b) => a.id.localeCompare(b.id, "en")),
    events: [...schema.events].sort((a, b) => a.id.localeCompare(b.id, "en"))
  };
  return { ...schema, schemaId: ontologyId("schema", canonical) };
}

export function composeSchemas(schemas: readonly ValidatedSchema[]): ValidatedSchema[] {
  if (schemas.length === 0) return [];
  const scope = schemas[0]!.scope;
  for (const schema of schemas) {
    if (schema.scope.tenantId !== scope.tenantId || schema.scope.organizationId !== scope.organizationId || schema.scope.brandId !== scope.brandId) {
      throw new OntologyValidationError("SCOPE_MISMATCH", "cross-scope schema composition is forbidden");
    }
  }
  return [...schemas];
}

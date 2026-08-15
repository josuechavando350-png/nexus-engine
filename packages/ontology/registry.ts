import { ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "./index";

export type MigrationSafety = "SAFE" | "REQUIRES_BACKFILL" | "BREAKING";

export interface SchemaMigrationStep {
  readonly id: string;
  readonly description: string;
  readonly safety: MigrationSafety;
  readonly reversible: boolean;
}

export interface SchemaMigrationPlan {
  readonly migrationId: string;
  readonly scope: OntologyScope;
  readonly fromSchemaId: string;
  readonly toSchemaId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly steps: readonly SchemaMigrationStep[];
}

export interface SchemaRegistryPort {
  register(schema: SchemaVersion, previousSchemaId?: string): ValidatedSchema;
  get(schemaId: string): ValidatedSchema | undefined;
  getLatest(scope: OntologyScope): ValidatedSchema | undefined;
  list(scope: OntologyScope): readonly ValidatedSchema[];
  planMigration(fromSchemaId: string, toSchemaId: string, steps: readonly Omit<SchemaMigrationStep, "id">[]): SchemaMigrationPlan;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function parseCore(version: string): readonly [number, number, number] {
  if (!SEMVER.test(version)) throw new Error(`schema version ${version} must be semantic versioning`);
  const [major, minor, patch] = version.split(/[+-]/, 1)[0]!.split(".").map(Number);
  return [major!, minor!, patch!];
}

function compareVersions(a: string, b: string): number {
  const aa = parseCore(a);
  const bb = parseCore(b);
  for (let index = 0; index < 3; index += 1) {
    if (aa[index]! !== bb[index]!) return aa[index]! - bb[index]!;
  }
  return a.localeCompare(b, "en");
}

export class InMemorySchemaRegistry implements SchemaRegistryPort {
  private readonly schemas = new Map<string, ValidatedSchema>();
  private readonly histories = new Map<string, string[]>();

  register(schema: SchemaVersion, previousSchemaId?: string): ValidatedSchema {
    parseCore(schema.version);
    const validated = validateSchema(schema);
    const key = scopeKey(validated.scope);
    const history = this.histories.get(key) ?? [];
    const latestId = history.at(-1);

    if (this.schemas.has(validated.schemaId)) return this.schemas.get(validated.schemaId)!;

    if (latestId !== undefined) {
      if (previousSchemaId !== latestId) throw new Error("schema registration must extend the latest schema for its scope");
      const latest = this.schemas.get(latestId)!;
      if (compareVersions(validated.version, latest.version) <= 0) throw new Error("schema version must increase monotonically within a scope");
    } else if (previousSchemaId !== undefined) {
      throw new Error("initial schema registration cannot declare a previous schema");
    }

    this.schemas.set(validated.schemaId, validated);
    this.histories.set(key, [...history, validated.schemaId]);
    return validated;
  }

  get(schemaId: string): ValidatedSchema | undefined {
    return this.schemas.get(schemaId);
  }

  getLatest(scope: OntologyScope): ValidatedSchema | undefined {
    const ids = this.histories.get(scopeKey(scope));
    const schemaId = ids?.at(-1);
    return schemaId ? this.schemas.get(schemaId) : undefined;
  }

  list(scope: OntologyScope): readonly ValidatedSchema[] {
    return (this.histories.get(scopeKey(scope)) ?? []).map((schemaId) => this.schemas.get(schemaId)!);
  }

  planMigration(fromSchemaId: string, toSchemaId: string, steps: readonly Omit<SchemaMigrationStep, "id">[]): SchemaMigrationPlan {
    const from = this.schemas.get(fromSchemaId);
    const to = this.schemas.get(toSchemaId);
    if (!from || !to) throw new Error("migration endpoints must be registered schemas");
    if (!sameScope(from.scope, to.scope)) throw new Error("cross-scope schema migration is forbidden");
    if (compareVersions(to.version, from.version) <= 0) throw new Error("migration target version must be newer than source version");
    if (steps.length === 0) throw new Error("migration plan requires at least one explicit step");

    const normalizedSteps = steps.map((step, index) => {
      if (!step.description.trim()) throw new Error("migration step description must be non-empty");
      return { ...step, id: ontologyId("migration-step", { fromSchemaId, toSchemaId, index, ...step }) };
    });

    return {
      migrationId: ontologyId("migration", { fromSchemaId, toSchemaId, steps: normalizedSteps }),
      scope: from.scope,
      fromSchemaId,
      toSchemaId,
      fromVersion: from.version,
      toVersion: to.version,
      steps: normalizedSteps
    };
  }
}

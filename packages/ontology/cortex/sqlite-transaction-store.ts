import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type OntologyScope, type ValidatedSchema } from "../index";
import {
  InMemoryOntologyTransactionStore,
  type JsonValue,
  type ObjectRecord,
  type OntologyTransactionCheckpoint,
  type OntologyTransactionPort,
  type RelationshipRecord,
  type TransactionOperation,
  type TransactionResult,
  type TransactionStoreLimits,
} from "../transaction";

const SCHEMA_VERSION = "1";
const DEFAULT_LIMITS: TransactionStoreLimits = Object.freeze({
  maxObjectsPerScope: 100_000,
  maxRelationshipsPerScope: 100_000,
});

export interface SqliteOntologyTransactionStoreOptions {
  readonly busyTimeoutMs?: number;
  readonly limits?: TransactionStoreLimits;
  readonly allowInMemory?: boolean;
  readonly onTransaction?: (event: SqliteOntologyTransactionEvent) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}

export interface SqliteOntologyTransactionEvent {
  readonly scope: OntologyScope;
  readonly operationCount: number;
  readonly objectIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly durationMs: number;
}

export class SqliteOntologyStoreError extends Error {
  constructor(
    public readonly code: "INVALID_PATH" | "SCHEMA_MISMATCH" | "CORRUPT_RECORD" | "CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "SqliteOntologyStoreError";
  }
}

interface ObjectRow {
  readonly id: string;
  readonly type_id: string;
  readonly properties_json: string;
  readonly revision: number;
}

interface RelationshipRow {
  readonly id: string;
  readonly type_id: string;
  readonly endpoints_json: string;
  readonly revision: number;
}

function scopeKey(scope: OntologyScope): string {
  return canonicalJson({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    brandId: scope.brandId ?? null,
  });
}

function validateBusyTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new SqliteOntologyStoreError("INVALID_PATH", "busyTimeoutMs must be an integer from 0 to 60000");
  }
  return timeout;
}

function parseJsonObject(value: string, label: string): Readonly<Record<string, JsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SqliteOntologyStoreError("CORRUPT_RECORD", `${label} contains malformed JSON`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SqliteOntologyStoreError("CORRUPT_RECORD", `${label} must contain a JSON object`);
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function validateRevision(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SqliteOntologyStoreError("CORRUPT_RECORD", `${label} has an invalid revision`);
  }
  return value;
}

export class SqliteOntologyTransactionStore implements OntologyTransactionPort {
  private readonly database: DatabaseSync;
  private readonly limits: TransactionStoreLimits;
  private readonly onTransaction?: (event: SqliteOntologyTransactionEvent) => void;
  private readonly onTelemetryError?: (error: unknown) => void;
  private closed = false;

  constructor(path: string, options: SqliteOntologyTransactionStoreOptions = {}) {
    const normalized = path.trim();
    if (!normalized) throw new SqliteOntologyStoreError("INVALID_PATH", "SQLite path must not be empty");
    if (normalized === ":memory:" && options.allowInMemory !== true) {
      throw new SqliteOntologyStoreError("INVALID_PATH", "in-memory SQLite is disabled unless allowInMemory is explicitly true");
    }

    const databasePath = normalized === ":memory:" ? normalized : resolve(normalized);
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.onTransaction = options.onTransaction;
    this.onTelemetryError = options.onTelemetryError;
    this.database = new DatabaseSync(databasePath, {
      timeout: validateBusyTimeout(options.busyTimeoutMs),
      allowExtension: false,
    });
    this.initialize();
  }

  private assertOpen(): void {
    if (this.closed) throw new SqliteOntologyStoreError("CLOSED", "SQLite ontology store is closed");
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS cortex_ontology_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cortex_ontology_objects (
        scope_key TEXT NOT NULL,
        id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (scope_key, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cortex_ontology_relationships (
        scope_key TEXT NOT NULL,
        id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        endpoints_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (scope_key, id)
      ) STRICT;
      INSERT OR IGNORE INTO cortex_ontology_metadata(key, value)
      VALUES ('schema_version', '${SCHEMA_VERSION}');
    `);
    const row = this.database.prepare(
      "SELECT value FROM cortex_ontology_metadata WHERE key = 'schema_version'",
    ).get() as { value?: unknown } | undefined;
    if (row?.value !== SCHEMA_VERSION) {
      throw new SqliteOntologyStoreError(
        "SCHEMA_MISMATCH",
        `unsupported SQLite ontology schema version ${String(row?.value ?? "missing")}`,
      );
    }
  }

  private readObject(scope: OntologyScope, row: ObjectRow): ObjectRecord {
    return Object.freeze({
      id: row.id,
      typeId: row.type_id,
      scope: Object.freeze({ ...scope }),
      properties: Object.freeze(parseJsonObject(row.properties_json, `object ${row.id}`)),
      revision: validateRevision(row.revision, `object ${row.id}`),
    });
  }

  private readRelationship(scope: OntologyScope, row: RelationshipRow): RelationshipRecord {
    const endpoints = parseJsonObject(row.endpoints_json, `relationship ${row.id}`);
    for (const [role, endpoint] of Object.entries(endpoints)) {
      if (typeof endpoint !== "string" || !endpoint) {
        throw new SqliteOntologyStoreError("CORRUPT_RECORD", `relationship ${row.id} has invalid endpoint ${role}`);
      }
    }
    return Object.freeze({
      id: row.id,
      typeId: row.type_id,
      scope: Object.freeze({ ...scope }),
      endpoints: Object.freeze(endpoints as Readonly<Record<string, string>>),
      revision: validateRevision(row.revision, `relationship ${row.id}`),
    });
  }

  private checkpoint(scope: OntologyScope): OntologyTransactionCheckpoint {
    const key = scopeKey(scope);
    const objectRows = this.database.prepare(
      "SELECT id, type_id, properties_json, revision FROM cortex_ontology_objects WHERE scope_key = ? ORDER BY id",
    ).all(key) as unknown as ObjectRow[];
    const relationshipRows = this.database.prepare(
      "SELECT id, type_id, endpoints_json, revision FROM cortex_ontology_relationships WHERE scope_key = ? ORDER BY id",
    ).all(key) as unknown as RelationshipRow[];
    return Object.freeze({
      objects: Object.freeze(objectRows.map((row) => this.readObject(scope, row))),
      relationships: Object.freeze(relationshipRows.map((row) => this.readRelationship(scope, row))),
    });
  }

  getObject(scope: OntologyScope, id: string): ObjectRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT id, type_id, properties_json, revision FROM cortex_ontology_objects WHERE scope_key = ? AND id = ?",
    ).get(scopeKey(scope), id) as unknown as ObjectRow | undefined;
    return row ? this.readObject(scope, row) : undefined;
  }

  getRelationship(scope: OntologyScope, id: string): RelationshipRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT id, type_id, endpoints_json, revision FROM cortex_ontology_relationships WHERE scope_key = ? AND id = ?",
    ).get(scopeKey(scope), id) as unknown as RelationshipRow | undefined;
    return row ? this.readRelationship(scope, row) : undefined;
  }

  transact(
    scope: OntologyScope,
    schema: ValidatedSchema,
    operations: readonly TransactionOperation[],
  ): TransactionResult {
    this.assertOpen();
    const startedAt = performance.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const working = new InMemoryOntologyTransactionStore(this.limits);
      working.restore(this.checkpoint(scope));
      const result = working.transact(scope, schema, operations);
      const key = scopeKey(scope);
      const upsertObject = this.database.prepare(`
        INSERT INTO cortex_ontology_objects(scope_key, id, type_id, properties_json, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, id) DO UPDATE SET
          type_id = excluded.type_id,
          properties_json = excluded.properties_json,
          revision = excluded.revision
      `);
      const deleteObject = this.database.prepare(
        "DELETE FROM cortex_ontology_objects WHERE scope_key = ? AND id = ?",
      );
      const upsertRelationship = this.database.prepare(`
        INSERT INTO cortex_ontology_relationships(scope_key, id, type_id, endpoints_json, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, id) DO UPDATE SET
          type_id = excluded.type_id,
          endpoints_json = excluded.endpoints_json,
          revision = excluded.revision
      `);
      const deleteRelationship = this.database.prepare(
        "DELETE FROM cortex_ontology_relationships WHERE scope_key = ? AND id = ?",
      );

      for (const id of result.objectIds) {
        const record = working.getObject(scope, id);
        if (record) {
          upsertObject.run(key, record.id, record.typeId, canonicalJson(record.properties), record.revision);
        } else {
          deleteObject.run(key, id);
        }
      }
      for (const id of result.relationshipIds) {
        const record = working.getRelationship(scope, id);
        if (record) {
          upsertRelationship.run(key, record.id, record.typeId, canonicalJson(record.endpoints), record.revision);
        } else {
          deleteRelationship.run(key, id);
        }
      }
      this.database.exec("COMMIT");
      const telemetryEvent = Object.freeze({
        scope: Object.freeze({ ...scope }),
        operationCount: operations.length,
        objectIds: Object.freeze([...result.objectIds]),
        relationshipIds: Object.freeze([...result.relationshipIds]),
        durationMs: performance.now() - startedAt,
      });
      if (this.onTransaction) {
        try {
          this.onTransaction(telemetryEvent);
        } catch (error) {
          try {
            this.onTelemetryError?.(error);
          } catch {
            // A post-commit telemetry sink must never change transaction semantics.
          }
        }
      }
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

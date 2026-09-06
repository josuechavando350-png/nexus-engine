import { validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";
import type { EnhancedConversionMode } from "./index";

const TYPE = "cortex.enhanced_conversion_control";
const MODE = "cortex.enhanced_conversion_control.mode";
const UPDATED_AT = "cortex.enhanced_conversion_control.updated_at";
const CONTROL_ID = "cortex-enhanced-conversion-control";

export interface EnhancedConversionControlState {
  readonly mode: EnhancedConversionMode;
  readonly revision: number;
  readonly updatedAt: string;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const version: SchemaVersion = {
    version: "cortex-enhanced-conversion-control-v1",
    scope,
    properties: [
      { id: MODE, name: "EnhancedConversionControlMode", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false },
      { id: UPDATED_AT, name: "EnhancedConversionControlUpdatedAt", valueKind: "DATETIME", cardinality: "REQUIRED", unique: false, immutable: false },
    ],
    interfaces: [],
    objects: [{ id: TYPE, name: "CortexEnhancedConversionControl", propertyIds: [MODE, UPDATED_AT], interfaceIds: [] }],
    relationships: [], actions: [], functions: [], events: [],
  };
  return validateSchema(version);
}

function parseMode(value: unknown): EnhancedConversionMode {
  if (value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED") return value;
  throw new Error("stored enhanced-conversion control mode is invalid");
}

export class DurableEnhancedConversionControl {
  private readonly validatedSchema: ValidatedSchema;
  constructor(
    private readonly transactions: OntologyTransactionPort,
    private readonly scope: OntologyScope,
    private readonly now: () => number = Date.now,
  ) {
    this.validatedSchema = schema(scope);
  }

  read(): EnhancedConversionControlState {
    const record = this.transactions.getObject(this.scope, CONTROL_ID);
    if (!record) return Object.freeze({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    if (record.typeId !== TYPE) throw new Error("enhanced-conversion control type is corrupt");
    const updatedAt = record.properties[UPDATED_AT];
    if (typeof updatedAt !== "string" || new Date(updatedAt).toISOString() !== updatedAt) throw new Error("enhanced-conversion control updatedAt is corrupt");
    return Object.freeze({ mode: parseMode(record.properties[MODE]), revision: record.revision, updatedAt });
  }

  setMode(next: EnhancedConversionMode, expectedRevision: number): EnhancedConversionControlState {
    if (!(next === "ACTIVE" || next === "OBSERVE_ONLY" || next === "KILLED")) throw new Error("enhanced-conversion control mode is invalid");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("enhanced-conversion expectedRevision is invalid");
    const current = this.read();
    if (current.revision !== expectedRevision) throw new Error("enhanced-conversion control revision conflict");
    const updatedAt = new Date(this.now()).toISOString();
    const operation: TransactionOperation = current.revision === 0
      ? { kind: "CREATE_OBJECT", record: { id: CONTROL_ID, typeId: TYPE, scope: this.scope, properties: { [MODE]: next, [UPDATED_AT]: updatedAt } } }
      : { kind: "UPDATE_OBJECT", id: CONTROL_ID, expectedRevision: current.revision, properties: { [MODE]: next, [UPDATED_AT]: updatedAt } };
    try {
      this.transactions.transact(this.scope, this.validatedSchema, [operation]);
    } catch (error) {
      if (error instanceof OntologyTransactionError && (error.code === "CONFLICT" || error.code === "UNIQUE_CONSTRAINT")) {
        throw new Error("enhanced-conversion control revision conflict", { cause: error });
      }
      throw error;
    }
    return this.read();
  }
}

import { DatabaseSync } from "node:sqlite";
import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import { DurableEnhancedConversionsPipeline, EnhancedConversionError, type EnhancedConversionGateway, type EnhancedConversionMode, type EnhancedConversionRecord } from "../enhanced-conversions/index";
import type { DataManagerConversionEvent, DataManagerDestination } from "../enhanced-conversions/data-manager-rest";
import { SqlitePymeConsentRegistry } from "./consent-registry";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;

export interface PymeEnhancedConversionsPrivacyConfig {
  readonly databasePath: string;
  readonly transactions: OntologyTransactionPort;
  readonly scope: OntologyScope;
  readonly destination: DataManagerDestination;
  readonly gateway: EnhancedConversionGateway;
  readonly modeProvider: () => EnhancedConversionMode;
  readonly consentRegistry: SqlitePymeConsentRegistry;
  readonly consentPurpose?: string;
  readonly now?: () => number;
}

export class PymeEnhancedConversionsPrivacyLayer {
  private readonly db: DatabaseSync;
  private readonly purpose: string;
  private readonly pipeline: DurableEnhancedConversionsPipeline;
  private readonly now: () => number;

  constructor(private readonly config: PymeEnhancedConversionsPrivacyConfig) {
    if (!config.databasePath) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion databasePath is required");
    this.purpose = (config.consentPurpose ?? "ads_measurement").trim();
    if (!ID.test(this.purpose)) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion consent purpose is invalid");
    this.now = config.now ?? Date.now;
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex_pyme_conversion_subject(
      transaction_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );`);
    this.pipeline = new DurableEnhancedConversionsPipeline(
      config.transactions,
      config.scope,
      config.destination,
      config.gateway,
      config.modeProvider,
      this.now,
      undefined,
      (event) => this.assertFinalConsent(event),
    );
  }

  close(): void { this.db.close(); }

  private binding(transactionId: string): { subjectId: `sha256:${string}`; purpose: string } {
    const row = this.db.prepare("SELECT subject_id,purpose FROM cortex_pyme_conversion_subject WHERE transaction_id=?").get(transactionId) as Record<string, unknown> | undefined;
    if (!row || typeof row.subject_id !== "string" || !SHA256.test(row.subject_id) || typeof row.purpose !== "string" || !ID.test(row.purpose)) throw new EnhancedConversionError("INTEGRITY_FAILURE", "PyME conversion consent binding is missing or corrupt");
    return { subjectId: row.subject_id as `sha256:${string}`, purpose: row.purpose };
  }

  private assertFinalConsent(event: DataManagerConversionEvent): void {
    const binding = this.binding(event.transactionId);
    const decision = this.config.consentRegistry.authorize(binding.subjectId, "ENHANCED_CONVERSIONS", binding.purpose, event.transactionId, new Date(this.now()).toISOString());
    if (!decision.authorized) throw new EnhancedConversionError("CONSENT_VIOLATION", `central consent registry blocks enhanced conversion: ${decision.reason}`);
  }

  prepare(subjectId: `sha256:${string}`, value: unknown): EnhancedConversionRecord {
    if (!SHA256.test(subjectId)) throw new EnhancedConversionError("INVALID_INPUT", "PyME conversion subjectId must be sha256");
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).transactionId !== "string") throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion input is missing transactionId");
    const transactionId = String((value as Record<string, unknown>).transactionId).trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u.test(transactionId)) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion transactionId is malformed");
    const consent = this.config.consentRegistry.authorize(subjectId, "ENHANCED_CONVERSIONS", this.purpose, transactionId, new Date(this.now()).toISOString());
    if (!consent.authorized) throw new EnhancedConversionError("CONSENT_VIOLATION", `central consent registry blocks enhanced conversion preparation: ${consent.reason}`);
    const existing = this.db.prepare("SELECT subject_id,purpose FROM cortex_pyme_conversion_subject WHERE transaction_id=?").get(transactionId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.subject_id !== subjectId || existing.purpose !== this.purpose) throw new EnhancedConversionError("CONFLICT", "transactionId is already bound to another PyME consent subject or purpose");
    } else {
      this.db.prepare("INSERT INTO cortex_pyme_conversion_subject(transaction_id,subject_id,purpose,bound_at) VALUES(?,?,?,?)").run(transactionId, subjectId, this.purpose, new Date(this.now()).toISOString());
    }
    return this.pipeline.prepare(value);
  }

  async dispatch(transactionId: string): Promise<EnhancedConversionRecord> {
    const record = await this.pipeline.dispatch(transactionId);
    if (record.status === "SENT") {
      const binding = this.binding(record.transactionId);
      this.config.consentRegistry.recordUse(binding.subjectId, "ENHANCED_CONVERSIONS", binding.purpose, "DISPATCHED", record.transactionId, "DATA_MANAGER_DISPATCH", new Date(this.now()).toISOString());
    }
    return record;
  }

  rollback(transactionId: string): EnhancedConversionRecord { return this.pipeline.rollback(transactionId); }
  get(transactionId: string): EnhancedConversionRecord | undefined { return this.pipeline.get(transactionId); }
}

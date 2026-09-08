import { DatabaseSync } from "node:sqlite";
import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import { DurableEnhancedConversionsPipeline, EnhancedConversionError, observeEnhancedConversionInput, type EnhancedConversionGateway, type EnhancedConversionMode, type EnhancedConversionRecord } from "../enhanced-conversions/index";
import type { DataManagerConversionEvent, DataManagerDestination } from "../enhanced-conversions/data-manager-rest";
import { SqlitePymeConsentRegistry } from "./consent-registry";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u;

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
    if (event.adUserDataConsent !== "GRANTED") throw new EnhancedConversionError("CONSENT_VIOLATION", "PyME enhanced conversions require explicit granted ad-user-data consent");
    const binding = this.binding(event.transactionId);
    const decision = this.config.consentRegistry.authorize(binding.subjectId, "ENHANCED_CONVERSIONS", binding.purpose, event.transactionId, new Date(this.now()).toISOString());
    if (!decision.authorized) throw new EnhancedConversionError("CONSENT_VIOLATION", `central consent registry blocks enhanced conversion: ${decision.reason}`);
  }

  prepare(subjectId: `sha256:${string}`, value: unknown): EnhancedConversionRecord {
    if (!SHA256.test(subjectId)) throw new EnhancedConversionError("INVALID_INPUT", "PyME conversion subjectId must be sha256");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion input must be an object");
    const raw = value as Record<string, unknown>;
    if (typeof raw.transactionId !== "string" || !TRANSACTION_ID.test(raw.transactionId.trim())) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion transactionId is malformed");
    if (raw.adUserDataConsent !== "GRANTED") throw new EnhancedConversionError("CONSENT_VIOLATION", "PyME enhanced conversion input must carry GRANTED adUserDataConsent");
    const transactionId = raw.transactionId.trim();
    const consent = this.config.consentRegistry.authorize(subjectId, "ENHANCED_CONVERSIONS", this.purpose, transactionId, new Date(this.now()).toISOString());
    if (!consent.authorized) throw new EnhancedConversionError("CONSENT_VIOLATION", `central consent registry blocks enhanced conversion preparation: ${consent.reason}`);

    const existing = this.db.prepare("SELECT subject_id,purpose FROM cortex_pyme_conversion_subject WHERE transaction_id=?").get(transactionId) as Record<string, unknown> | undefined;
    let insertedBinding = false;
    if (existing) {
      if (existing.subject_id !== subjectId || existing.purpose !== this.purpose) throw new EnhancedConversionError("CONFLICT", "transactionId is already bound to another PyME consent subject or purpose");
    } else {
      this.db.prepare("INSERT INTO cortex_pyme_conversion_subject(transaction_id,subject_id,purpose,bound_at) VALUES(?,?,?,?)").run(transactionId, subjectId, this.purpose, new Date(this.now()).toISOString());
      insertedBinding = true;
    }
    try {
      return this.pipeline.prepare(value);
    } catch (error) {
      if (insertedBinding) {
        try { this.db.prepare("DELETE FROM cortex_pyme_conversion_subject WHERE transaction_id=? AND subject_id=? AND purpose=?").run(transactionId, subjectId, this.purpose); } catch { /* stale binding is safe and fails closed; preserve original error */ }
      }
      throw error;
    }
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

interface PymeEnhancedConversionEnvelope {
  readonly subjectId: `sha256:${string}`;
  readonly event: unknown;
}

function envelope(value: unknown): PymeEnhancedConversionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion request must be a plain envelope");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "event,subjectId" || typeof raw.subjectId !== "string" || !SHA256.test(raw.subjectId)) throw new EnhancedConversionError("INVALID_INPUT", "PyME enhanced conversion envelope must contain subjectId and event");
  return Object.freeze({ subjectId: raw.subjectId as `sha256:${string}`, event: raw.event });
}

export class PymeEnhancedConversionProductionEngine {
  constructor(private readonly layer: PymeEnhancedConversionsPrivacyLayer) {}
  prepare(value: unknown): EnhancedConversionRecord { const parsed = envelope(value); return this.layer.prepare(parsed.subjectId, parsed.event); }
  dispatch(transactionId: string): Promise<EnhancedConversionRecord> { return this.layer.dispatch(transactionId); }
  rollback(transactionId: string): EnhancedConversionRecord { return this.layer.rollback(transactionId); }
  get(transactionId: string): EnhancedConversionRecord | undefined { return this.layer.get(transactionId); }
  observe(value: unknown): unknown { return observeEnhancedConversionInput(envelope(value).event); }
  close(): void { this.layer.close(); }
}

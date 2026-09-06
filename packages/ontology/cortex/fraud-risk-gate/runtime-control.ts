import { DatabaseSync } from "node:sqlite";

export type RiskGateMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export interface RiskGateControlState { readonly mode: RiskGateMode; readonly revision: number; readonly updatedAt: string; }

export class RiskGateControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "RiskGateControlError";
  }
}

function validMode(value: unknown): value is RiskGateMode {
  return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED";
}

export class SqliteRiskGateControl {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new RiskGateControlError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex14_control(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      mode TEXT NOT NULL CHECK(mode IN ('ACTIVE','OBSERVE_ONLY','KILLED')),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  read(): RiskGateControlState {
    const row = this.db.prepare("SELECT mode,revision,updated_at FROM cortex14_control WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!row) return Object.freeze({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    if (!validMode(row.mode)) throw new RiskGateControlError("INTEGRITY_FAILURE", "stored risk gate mode is invalid");
    const revision = Number(row.revision);
    const updatedAt = String(row.updated_at);
    const timestamp = new Date(updatedAt);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== updatedAt) {
      throw new RiskGateControlError("INTEGRITY_FAILURE", "stored risk gate control is corrupt");
    }
    return Object.freeze({ mode: row.mode, revision, updatedAt });
  }

  initialize(mode: RiskGateMode): RiskGateControlState {
    if (!validMode(mode)) throw new RiskGateControlError("INVALID_INPUT", "initial risk gate mode is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if (current.revision > 0) {
        this.db.exec("COMMIT");
        return current;
      }
      const updatedAt = new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO cortex14_control(singleton,mode,revision,updated_at) VALUES(1,?,1,?)").run(mode, updatedAt);
      this.db.exec("COMMIT");
      return this.read();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setMode(mode: RiskGateMode, expectedRevision: number): RiskGateControlState {
    if (!validMode(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new RiskGateControlError("INVALID_INPUT", "risk gate control request is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new RiskGateControlError("CONFLICT", "risk gate control revision conflict");
      const updatedAt = new Date(this.now()).toISOString();
      const result = this.db.prepare("UPDATE cortex14_control SET mode=?,revision=revision+1,updated_at=? WHERE singleton=1 AND revision=?").run(mode, updatedAt, expectedRevision);
      if (result.changes !== 1) throw new RiskGateControlError("CONFLICT", "risk gate control revision conflict");
      this.db.exec("COMMIT");
      return this.read();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

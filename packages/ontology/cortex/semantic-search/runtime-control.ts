import { DatabaseSync } from "node:sqlite";

export type Cortex15Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export interface Cortex15ControlState { readonly mode: Cortex15Mode; readonly revision: number; readonly updatedAt: string; }

export class Cortex15ControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) { super(message); this.name = "Cortex15ControlError"; }
}

function validMode(value: unknown): value is Cortex15Mode { return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED"; }

export class SqliteCortex15Control {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex15ControlError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS cortex15_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL CHECK(mode IN ('ACTIVE','OBSERVE_ONLY','KILLED')),revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL);");
  }
  close(): void { this.db.close(); }
  read(): Cortex15ControlState {
    const row = this.db.prepare("SELECT mode,revision,updated_at FROM cortex15_control WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!row) return Object.freeze({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    if (!validMode(row.mode)) throw new Cortex15ControlError("INTEGRITY_FAILURE", "stored mode is invalid");
    const revision = Number(row.revision); const updatedAt = String(row.updated_at); const date = new Date(updatedAt);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(date.getTime()) || date.toISOString() !== updatedAt) throw new Cortex15ControlError("INTEGRITY_FAILURE", "stored control is corrupt");
    return Object.freeze({ mode: row.mode, revision, updatedAt });
  }
  setMode(mode: Cortex15Mode, expectedRevision: number): Cortex15ControlState {
    if (!validMode(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Cortex15ControlError("INVALID_INPUT", "control request is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read(); if (current.revision !== expectedRevision) throw new Cortex15ControlError("CONFLICT", "control revision conflict");
      const updatedAt = new Date(this.now()).toISOString();
      if (expectedRevision === 0) this.db.prepare("INSERT INTO cortex15_control(singleton,mode,revision,updated_at) VALUES(1,?,1,?)").run(mode, updatedAt);
      else {
        const result = this.db.prepare("UPDATE cortex15_control SET mode=?,revision=revision+1,updated_at=? WHERE singleton=1 AND revision=?").run(mode, updatedAt, expectedRevision);
        if (result.changes !== 1) throw new Cortex15ControlError("CONFLICT", "control revision conflict");
      }
      this.db.exec("COMMIT"); return this.read();
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}

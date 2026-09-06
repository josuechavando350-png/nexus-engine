import { DatabaseSync } from "node:sqlite";

export type GeoHoldoutMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export interface GeoHoldoutControlState { readonly mode: GeoHoldoutMode; readonly revision: number; readonly updatedAt: string; }

export class GeoHoldoutControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "GeoHoldoutControlError";
  }
}

export class SqliteGeoHoldoutControl {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new GeoHoldoutControlError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex12_control(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      mode TEXT NOT NULL CHECK(mode IN ('ACTIVE','OBSERVE_ONLY','KILLED')),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at TEXT NOT NULL
    );`);
  }
  close(): void { this.db.close(); }
  read(): GeoHoldoutControlState {
    const row = this.db.prepare("SELECT mode,revision,updated_at FROM cortex12_control WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!row) return Object.freeze({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    if (!(row.mode === "ACTIVE" || row.mode === "OBSERVE_ONLY" || row.mode === "KILLED")) throw new GeoHoldoutControlError("INTEGRITY_FAILURE", "stored geo holdout mode is invalid");
    const revision = Number(row.revision); const updatedAt = String(row.updated_at); const parsed = new Date(updatedAt);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== updatedAt) throw new GeoHoldoutControlError("INTEGRITY_FAILURE", "stored geo holdout control is corrupt");
    return Object.freeze({ mode: row.mode, revision, updatedAt });
  }
  setMode(mode: GeoHoldoutMode, expectedRevision: number): GeoHoldoutControlState {
    if (!(mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED") || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new GeoHoldoutControlError("INVALID_INPUT", "geo holdout control request is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new GeoHoldoutControlError("CONFLICT", "geo holdout control revision conflict");
      const updatedAt = new Date(this.now()).toISOString();
      if (current.revision === 0) this.db.prepare("INSERT INTO cortex12_control(singleton,mode,revision,updated_at) VALUES(1,?,1,?)").run(mode, updatedAt);
      else {
        const result = this.db.prepare("UPDATE cortex12_control SET mode=?,revision=revision+1,updated_at=? WHERE singleton=1 AND revision=?").run(mode, updatedAt, expectedRevision);
        if (result.changes !== 1) throw new GeoHoldoutControlError("CONFLICT", "geo holdout control revision conflict");
      }
      this.db.exec("COMMIT"); return this.read();
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}

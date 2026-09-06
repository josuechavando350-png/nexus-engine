import { DatabaseSync } from "node:sqlite";
import type { RelayMode } from "./index";

export interface RelayControlState {
  readonly mode: RelayMode;
  readonly revision: number;
  readonly updatedAt: string;
}

export class RelayControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "RelayControlError";
  }
}

function parseMode(value: unknown): RelayMode {
  if (value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED") return value;
  throw new RelayControlError("INTEGRITY_FAILURE", "stored relay control mode is invalid");
}

export class SqliteWebhookRelayControl {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new RelayControlError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex11_control(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      mode TEXT NOT NULL CHECK(mode IN ('ACTIVE','OBSERVE_ONLY','KILLED')),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  read(): RelayControlState {
    const row = this.db.prepare("SELECT mode,revision,updated_at FROM cortex11_control WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!row) return Object.freeze({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    const revision = Number(row.revision);
    const updatedAt = String(row.updated_at);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RelayControlError("INTEGRITY_FAILURE", "stored relay control revision is invalid");
    const date = new Date(updatedAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== updatedAt) throw new RelayControlError("INTEGRITY_FAILURE", "stored relay control timestamp is invalid");
    return Object.freeze({ mode: parseMode(row.mode), revision, updatedAt });
  }

  setMode(mode: RelayMode, expectedRevision: number): RelayControlState {
    if (!(mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED")) throw new RelayControlError("INVALID_INPUT", "relay control mode is invalid");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RelayControlError("INVALID_INPUT", "expectedRevision is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new RelayControlError("CONFLICT", "relay control revision conflict");
      const updatedAt = new Date(this.now()).toISOString();
      if (current.revision === 0) {
        this.db.prepare("INSERT INTO cortex11_control(singleton,mode,revision,updated_at) VALUES(1,?,1,?)").run(mode, updatedAt);
      } else {
        const result = this.db.prepare("UPDATE cortex11_control SET mode=?,revision=revision+1,updated_at=? WHERE singleton=1 AND revision=?").run(mode, updatedAt, expectedRevision);
        if (result.changes !== 1) throw new RelayControlError("CONFLICT", "relay control revision conflict");
      }
      this.db.exec("COMMIT");
      return this.read();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

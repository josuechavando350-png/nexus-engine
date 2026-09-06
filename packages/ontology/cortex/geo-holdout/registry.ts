import { DatabaseSync } from "node:sqlite";
import { analyzeGeoHoldout, designGeoHoldout, Cortex12Error, type GeoHoldoutAnalysis, type GeoHoldoutDesign, type GeoOutcome } from "./index";

export interface GeoExperimentRecord {
  readonly experimentId: string;
  readonly design: GeoHoldoutDesign;
  readonly analysis: GeoHoldoutAnalysis | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class GeoExperimentRegistryError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND" | "INTEGRITY_FAILURE", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GeoExperimentRegistryError";
  }
}

export class SqliteGeoExperimentRegistry {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new GeoExperimentRegistryError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex12_experiments(
      experiment_id TEXT PRIMARY KEY,
      design_digest TEXT NOT NULL,
      design_json TEXT NOT NULL,
      analysis_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  registerDesign(input: unknown): GeoExperimentRecord {
    let design: GeoHoldoutDesign;
    try { design = designGeoHoldout(input); }
    catch (error) { throw new GeoExperimentRegistryError("INVALID_INPUT", error instanceof Error ? error.message : "invalid geo design", { cause: error }); }
    if (design.status !== "READY") throw new GeoExperimentRegistryError("INVALID_INPUT", `geo design is not READY: ${design.reason}`);
    const existing = this.get(design.experimentId);
    if (existing) {
      if (existing.design.designDigest !== design.designDigest) throw new GeoExperimentRegistryError("CONFLICT", "experimentId is already bound to a different geo design");
      return existing;
    }
    const now = new Date(this.now()).toISOString();
    this.db.prepare("INSERT INTO cortex12_experiments(experiment_id,design_digest,design_json,analysis_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
      design.experimentId,
      design.designDigest,
      JSON.stringify(design),
      null,
      now,
      now,
    );
    const created = this.get(design.experimentId);
    if (!created) throw new GeoExperimentRegistryError("INTEGRITY_FAILURE", "registered geo experiment was not readable after commit");
    return created;
  }

  analyze(experimentId: string, minGeosPerArm: number, outcomes: readonly GeoOutcome[]): GeoExperimentRecord {
    const current = this.get(experimentId);
    if (!current) throw new GeoExperimentRegistryError("NOT_FOUND", "geo experiment was not found");
    let analysis: GeoHoldoutAnalysis;
    try { analysis = analyzeGeoHoldout({ design: current.design, minGeosPerArm, outcomes }); }
    catch (error) {
      if (error instanceof Cortex12Error && error.code === "INTEGRITY_FAILURE") throw new GeoExperimentRegistryError("INTEGRITY_FAILURE", error.message, { cause: error });
      throw new GeoExperimentRegistryError("INVALID_INPUT", error instanceof Error ? error.message : "invalid geo analysis", { cause: error });
    }
    if (current.analysis) {
      if (JSON.stringify(current.analysis) !== JSON.stringify(analysis)) throw new GeoExperimentRegistryError("CONFLICT", "experiment analysis is already immutable and differs from the requested result");
      return current;
    }
    const updatedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare("UPDATE cortex12_experiments SET analysis_json=?,updated_at=? WHERE experiment_id=? AND analysis_json IS NULL").run(JSON.stringify(analysis), updatedAt, experimentId);
    if (result.changes !== 1) throw new GeoExperimentRegistryError("CONFLICT", "geo analysis was committed concurrently");
    return this.get(experimentId)!;
  }

  get(experimentId: string): GeoExperimentRecord | undefined {
    if (typeof experimentId !== "string" || experimentId.length < 4 || experimentId.length > 127) throw new GeoExperimentRegistryError("INVALID_INPUT", "experimentId is invalid");
    const row = this.db.prepare("SELECT experiment_id,design_digest,design_json,analysis_json,created_at,updated_at FROM cortex12_experiments WHERE experiment_id=?").get(experimentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const design = JSON.parse(String(row.design_json)) as GeoHoldoutDesign;
    if (design.experimentId !== row.experiment_id || design.designDigest !== row.design_digest || design.status !== "READY") throw new GeoExperimentRegistryError("INTEGRITY_FAILURE", "stored geo design identity is corrupt");
    const analysis = row.analysis_json ? JSON.parse(String(row.analysis_json)) as GeoHoldoutAnalysis : null;
    if (analysis && (analysis.experimentId !== design.experimentId || analysis.designDigest !== design.designDigest)) throw new GeoExperimentRegistryError("INTEGRITY_FAILURE", "stored geo analysis does not match its design");
    return Object.freeze({ experimentId: String(row.experiment_id), design, analysis, createdAt: String(row.created_at), updatedAt: String(row.updated_at) });
  }
}

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteCortex19Control, type Cortex19ControlState, type Cortex19Mode } from "./runtime-control.js";

function parseMode(value: string | undefined): Cortex19Mode {
  if (value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED") return value;
  throw new Error("mode must be ACTIVE, OBSERVE_ONLY, or KILLED");
}
function parseRevision(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error("expected revision must be a non-negative integer");
  const revision = Number(value); if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("expected revision must be a non-negative integer"); return revision;
}

export function setCortex19ProductionMode(databasePath: string, mode: Cortex19Mode, expectedRevision: number): Cortex19ControlState {
  if (!isAbsolute(databasePath) || /[\r\n\0]/u.test(databasePath)) throw new Error("CORTEX #19 database path must be absolute");
  const control = new SqliteCortex19Control(databasePath);
  try { return control.setMode(mode, expectedRevision); } finally { control.close(); }
}

function main(): void {
  process.umask(0o077);
  const databasePath = process.env.NEXUS_CORTEX_19_DATABASE;
  if (!databasePath || process.argv.length !== 4) throw new Error("usage: production-control <ACTIVE|OBSERVE_ONLY|KILLED> <expected-revision>");
  process.stdout.write(`${JSON.stringify(setCortex19ProductionMode(databasePath, parseMode(process.argv[2]), parseRevision(process.argv[3])))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(JSON.stringify({ component: "cortex-19-production-control", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; }
}

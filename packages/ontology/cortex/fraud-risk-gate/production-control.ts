import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteRiskGateControl, type RiskGateControlState, type RiskGateMode } from "./runtime-control";

function databasePath(env: NodeJS.ProcessEnv): string {
  const value = env.NEXUS_CORTEX_14_DATABASE;
  if (typeof value !== "string" || !isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error("NEXUS_CORTEX_14_DATABASE must be an absolute path");
  return value;
}

function parseMode(value: string | undefined): RiskGateMode {
  if (value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED") return value;
  throw new Error("mode must be ACTIVE, OBSERVE_ONLY, or KILLED");
}

function parseRevision(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error("expected revision must be a non-negative integer");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("expected revision must be a non-negative integer");
  return revision;
}

export function setCortex14ProductionMode(path: string, mode: RiskGateMode, expectedRevision: number): RiskGateControlState {
  if (!isAbsolute(path) || /[\r\n\0]/u.test(path)) throw new Error("CORTEX #14 database path must be absolute");
  const control = new SqliteRiskGateControl(path);
  try { return control.setMode(mode, expectedRevision); }
  finally { control.close(); }
}

function main(): void {
  process.umask(0o077);
  if (process.argv.length !== 4) throw new Error("usage: production-control <ACTIVE|OBSERVE_ONLY|KILLED> <expected-revision>");
  const state = setCortex14ProductionMode(databasePath(process.env), parseMode(process.argv[2]), parseRevision(process.argv[3]));
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) {
    console.error(JSON.stringify({ component: "cortex-14-production-control", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  }
}

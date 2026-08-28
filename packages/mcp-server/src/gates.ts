import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectState } from "./contracts.js";
import { buildTarget, validateBuildManifest } from "./build.js";
import { ProcessExecutionError, runProcess } from "./process.js";

export type GateId = "lint" | "typecheck" | "test" | "build" | "quality-gates" | "browser";
export interface GateResult { id: GateId; status: "PASS" | "FAIL" | "NOT_TESTED"; command: string; exitCode: number | null; durationMs: number; logPath: string | null; reason: string | null; evidencePaths: readonly string[]; artifact?: import("./artifacts.js").ArtifactRecord }

const COMMANDS: Record<GateId, readonly string[]> = {
  lint: ["lint"], typecheck: ["typecheck"], test: ["test"], build: ["build"], "quality-gates": ["quality-gates"], browser: ["test:browser"],
};

export function defaultGateTimeoutMs(gate: GateId): number {
  return gate === "build" || gate === "browser" || gate === "quality-gates" ? 900_000 : 300_000;
}

export async function runGate(root: string, gate: GateId, requestId: string, timeoutMs = defaultGateTimeoutMs(gate), maxOutputBytes = 8 * 1024 * 1024): Promise<GateResult> {
  const started = Date.now();
  const logDir = join(tmpdir(), "nexus-mcp-gates", requestId);
  const logPath = join(logDir, `${gate}.log`);
  await mkdir(logDir, { recursive: true });
  try {
    const result = await runProcess("pnpm", COMMANDS[gate], { cwd: root, timeoutMs, maxOutputBytes });
    await writeFile(logPath, Buffer.concat([result.stdout, result.stderr]));
    return { id: gate, status: "PASS", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: 0, durationMs: result.durationMs, logPath, reason: null, evidencePaths: [logPath] };
  } catch (cause) {
    const error = cause as ProcessExecutionError;
    await writeFile(logPath, Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.from(`${error.message}\n`)]));
    const unavailable = error.code === "SPAWN";
    return { id: gate, status: unavailable ? "NOT_TESTED" : "FAIL", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: error.exitCode, durationMs: Date.now() - started, logPath, reason: error.code === "TIMEOUT" ? `gate exceeded ${timeoutMs}ms` : error.code === "OUTPUT_LIMIT" ? `gate output exceeded ${maxOutputBytes} byte limit` : error.message, evidencePaths: [logPath] };
  }
}

export async function runBuildGate(root: string, project: ProjectState, sourceSha: string, requestId: string, timeoutMs = defaultGateTimeoutMs("build"), maxOutputBytes = 8 * 1024 * 1024, runner: typeof buildTarget = buildTarget, validator: typeof validateBuildManifest = validateBuildManifest): Promise<GateResult> {
  const execution = await runner(root, project, sourceSha, requestId, timeoutMs, maxOutputBytes);
  const valid = execution.exitCode === 0 && execution.manifest !== null && await validator(root, project, sourceSha, execution.manifest);
  const unavailable = execution.unavailableReason !== undefined;
  return {
    id: "build", status: unavailable ? "NOT_TESTED" : valid ? "PASS" : "FAIL", command: execution.command,
    exitCode: execution.exitCode, durationMs: execution.durationMs, logPath: execution.logPath,
    reason: unavailable ? execution.unavailableReason! : valid ? null : execution.exitCode === 0 ? "build manifest or output is invalid" : `command exited ${execution.exitCode}`,
    evidencePaths: [execution.logPath, ...(execution.manifestPath ? [execution.manifestPath] : [])],
  };
}

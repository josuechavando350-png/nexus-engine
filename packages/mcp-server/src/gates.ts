import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectState } from "./contracts.js";
import { buildTarget, validateBuildManifest } from "./build.js";

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
  return await new Promise((resolve) => {
    const child = spawn("pnpm", [...COMMANDS[gate]], { cwd: root, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let outputBytes = 0; let outputExceeded = false;
    const collect = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= maxOutputBytes) chunks.push(chunk); else { outputExceeded = true; child.kill("SIGTERM"); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("error", async (cause: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const reason = cause.code === "ENOENT" ? "pnpm is unavailable" : cause.message;
      await writeFile(logPath, `${reason}\n`, "utf8");
      resolve({ id: gate, status: "NOT_TESTED", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: null, durationMs: Date.now() - started, logPath, reason, evidencePaths: [logPath] });
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks);
      await writeFile(logPath, output);
      if (outputExceeded) resolve({ id: gate, status: "FAIL", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, reason: `gate output exceeded ${maxOutputBytes} byte limit`, evidencePaths: [logPath] });
      else if (timedOut) resolve({ id: gate, status: "NOT_TESTED", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, reason: `gate exceeded ${timeoutMs}ms`, evidencePaths: [logPath] });
      else resolve({ id: gate, status: code === 0 ? "PASS" : "FAIL", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, reason: code === 0 ? null : `command exited ${code}`, evidencePaths: [logPath] });
    });
  });
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

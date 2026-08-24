import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type GateId = "lint" | "typecheck" | "test" | "build" | "quality-gates" | "browser";
export interface GateResult { id: GateId; status: "PASS" | "FAIL" | "NOT_TESTED"; command: string; exitCode: number | null; durationMs: number; logPath: string | null; reason: string | null; evidencePaths: readonly string[] }

const COMMANDS: Record<GateId, readonly string[]> = {
  lint: ["lint"], typecheck: ["typecheck"], test: ["test"], build: ["build"], "quality-gates": ["quality-gates"], browser: ["test:browser"],
};

export async function runGate(root: string, gate: GateId, requestId: string, timeoutMs = gate === "build" || gate === "browser" || gate === "quality-gates" ? 900_000 : 300_000): Promise<GateResult> {
  const started = Date.now();
  const logDir = join(tmpdir(), "nexus-mcp-gates", requestId);
  const logPath = join(logDir, `${gate}.log`);
  await mkdir(logDir, { recursive: true });
  return await new Promise((resolve) => {
    const child = spawn("pnpm", [...COMMANDS[gate]], { cwd: root, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
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
      if (timedOut) resolve({ id: gate, status: "NOT_TESTED", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, reason: `gate exceeded ${timeoutMs}ms`, evidencePaths: [logPath] });
      else resolve({ id: gate, status: code === 0 ? "PASS" : "FAIL", command: `pnpm ${COMMANDS[gate].join(" ")}`, exitCode: code, durationMs: Date.now() - started, logPath, reason: code === 0 ? null : `command exited ${code}`, evidencePaths: [logPath] });
    });
  });
}

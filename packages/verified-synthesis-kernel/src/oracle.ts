import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { sha256, stable, validateProblem } from "./egraph.js";
import type { CandidateAssignment, CounterexampleOracle, IrConstraint, OracleResult, SynthesisProblem } from "./types.js";

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 1_048_576;

export interface CommandCounterexampleOracleOptions {
  readonly authority: "RUNTIME" | "BROWSER";
  readonly executable: string;
  readonly args?: readonly string[];
}

export class CommandCounterexampleOracle implements CounterexampleOracle {
  readonly authority: "RUNTIME" | "BROWSER";
  constructor(private readonly options: CommandCounterexampleOracleOptions) {
    if (!options || (options.authority !== "RUNTIME" && options.authority !== "BROWSER")) throw new Error("oracle authority must be RUNTIME or BROWSER");
    if (typeof options.executable !== "string" || options.executable.length < 1 || options.executable.length > 1024) throw new Error("oracle executable is invalid");
    if (options.args && (!Array.isArray(options.args) || options.args.length > 32 || options.args.some((arg) => typeof arg !== "string" || arg.length > 1024))) throw new Error("oracle args are invalid");
    this.authority = options.authority;
  }

  async check(problem: SynthesisProblem, candidate: CandidateAssignment, signal: AbortSignal): Promise<OracleResult> {
    validateProblem(problem);
    const start = Date.now();
    const request = Object.freeze({
      authority: "NEXUS_COUNTEREXAMPLE_REQUEST_V1" as const,
      scope: problem.scope,
      problemId: problem.problemId,
      problemDigest: sha256(problem),
      candidate,
      candidateDigest: sha256(candidate),
      oracleAuthority: this.authority,
    });
    const serialized = `${stable(request)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error("oracle request exceeds byte budget");
    try {
      const execution = await runCommand(this.options.executable, this.options.args ?? [], serialized, problem.budgets.oracleTimeoutMs, signal);
      const durationMs = Math.max(0, Date.now() - start);
      if (execution.unavailable) return evidenceOnly("UNAVAILABLE", request, execution.stdout, durationMs, this.authority, this.options.executable);
      if (execution.timedOut) return evidenceOnly("TIMEOUT", request, execution.stdout, durationMs, this.authority, this.options.executable);
      if (execution.cancelled || execution.exitCode !== 0) return evidenceOnly("ERROR", request, execution.stdout, durationMs, this.authority, this.options.executable);
      return parseOracleResponse(problem, request, execution.stdout, durationMs, this.authority, this.options.executable);
    } catch {
      return evidenceOnly(signal.aborted ? "ERROR" : "ERROR", request, "", Math.max(0, Date.now() - start), this.authority, this.options.executable);
    }
  }
}

function evidenceOnly(status: "UNAVAILABLE" | "TIMEOUT" | "ERROR", request: unknown, stdout: string, durationMs: number, authority: "RUNTIME" | "BROWSER", implementation: string): OracleResult {
  return Object.freeze({ status, durationMs, evidenceDigest: sha256({ request, authority, implementation, status, outputDigest: sha256(stdout) }) });
}

function parseOracleResponse(problem: SynthesisProblem, request: unknown, stdout: string, durationMs: number, authority: "RUNTIME" | "BROWSER", implementation: string): OracleResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation);
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["status", "counterexample"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation);
  if (record.status === "PASS" && record.counterexample === undefined) {
    const evidenceDigest = sha256({ request, authority, implementation, response: { status: "PASS" }, outputDigest: sha256(stdout) });
    return Object.freeze({ status: "PASS", durationMs, evidenceDigest });
  }
  if (record.status !== "COUNTEREXAMPLE" || !record.counterexample || typeof record.counterexample !== "object" || Array.isArray(record.counterexample)) return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation);
  const counter = record.counterexample as Record<string, unknown>;
  const counterAllowed = new Set(["id", "constraint"]);
  for (const key of Object.keys(counter)) if (!counterAllowed.has(key)) return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation);
  if (typeof counter.id !== "string" || !counter.constraint || typeof counter.constraint !== "object" || Array.isArray(counter.constraint)) return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation);
  const constraint = counter.constraint as unknown as IrConstraint;
  try { validateProblem({ ...problem, constraints: [constraint] }); } catch { return evidenceOnly("ERROR", request, stdout, durationMs, authority, implementation); }
  const evidenceDigest = sha256({ request, authority, implementation, counterexampleId: counter.id, constraint, outputDigest: sha256(stdout) });
  return Object.freeze({
    status: "COUNTEREXAMPLE",
    durationMs,
    evidenceDigest,
    counterexample: Object.freeze({ id: counter.id, authority, constraint, evidenceDigest }),
  });
}

interface CommandResult { readonly stdout: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly cancelled: boolean; readonly unavailable: boolean; }

function runCommand(executable: string, args: readonly string[], stdin: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(executable, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } }); }
    catch (error) { reject(error); return; }
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let unavailable = false;
    let settled = false;
    const kill = () => { if (!child.killed) child.kill("SIGKILL"); };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ stdout: stdout.toString("utf8"), exitCode, timedOut, cancelled, unavailable });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") { unavailable = true; finish(null); } else reject(error); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) { kill(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT_BYTES) kill(); });
    child.once("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    if (signal.aborted) onAbort();
  });
}

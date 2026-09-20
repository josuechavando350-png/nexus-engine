import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { childProcessEnvironment } from "./child-env.js";

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_REAP_DEADLINE_MS = 5_000;

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly code: "EXIT" | "TIMEOUT" | "OUTPUT_LIMIT" | "ABORTED" | "SPAWN" | "REAP",
    readonly exitCode: number | null,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
  ) { super(message); this.name = "ProcessExecutionError"; }
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  termGraceMs?: number;
  reapDeadlineMs?: number;
  captureOutput?: boolean;
}

export interface ProcessResult { exitCode: number; stdout: Buffer; stderr: Buffer; durationMs: number }

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // A POSIX process group outlives its leader while descendants remain.
    // Do not skip SIGKILL just because the direct child has already exited.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw cause;
  }
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw cause;
  }
}

export class ManagedProcess {
  readonly child: ChildProcess;
  readonly completed: Promise<ProcessResult>;
  private stopReason: ProcessExecutionError["code"] | null = null;
  private readonly started = Date.now();
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private outputBytes = 0;
  private termination: Promise<void> | null = null;
  private readonly closed: Promise<boolean>;
  private timeout: NodeJS.Timeout | null = null;
  private abortHandler: (() => void) | null = null;
  private rejectTerminationFailure: ((cause: unknown) => void) | null = null;

  constructor(readonly command: string, readonly args: readonly string[], readonly options: ProcessOptions) {
    const capture = options.captureOutput !== false;
    this.child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? childProcessEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", capture ? "pipe" : "ignore", capture ? "pipe" : "ignore"],
    });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes <= options.maxOutputBytes) target.push(Buffer.from(chunk));
      else this.requestStop("OUTPUT_LIMIT");
    };
    this.child.stdout?.on("data", collect(this.stdout));
    this.child.stderr?.on("data", collect(this.stderr));
    // Attach error handling immediately; otherwise an ENOENT can become an
    // unhandled EventEmitter error before a consumer awaits completion.
    const error = once(this.child, "error").then(([cause]) => { throw cause; });
    const close = once(this.child, "close").then(([code]) => code as number | null);
    // Subscribe at spawn time. A later terminate() must not miss an early close.
    this.closed = close.then(() => true, () => true);
    const terminationFailure = new Promise<never>((_, reject) => {
      this.rejectTerminationFailure = reject;
    });
    this.completed = Promise.race([close, error, terminationFailure]).then(async (code) => {
      // A parent can exit before its grandchildren have received SIGKILL.
      // Do not report timeout/abort/output-limit completion before cleanup.
      if (this.stopReason && this.termination) await this.termination;
      await this.closeStreams();
      const out = Buffer.concat(this.stdout); const err = Buffer.concat(this.stderr);
      if (this.stopReason) throw new ProcessExecutionError(`process ${this.stopReason.toLowerCase()}`, this.stopReason, code, out, err);
      if (code !== 0) throw new ProcessExecutionError(`command exited ${code}`, "EXIT", code, out, err);
      return { exitCode: code, stdout: out, stderr: err, durationMs: Date.now() - this.started };
    }).catch(async (cause: unknown) => {
      if (this.child.exitCode === null && this.child.signalCode === null) await this.terminate();
      if (cause instanceof ProcessExecutionError) throw cause;
      throw new ProcessExecutionError(cause instanceof Error ? cause.message : String(cause), "SPAWN", null, Buffer.concat(this.stdout), Buffer.concat(this.stderr));
    }).finally(() => this.cleanupListeners());
    // A ManagedProcess may intentionally be observed later (for example after
    // a readiness probe). Mark the promise as handled immediately without
    // changing its rejection semantics for callers that await `completed`.
    void this.completed.catch(() => undefined);
    this.timeout = setTimeout(() => this.requestStop("TIMEOUT"), options.timeoutMs);
    this.timeout.unref();
    if (options.signal) {
      this.abortHandler = () => this.requestStop("ABORTED");
      if (options.signal.aborted) this.abortHandler();
      else options.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  async terminate(): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = (async () => {
      signalTree(this.child, "SIGTERM");
      const grace = delay(this.options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
      const graceful = await Promise.race([this.closed, grace.then(() => false)]);
      if (process.platform !== "win32" && this.child.pid && groupAlive(this.child.pid)) {
        // Even if the leader has closed, give descendants the remainder of the
        // grace period, then kill the surviving process group.
        await grace;
        signalTree(this.child, "SIGKILL");
      } else if (!graceful) {
        signalTree(this.child, "SIGKILL");
      }
      const reaped = graceful || await Promise.race([
        this.closed,
        delay(this.options.reapDeadlineMs ?? DEFAULT_REAP_DEADLINE_MS).then(() => false),
      ]);
      if (!reaped) throw new ProcessExecutionError("process tree was not reaped after SIGKILL", "REAP", this.child.exitCode, Buffer.concat(this.stdout), Buffer.concat(this.stderr));
      await this.closeStreams();
    })();
    return this.termination;
  }

  private requestStop(reason: ProcessExecutionError["code"]): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    void this.terminate().catch((cause: unknown) => {
      this.rejectTerminationFailure?.(cause);
    });
  }

  private async closeStreams(): Promise<void> {
    this.child.stdin?.destroy();
    for (const stream of [this.child.stdout, this.child.stderr]) {
      if (stream && !stream.destroyed) stream.destroy();
    }
  }

  private cleanupListeners(): void {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.abortHandler) this.options.signal?.removeEventListener("abort", this.abortHandler);
    this.rejectTerminationFailure = null;
  }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function startProcess(command: string, args: readonly string[], options: ProcessOptions): ManagedProcess {
  return new ManagedProcess(command, args, options);
}

export async function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return await startProcess(command, args, options).completed;
}

export async function runReadOnly(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await runProcess(command, args, { cwd, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 });
  return result.stdout.toString("utf8").trimEnd();
}

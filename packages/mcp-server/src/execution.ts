import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";

async function exec(command: string, args: readonly string[], options: { cwd: string; timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  const result = await runProcess(command, args, { cwd: options.cwd, timeoutMs: options.timeout, maxOutputBytes: options.maxBuffer ?? 8 * 1024 * 1024 });
  return { stdout: result.stdout.toString("utf8") };
}

export class ConcurrencyLimitError extends Error { readonly code = "CONCURRENCY_LIMIT_REACHED"; }

export interface ExecutionRunner {
  run<T>(requestId: string, sourceSha: string, isolated: boolean, operation: (root: string) => Promise<T>): Promise<T>;
}

export class ExecutionCoordinator implements ExecutionRunner {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly maxConcurrency: number;
  readonly executionTimeoutMs: number;
  readonly maxProcessOutputBytes: number;
  #active = 0;

  constructor(sourceRoot: string, worktreeRoot: string, maxConcurrency: number, executionTimeoutMs = 900_000, maxProcessOutputBytes = 8 * 1024 * 1024) {
    this.sourceRoot = sourceRoot; this.worktreeRoot = worktreeRoot; this.maxConcurrency = maxConcurrency; this.executionTimeoutMs = executionTimeoutMs; this.maxProcessOutputBytes = maxProcessOutputBytes;
  }

  get active(): number { return this.#active; }

  async run<T>(requestId: string, sourceSha: string, isolated: boolean, operation: (root: string) => Promise<T>): Promise<T> {
    if (this.#active >= this.maxConcurrency) throw new ConcurrencyLimitError(`maximum concurrency ${this.maxConcurrency} reached`);
    this.#active += 1;
    let worktree: string | null = null;
    try {
      if (!isolated) return await operation(this.sourceRoot);
      worktree = join(this.worktreeRoot, requestId);
      await mkdir(this.worktreeRoot, { recursive: true });
      await exec("git", ["worktree", "add", "--detach", worktree, sourceSha], { cwd: this.sourceRoot, timeout: 60_000 });
      await this.installDependencies(worktree);
      await this.copyInstalledOutputs(worktree);
      return await operation(worktree);
    } finally {
      if (worktree) {
        await exec("git", ["worktree", "remove", "--force", worktree], { cwd: this.sourceRoot, timeout: 60_000 }).catch(() => rm(worktree!, { recursive: true, force: true }));
        await exec("git", ["worktree", "prune"], { cwd: this.sourceRoot, timeout: 60_000 }).catch(() => undefined);
      }
      this.#active -= 1;
    }
  }

  private async installDependencies(worktree: string): Promise<void> {
    try { if (!(await stat(join(worktree, "pnpm-lock.yaml"))).isFile()) return; } catch { return; }
    await exec("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: worktree, timeout: this.executionTimeoutMs, maxBuffer: this.maxProcessOutputBytes });
  }

  private async copyInstalledOutputs(worktree: string): Promise<void> {
    for (const parent of ["apps", "packages"]) {
      const sourceParent = join(this.sourceRoot, parent); const targetParent = join(worktree, parent);
      const entries = await readdir(sourceParent, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return []; throw cause; });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        for (const output of ["dist", "build", "out", ".next"]) {
          const source = join(sourceParent, entry.name, output); const target = join(targetParent, entry.name, output);
          try { if (!(await stat(source)).isDirectory()) continue; } catch { continue; }
          await cp(source, target, { recursive: true, preserveTimestamps: false });
        }
      }
    }
  }
}

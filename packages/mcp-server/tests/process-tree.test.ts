import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessExecutionError, runProcess, startProcess } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "nexus-process-tree-")); roots.push(value); return value; }
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan adopted by a slow container init may remain briefly as a
    // zombie. It cannot execute and therefore is not a surviving descendant.
    try { return !readFileSync(`/proc/${pid}/stat`, "utf8").match(/^\d+ \(.+\) Z /); } catch { return true; }
  } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}
async function waitForFile(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { try { return Number.parseInt(await readFile(path, "utf8"), 10); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  throw new Error(`PID file was not written: ${path}`);
}
async function assertDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(alive(pid), `PID ${pid} remains alive`).toBe(false);
}

describe.runIf(process.platform !== "win32")("auditable process-tree hard stop", () => {
  it("escalates timeout from TERM to KILL and reaps a child that ignores TERM", async () => {
    const cwd = await root(); const pidPath = join(cwd, "pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const execution = startProcess(process.execPath, ["-e", script], { cwd, timeoutMs: 1_000, maxOutputBytes: 1024, termGraceMs: 100, reapDeadlineMs: 2_000 });
    const pid = await waitForFile(pidPath);
    await expect(execution.completed).rejects.toMatchObject({ code: "TIMEOUT" });
    await assertDead(pid);
  }, 10_000);

  it("kills and reaps a grandchild that ignores TERM", async () => {
    const cwd = await root(); const parentPath = join(cwd, "parent"); const grandchildPath = join(cwd, "grandchild");
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(grandchildPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const parent = `const{spawn}=require('child_process');require('fs').writeFileSync(${JSON.stringify(parentPath)},String(process.pid));process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const execution = startProcess(process.execPath, ["-e", parent], { cwd, timeoutMs: 1_000, maxOutputBytes: 1024, termGraceMs: 100, reapDeadlineMs: 2_000 });
    const parentPid = await waitForFile(parentPath); const grandchildPid = await waitForFile(grandchildPath);
    await expect(execution.completed).rejects.toMatchObject({ code: "TIMEOUT" });
    await assertDead(parentPid); await assertDead(grandchildPid);
  }, 10_000);

  for (const stream of ["stdout", "stderr"] as const) it(`fails closed and kills an infinite ${stream} flood`, async () => {
    const cwd = await root(); const pidPath = join(cwd, stream);
    const script = `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});const w=()=>{while(process.${stream}.write('x'.repeat(4096))){};process.${stream}.once('drain',w)};w();setInterval(()=>{},1000)`;
    const execution = startProcess(process.execPath, ["-e", script], { cwd, timeoutMs: 5_000, maxOutputBytes: 16_384, termGraceMs: 100 });
    const pid = await waitForFile(pidPath);
    await expect(execution.completed).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    await assertDead(pid);
  });

  it("kills the process tree when the caller aborts", async () => {
    const cwd = await root(); const pidPath = join(cwd, "aborted"); const controller = new AbortController();
    const execution = startProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024, signal: controller.signal, termGraceMs: 100 });
    const pid = await waitForFile(pidPath); controller.abort();
    await expect(execution.completed).rejects.toMatchObject({ code: "ABORTED" }); await assertDead(pid);
  });
});

describe("process completion cleanup", () => {
  it("captures bounded output and cleans up after success", async () => {
    const cwd = await root(); const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok');process.stderr.write('note')"], { cwd, timeoutMs: 2_000, maxOutputBytes: 1024 });
    expect(result.stdout.toString()).toBe("ok"); expect(result.stderr.toString()).toBe("note");
  });

  it("reports failure without leaving a live process", async () => {
    const cwd = await root(); const pidPath = join(cwd, "failed");
    await writeFile(join(cwd, "noop"), "");
    let error: ProcessExecutionError | undefined;
    try { await runProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.exit(17)`], { cwd, timeoutMs: 2_000, maxOutputBytes: 1024 }); } catch (cause) { error = cause as ProcessExecutionError; }
    expect(error).toMatchObject({ code: "EXIT", exitCode: 17 }); await assertDead(await waitForFile(pidPath));
  });

  it("terminate returns immediately after completed resolved successfully", async () => {
    const cwd = await root();
    const execution = startProcess(process.execPath, ["-e", "process.stdout.write('done')"], { cwd, timeoutMs: 2_000, maxOutputBytes: 1024, termGraceMs: 1_000, reapDeadlineMs: 1_000 });
    await expect(execution.completed).resolves.toMatchObject({ exitCode: 0 });
    const started = Date.now();
    await execution.terminate();
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("terminate returns after a process has already exited with failure", async () => {
    const cwd = await root();
    const execution = startProcess(process.execPath, ["-e", "process.exit(23)"], { cwd, timeoutMs: 2_000, maxOutputBytes: 1024, termGraceMs: 1_000, reapDeadlineMs: 1_000 });
    await expect(execution.completed).rejects.toMatchObject({ code: "EXIT", exitCode: 23 });
    await expect(execution.terminate()).resolves.toBeUndefined();
  });

  it("coalesces repeated and concurrent termination calls", async () => {
    const cwd = await root(); const pidPath = join(cwd, "concurrent");
    const execution = startProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024, termGraceMs: 100, reapDeadlineMs: 2_000 });
    const completion = execution.completed.catch((error: unknown) => error);
    const pid = await waitForFile(pidPath);
    await Promise.all([execution.terminate(), execution.terminate(), execution.terminate()]);
    await execution.terminate();
    await completion;
    await assertDead(pid);
  });

  it("supports capture-style finally cleanup after a server exits itself", async () => {
    const cwd = await root();
    const execution = startProcess(process.execPath, ["-e", "setTimeout(()=>process.exit(0),50)"], { cwd, timeoutMs: 2_000, maxOutputBytes: 1024, termGraceMs: 1_000, reapDeadlineMs: 1_000, captureOutput: false });
    const completion = execution.completed;
    try {
      await completion;
    } finally {
      await execution.terminate();
    }
    await expect(execution.terminate()).resolves.toBeUndefined();
  });
});

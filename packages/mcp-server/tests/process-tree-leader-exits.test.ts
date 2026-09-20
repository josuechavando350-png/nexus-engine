import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startProcess } from "../src/process.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphaned zombie is no longer executing and may await container init.
    try { return !/^\d+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
    catch { return true; }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* The process may not have written its readiness file yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No grandchild readiness file: ${path}`);
}

describe.runIf(process.platform === "linux")("process-group leader exit regression", () => {
  it("kills a TERM-ignoring grandchild even when the parent exits on TERM", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-leader-exits-"));
    const ready = join(cwd, "grandchild");
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const parent = `const{spawn}=require('child_process');process.on('SIGTERM',()=>process.exit(0));spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    let groupPid: number | undefined;
    try {
      const execution = startProcess(process.execPath, ["-e", parent], {
        cwd, timeoutMs: 2_000, termGraceMs: 100, reapDeadlineMs: 2_000, maxOutputBytes: 1024,
      });
      groupPid = execution.child.pid;
      const grandchildPid = await readPid(ready);
      await expect(execution.completed).rejects.toMatchObject({ code: "TIMEOUT" });
      const deadline = Date.now() + 3_000;
      while (alive(grandchildPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(alive(grandchildPid), `grandchild PID ${grandchildPid} survived parent exit`).toBe(false);
    } finally {
      // Even a failing regression must not leak a test process tree.
      if (groupPid) {
        try { process.kill(-groupPid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});

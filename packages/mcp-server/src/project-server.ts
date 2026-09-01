import { createServer } from "node:net";
import type { ProjectState } from "./contracts.js";
import { startProcess, type ManagedProcess } from "./process.js";

export interface ProjectServerOptions {
  startupTimeoutMs?: number;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("cannot allocate target port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForProject(url: string, process: ManagedProcess, startupTimeoutMs: number): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) throw new Error(`target server exited ${process.child.exitCode}`);
    try {
      const response = await fetch(url, { redirect: "error" });
      if (response.ok) return;
    } catch {
      // The project may still be starting. Retry until the bounded deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`target server did not become ready within ${startupTimeoutMs}ms`);
}

export async function withProjectServer<T>(
  root: string,
  project: ProjectState,
  operation: (targetUrl: string) => Promise<T>,
  options: ProjectServerOptions = {},
): Promise<T> {
  if (!root.trim()) throw new Error("project server root is required");
  if (!project.packageName.trim()) throw new Error("project server packageName is required");
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const processTimeoutMs = options.processTimeoutMs ?? 15 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000) throw new Error("startupTimeoutMs must be an integer >= 1000");
  if (!Number.isInteger(processTimeoutMs) || processTimeoutMs <= startupTimeoutMs) throw new Error("processTimeoutMs must be an integer greater than startupTimeoutMs");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error("maxOutputBytes must be an integer >= 1024");

  const port = await freePort();
  const targetUrl = `http://127.0.0.1:${port}`;
  const server = startProcess(
    "pnpm",
    ["--filter", project.packageName, "start", "-p", String(port), "-H", "127.0.0.1"],
    { cwd: root, timeoutMs: processTimeoutMs, maxOutputBytes, captureOutput: false },
  );
  try {
    await waitForProject(targetUrl, server, startupTimeoutMs);
    return await operation(targetUrl);
  } finally {
    await server.terminate();
    await server.completed.catch(() => undefined);
  }
}

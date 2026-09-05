import { createServer } from "node:net";
import type { ProjectState } from "./contracts.js";
import { startProcess, type ManagedProcess } from "./process.js";

export interface ProjectServerOptions {
  startupTimeoutMs?: number;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RenderedNexusElementInventory {
  route: "/";
  elementIds: readonly string[];
  htmlByteLength: number;
}

const NEXUS_ELEMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RENDERED_HTML_BYTES = 4 * 1024 * 1024;

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

export function parseRenderedNexusElementIds(html: string): readonly string[] {
  if (typeof html !== "string" || !html.trim()) throw new Error("rendered HTML must be a non-empty string");
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > MAX_RENDERED_HTML_BYTES) throw new Error(`rendered HTML exceeds ${MAX_RENDERED_HTML_BYTES} byte audit bound`);

  const ids: string[] = [];
  const attribute = /\sdata-nexus-element=(?:"([^"]*)"|'([^']*)')/g;
  for (const match of html.matchAll(attribute)) {
    const id = (match[1] ?? match[2] ?? "").trim();
    if (!NEXUS_ELEMENT_ID.test(id)) throw new Error(`invalid rendered data-nexus-element id: ${id || "<empty>"}`);
    ids.push(id);
  }
  if (!ids.length) throw new Error("rendered route contains no data-nexus-element markers");
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort((a, b) => a.localeCompare(b, "en"));
    throw new Error(`rendered route contains duplicate data-nexus-element ids: ${duplicates.join(", ")}`);
  }
  return Object.freeze([...ids].sort((a, b) => a.localeCompare(b, "en")));
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

export async function inspectRenderedNexusElements(root: string, project: ProjectState): Promise<RenderedNexusElementInventory> {
  return await withProjectServer(root, project, async (targetUrl) => {
    const response = await fetch(`${targetUrl}/`, { redirect: "error", headers: { accept: "text/html" } });
    if (!response.ok) throw new Error(`rendered route returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) throw new Error(`rendered route did not return text/html: ${contentType || "missing content-type"}`);
    const html = await response.text();
    const elementIds = parseRenderedNexusElementIds(html);
    return Object.freeze({ route: "/", elementIds, htmlByteLength: Buffer.byteLength(html, "utf8") });
  });
}

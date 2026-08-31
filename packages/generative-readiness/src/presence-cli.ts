#!/usr/bin/env node
import { open } from "node:fs/promises";
import { runGenerativePresence, type GenerativePresenceRuntimeRequest } from "./presence-runtime.js";

const MAX_INPUT_BYTES = 2_000_000;

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("presence request path must reference a regular file");
    if (before.size > MAX_INPUT_BYTES) throw new Error("presence request exceeds input byte budget");
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error("presence request file changed while being read");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size) throw new Error("presence request file changed while being read");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("usage: nexus-generative-presence <request.json>");
  const parsed: unknown = JSON.parse(await readBounded(path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("presence request must be a JSON object");
  const allowed = new Set(["scope", "page", "observedAt", "externalVisibilityState"]);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error(`unknown presence request field: ${key}`);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("generative presence cancelled by operator"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = runGenerativePresence(parsed as GenerativePresenceRuntimeRequest, controller.signal);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "generative presence failed"}\n`);
  process.exitCode = 1;
});

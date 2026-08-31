#!/usr/bin/env node
import { open } from "node:fs/promises";
import { runReputationShield, type ReputationRuntimeRequest } from "./reputation-shield-runtime";

const MAX_INPUT_BYTES = 128_000;

async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("request path must reference a regular file");
    if (before.size > MAX_INPUT_BYTES) throw new Error(`request exceeds ${MAX_INPUT_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error("request file changed while being read");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size) throw new Error("request file changed while being read");
    return buffer;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("usage: nexus-reputation-shield <request.json>");
  const request = JSON.parse((await readBounded(path)).toString("utf8")) as ReputationRuntimeRequest;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("reputation shield cancelled by operator"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.stdout.write(`${JSON.stringify(await runReputationShield(request, controller.signal))}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "reputation shield failed"}\n`);
  process.exitCode = 1;
});

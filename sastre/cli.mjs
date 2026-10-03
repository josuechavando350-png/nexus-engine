#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLiveMarket } from './live-market.mjs';

const MAX_INPUT_BYTES = 128_000;

async function readRequest(path) {
  const handle = await open(resolve(path), 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_INPUT_BYTES) throw new Error('request must be a regular file <= 128000 bytes');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('request changed during read');
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== before.size) throw new Error('request changed during read');
    return JSON.parse(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node sastre/cli.mjs <market-request.json>');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('operator cancelled run'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await runLiveMarket(await readRequest(process.argv[2]), { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'OBSERVED') process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'market capture failed'}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runCompetitiveIntelligence, type CompetitiveRuntimeRequest } from "./competitive-intelligence-runtime";

const MAX_INPUT_BYTES = 128_000;

function usage(): never {
  throw new Error("usage: nexus-competitive-intelligence <request.json>");
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) usage();
  const content = await readFile(inputPath);
  if (content.byteLength > MAX_INPUT_BYTES) throw new Error(`request exceeds ${MAX_INPUT_BYTES} bytes`);
  const parsed = JSON.parse(content.toString("utf8")) as CompetitiveRuntimeRequest;
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("competitive intelligence cancelled by operator"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const report = await runCompetitiveIntelligence(parsed, controller.signal);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "competitive intelligence failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

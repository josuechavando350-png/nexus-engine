#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareRenderPair,
  parseRenderObservationJson,
  validateRenderDiffAssessment,
} from "../packages/crawl-observability/dist/render-diff.js";

const MAX_FILE_BYTES = 64_000;

async function readBounded(path) {
  const absolute = resolve(path);
  const value = await readFile(absolute);
  if (value.byteLength > MAX_FILE_BYTES) throw new Error(`${absolute} exceeds ${MAX_FILE_BYTES} bytes`);
  return value.toString("utf8");
}

async function main() {
  const [standardPath, googlebotPath] = process.argv.slice(2);
  if (!standardPath || !googlebotPath || process.argv.length !== 4) {
    throw new Error("usage: verify-googlebot-render-diff.mjs <standard.json> <googlebot.json>");
  }
  const [standardRaw, googlebotRaw] = await Promise.all([
    readBounded(standardPath),
    readBounded(googlebotPath),
  ]);
  const standard = parseRenderObservationJson(standardRaw);
  const googlebot = parseRenderObservationJson(googlebotRaw);
  const assessment = compareRenderPair({ standard, googlebot });
  validateRenderDiffAssessment({ standard, googlebot, assessment });
  process.stdout.write(`${JSON.stringify(assessment)}\n`);
  if (!assessment.equivalent) process.exitCode = 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`googlebot-render-diff: ${message}\n`);
  process.exitCode = 1;
});

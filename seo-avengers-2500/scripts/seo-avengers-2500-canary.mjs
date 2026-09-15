#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { runReadonlyCanary } from "../sidecar/readonly-canary.mjs";

const FLAGS = new Set([
  "--control-root",
  "--evidence-root",
  "--result-root",
  "--run-id",
  "--source-revision",
  "--source-tree",
  "--config",
]);

function usage() {
  return "usage: seo-avengers-2500-canary --control-root <dir> --evidence-root <dir> --result-root <dir> --run-id <id> --source-revision <git-sha> --source-tree <tree-sha> [--config <json-file>]";
}

function parseArgs(argv) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--control-root") options.controlRoot = value;
    if (flag === "--evidence-root") options.evidenceRoot = value;
    if (flag === "--result-root") options.resultRoot = value;
    if (flag === "--run-id") options.runId = value;
    if (flag === "--source-revision") options.sourceRevision = value;
    if (flag === "--source-tree") options.sourceTree = value;
    if (flag === "--config") options.configPath = value;
  }
  for (const required of ["controlRoot", "evidenceRoot", "resultRoot", "runId", "sourceRevision", "sourceTree"]) {
    if (!options[required]) throw new Error(usage());
  }
  return options;
}

async function loadConfig(path) {
  if (!path) return {};
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be a JSON object");
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runReadonlyCanary({
    controlRoot: options.controlRoot,
    evidenceRoot: options.evidenceRoot,
    resultRoot: options.resultRoot,
    runId: options.runId,
    sourceRevision: options.sourceRevision,
    sourceTree: options.sourceTree,
    config: await loadConfig(options.configPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "CERTIFIED") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

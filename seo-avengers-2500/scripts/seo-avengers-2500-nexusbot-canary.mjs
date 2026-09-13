#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { runNexusBotStudioCanary } from "../canary/nexusbotstudio-canary.mjs";

function usage() {
  return "usage: seo-avengers-2500-nexusbot-canary --control-root <dir> --evidence-root <dir> [--config <json-file>]";
}

function parseArgs(argv) {
  const options = {};
  const allowed = new Set(["--control-root", "--evidence-root", "--config"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--control-root") options.controlRoot = value;
    if (flag === "--evidence-root") options.evidenceRoot = value;
    if (flag === "--config") options.configPath = value;
  }
  if (!options.controlRoot || !options.evidenceRoot) throw new Error(usage());
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
  const config = await loadConfig(options.configPath);
  const result = await runNexusBotStudioCanary({
    controlRoot: options.controlRoot,
    evidenceRoot: options.evidenceRoot,
    config,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "BLOCKED" || result.status === "STALE") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

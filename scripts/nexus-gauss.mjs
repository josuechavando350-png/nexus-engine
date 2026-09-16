#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { executeGaussProblem } from "../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../gauss/core/quantum-contributor.mjs";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function usage() {
  console.error("Usage: node scripts/nexus-gauss.mjs <problem.json> [--out <report.json>]");
  process.exit(2);
}

async function readJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) throw new Error("GAUSS input must be a bounded regular non-symlink file");
  return JSON.parse(await readFile(path, "utf8"));
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 3) usage();
const inputPath = resolve(args[0]);
let outputPath = null;
if (args.length > 1) {
  if (args.length !== 3 || args[1] !== "--out") usage();
  outputPath = resolve(args[2]);
}

const report = await executeGaussProblem(await readJson(inputPath), { quantumContributor: contributeNexusQuantum });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
else process.stdout.write(serialized);
if (report.status !== "PASS") process.exitCode = 1;

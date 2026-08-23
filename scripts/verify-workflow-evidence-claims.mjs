#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TRUTHY_PASS = /^(?:["']?(?:1|true|pass|passed|success)["']?)$/i;
const CLAIM = /^\s*([A-Z][A-Z0-9_]*_PASSED)\s*:\s*(.*?)\s*(?:#.*)?$/;
const STEP_OUTPUT = /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

function jobRanges(lines) {
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsLine < 0) return [];
  const starts = [];
  for (let i = jobsLine + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (match) starts.push({ name: match[1], start: i });
  }
  return starts.map((entry, index) => ({
    ...entry,
    end: index + 1 < starts.length ? starts[index + 1].start : lines.length,
  }));
}

function stepBlocks(lines, job) {
  const blocks = [];
  let current = null;
  for (let i = job.start + 1; i < job.end; i += 1) {
    if (/^\s{4,}-\s+(?:name|id|uses|run)\s*:/.test(lines[i])) {
      if (current) current.end = i;
      current = { start: i, end: job.end };
      blocks.push(current);
    }
  }
  return blocks;
}

function evidenceStepExists(lines, job, claimLine, stepId, outputName) {
  const blocks = stepBlocks(lines, job);
  for (const block of blocks) {
    if (block.start >= claimLine) break;
    const text = lines.slice(block.start, Math.min(block.end, claimLine)).join("\n");
    const escapedId = stepId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|\\n)\\s*(?:-\\s*)?id\\s*:\\s*["']?${escapedId}["']?\\s*(?:#.*)?(?:\\n|$)`).test(text)) continue;
    if (!/(?:^|\n)\s*run\s*:\s*(?:\||>|[^\s#])/.test(text)) return false;
    const escapedOutput = outputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapedOutput}(?:=|<<)`).test(text) && /GITHUB_OUTPUT/.test(text);
  }
  return false;
}

export function verifyWorkflowEvidenceClaims(text, filename = "workflow.yml") {
  const lines = text.split(/\r?\n/);
  const failures = [];
  for (const job of jobRanges(lines)) {
    for (let i = job.start + 1; i < job.end; i += 1) {
      const match = lines[i].match(CLAIM);
      if (!match) continue;
      const [, variable, rawValue] = match;
      const value = rawValue.trim();
      if (TRUTHY_PASS.test(value)) {
        failures.push(`${filename}:${i + 1} ${job.name}.${variable} statically asserts PASS without executed evidence`);
        continue;
      }
      const dynamic = value.match(STEP_OUTPUT);
      if (!dynamic) {
        failures.push(`${filename}:${i + 1} ${job.name}.${variable} must come from an earlier same-job step output`);
        continue;
      }
      const [, stepId, outputName] = dynamic;
      if (!evidenceStepExists(lines, job, i, stepId, outputName)) {
        failures.push(`${filename}:${i + 1} ${job.name}.${variable} references ${stepId}.${outputName} without an earlier run step writing that output to GITHUB_OUTPUT`);
      }
    }
  }
  return failures;
}

export function verifyWorkflowDirectory(root = process.cwd()) {
  const dir = join(root, ".github", "workflows");
  const failures = [];
  for (const name of readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
    failures.push(...verifyWorkflowEvidenceClaims(readFileSync(join(dir, name), "utf8"), name));
  }
  return failures;
}

function main() {
  const failures = verifyWorkflowDirectory();
  if (failures.length) {
    console.error("NEXUS workflow evidence claim guard failed:");
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    process.exit(1);
  }
  console.log("NEXUS workflow evidence claim guard passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

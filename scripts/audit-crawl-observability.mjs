#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessCrawl, createDataset, parseObservationJsonLine, validateAssessment } from "../packages/crawl-observability/src/index.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = argument("--input") ?? process.env.NEXUS_CRAWL_LOG_PATH;
const site = argument("--site") ?? process.env.NEXUS_CRAWL_SITE;
const windowStart = argument("--start") ?? process.env.NEXUS_CRAWL_WINDOW_START;
const windowEnd = argument("--end") ?? process.env.NEXUS_CRAWL_WINDOW_END;

if (!inputPath || !site || !windowStart || !windowEnd) {
  process.stdout.write(`${JSON.stringify({
    status: "UNAVAILABLE",
    evidence: "UNAVAILABLE",
    reason: "Provide --input/--site/--start/--end or NEXUS_CRAWL_LOG_PATH/NEXUS_CRAWL_SITE/NEXUS_CRAWL_WINDOW_START/NEXUS_CRAWL_WINDOW_END. No crawl evidence was invented.",
  }, null, 2)}\n`);
  process.exitCode = 2;
} else {
  try {
    const raw = await readFile(resolve(inputPath), "utf8");
    const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error("crawl observation file is empty");
    const observations = lines.map(parseObservationJsonLine);
    const dataset = createDataset({ site, windowStart, windowEnd, observations });
    const assessment = assessCrawl(dataset);
    validateAssessment(dataset, assessment);
    process.stdout.write(`${JSON.stringify({
      status: assessment.status,
      evidence: "OBSERVED",
      inputPath: resolve(inputPath),
      datasetDigest: dataset.datasetDigest,
      assessment,
    }, null, 2)}\n`);
    if (assessment.status === "BLOCKED") process.exitCode = 1;
    else if (assessment.status === "INSUFFICIENT_EVIDENCE") process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      evidence: "OBSERVED",
      reason: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

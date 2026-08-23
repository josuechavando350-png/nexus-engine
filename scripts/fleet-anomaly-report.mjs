import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeFleetAnomalies } from "../packages/quality/fleet-anomaly.ts";
import { discoverClientApps } from "./client-fleet.mjs";

const SHA1 = /^[a-f0-9]{40}$/;
const root = process.cwd();
const inputDir = resolve(process.env.NEXUS_FLEET_RUM_DIR || join(root, "artifacts", "field-rum"));
const outputDir = join(root, "artifacts", "fleet");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const points = [];
const missing = [];

for (const projectId of clients) {
  const summaryPath = join(inputDir, `${projectId}.json`);
  if (!existsSync(summaryPath)) {
    missing.push({ projectId, reason: "MISSING_RUM_SUMMARY" });
    continue;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (summary.schemaVersion !== 1 || summary.authority !== "NEXUS_FIELD_RUM_SUMMARY_V1" || summary.projectId !== projectId || !SHA1.test(summary.buildRevision)) {
    throw new Error(`invalid RUM summary identity/schema: ${summaryPath}`);
  }
  const start = new Date(summary.windowStart);
  const end = new Date(summary.windowEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error(`invalid RUM summary window: ${summaryPath}`);
  if (!Number.isInteger(summary.sampleCount) || summary.sampleCount <= 0) throw new Error(`RUM summary requires positive sampleCount: ${summaryPath}`);
  if (!summary.metricSampleCounts || [summary.metricSampleCounts.LCP, summary.metricSampleCounts.INP, summary.metricSampleCounts.CLS].some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`RUM summary requires positive per-metric sample counts: ${summaryPath}`);
  }
  for (const [metric, value] of [["LCP_P75", summary.lcpP75Ms], ["INP_P75", summary.inpP75Ms], ["CLS_P75", summary.clsP75]]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${metric} value in ${summaryPath}`);
    points.push({ projectId, metric, value });
  }
}

const analysis = analyzeFleetAnomalies(points);
const report = {
  authority: "NEXUS_FLEET_REPORT_V1",
  generatedAt: new Date().toISOString(),
  inputDirectory: inputDir,
  clientCount: clients.length,
  measuredClientCount: new Set(points.map((point) => point.projectId)).size,
  missing,
  analysis,
};
writeFileSync(join(outputDir, "fleet-anomaly-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

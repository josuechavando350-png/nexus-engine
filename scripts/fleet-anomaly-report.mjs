import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeFleetAnomalies } from "../packages/quality/fleet-anomaly.ts";
import { discoverClientApps } from "./client-fleet.mjs";

const root = process.cwd();
const outputDir = join(root, "artifacts", "fleet");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const points = [];
const missing = [];

for (const projectId of clients) {
  const summaryPath = join(root, "apps", projectId, "nexus-rum-summary.json");
  if (!existsSync(summaryPath)) {
    missing.push({ projectId, reason: "MISSING_RUM_SUMMARY" });
    continue;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (summary.schemaVersion !== 1 || summary.authority !== "NEXUS_FIELD_RUM_SUMMARY_V1" || summary.projectId !== projectId) {
    throw new Error(`invalid RUM summary identity/schema: ${summaryPath}`);
  }
  if (!Number.isInteger(summary.sampleCount) || summary.sampleCount <= 0) throw new Error(`RUM summary requires positive sampleCount: ${summaryPath}`);
  for (const [metric, value] of [["LCP_P75", summary.lcpP75Ms], ["INP_P75", summary.inpP75Ms], ["CLS_P75", summary.clsP75]]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${metric} value in ${summaryPath}`);
    points.push({ projectId, metric, value });
  }
}

const analysis = analyzeFleetAnomalies(points);
const report = {
  authority: "NEXUS_FLEET_REPORT_V1",
  generatedAt: new Date().toISOString(),
  clientCount: clients.length,
  measuredClientCount: new Set(points.map((point) => point.projectId)).size,
  missing,
  analysis,
};
writeFileSync(join(outputDir, "fleet-anomaly-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

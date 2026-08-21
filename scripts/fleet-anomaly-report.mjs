import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverClientApps, robustFleetAnomalies } from "./client-fleet.mjs";

const root = process.cwd();
const outputDir = join(root, "artifacts", "fleet");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const samples = [];
const missing = [];

for (const projectId of clients) {
  const summaryPath = join(root, "apps", projectId, "nexus-rum-summary.json");
  if (!existsSync(summaryPath)) {
    missing.push({ projectId, reason: "MISSING_RUM_SUMMARY" });
    continue;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  samples.push({ projectId, lcpP75Ms: summary.lcpP75Ms, inpP75Ms: summary.inpP75Ms, clsP75: summary.clsP75 });
}

const analysis = robustFleetAnomalies(samples, { minimumPeers: 5, zThreshold: 3.5 });
const report = {
  authority: "NEXUS_FLEET_ANOMALY_V1",
  generatedAt: new Date().toISOString(),
  clientCount: clients.length,
  measuredClientCount: samples.length,
  missing,
  ...analysis,
};
writeFileSync(join(outputDir, "fleet-anomaly-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDecisionTrace } from "../packages/quality/decision-trace.ts";
import { discoverClientApps } from "./client-fleet.mjs";

const root = process.cwd();
const outputDir = join(root, "artifacts", "decision-trace");
mkdirSync(outputDir, { recursive: true });
const clients = discoverClientApps(root);
const results = [];

for (const projectId of clients) {
  const sourcePath = join(root, "apps", projectId, "nexus-decisions.json");
  if (!existsSync(sourcePath)) {
    results.push({ projectId, status: "FAIL", reason: "MISSING_DECISION_MANIFEST" });
    continue;
  }
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (source.schemaVersion !== 1 || !Array.isArray(source.entries) || source.entries.length === 0) {
    results.push({ projectId, status: "FAIL", reason: "INVALID_DECISION_MANIFEST" });
    continue;
  }
  const trace = createDecisionTrace(source.entries);
  const tracePath = join(outputDir, `${projectId}.json`);
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  results.push({ projectId, status: "PASS", traceHash: trace.traceHash, tracePath: `artifacts/decision-trace/${projectId}.json`, entryCount: trace.entries.length });
}

const verdict = clients.length === 0 ? "NOT_TESTED" : results.every((result) => result.status === "PASS") ? "PASS" : "FAIL";
const report = {
  authority: "NEXUS_CLIENT_DECISION_PROVENANCE_V1",
  verdict,
  reason: clients.length === 0 ? "NO_CLIENT_APPS" : undefined,
  clientCount: clients.length,
  clients: results.sort((a, b) => a.projectId.localeCompare(b.projectId, "en")),
};
writeFileSync(join(outputDir, "index.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (verdict === "FAIL") process.exit(2);

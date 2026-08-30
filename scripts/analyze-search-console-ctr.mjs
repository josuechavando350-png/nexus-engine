import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeCtrOpportunities,
  fetchSearchAnalytics,
  validateCtrAnalysis,
} from "../packages/search-console-ctr/src/index.ts";

async function main() {
  const args = process.argv.slice(2);
  const requestIndex = args.indexOf("--request");
  const minimumIndex = args.indexOf("--minimum-impressions");
  if (requestIndex < 0 || !args[requestIndex + 1]) {
    throw new Error("usage: node scripts/analyze-search-console-ctr.mjs --request <json> [--minimum-impressions <n>]");
  }
  const request = JSON.parse(await readFile(resolve(args[requestIndex + 1]), "utf8"));
  const minimumImpressions = minimumIndex >= 0 ? Number(args[minimumIndex + 1]) : 50;
  if (!Number.isFinite(minimumImpressions) || minimumImpressions < 0) throw new Error("invalid minimum impressions");

  const result = await fetchSearchAnalytics(request, process.env.SEARCH_CONSOLE_ACCESS_TOKEN);
  if (result.status !== "PASS" || !result.dataset) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "UNAVAILABLE" ? 2 : 1;
    return;
  }
  const analysis = analyzeCtrOpportunities(result.dataset, minimumImpressions);
  validateCtrAnalysis(result.dataset, analysis, minimumImpressions);
  process.stdout.write(`${JSON.stringify({ status: "PASS", dataset: result.dataset, analysis }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

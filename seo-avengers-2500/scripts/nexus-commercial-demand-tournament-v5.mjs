#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runCommercialDemandTournamentV5 } from "../commercial-demand/tournament-engine-v5.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SCENARIO = resolve(ROOT, "seo-avengers-2500/commercial-demand/nexus-commercial-demand-v2.json");
const DEFAULT_V3_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/service-intent-evidence-v3.json");
const DEFAULT_V4_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/software-intent-evidence-v4.json");
const DEFAULT_V5_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/demand-fit-evidence-v5.json");

function parseArgs(argv) {
  const options = {
    scenario: DEFAULT_SCENARIO,
    v3Evidence: DEFAULT_V3_EVIDENCE,
    v4Evidence: DEFAULT_V4_EVIDENCE,
    v5Evidence: DEFAULT_V5_EVIDENCE,
    assertVerdict: null,
    assertSelected: null,
    assertFloorMilli: null,
    assertWorstMilli: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--scenario" && value) {
      options.scenario = resolve(value);
      index += 1;
    } else if (arg === "--v3-evidence" && value) {
      options.v3Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v4-evidence" && value) {
      options.v4Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v5-evidence" && value) {
      options.v5Evidence = resolve(value);
      index += 1;
    } else if (arg === "--assert-verdict" && value) {
      options.assertVerdict = value;
      index += 1;
    } else if (arg === "--assert-selected" && value) {
      options.assertSelected = value;
      index += 1;
    } else if (arg === "--assert-floor-milli" && value) {
      options.assertFloorMilli = Number(value);
      index += 1;
    } else if (arg === "--assert-worst-milli" && value) {
      options.assertWorstMilli = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [scenario, v3Evidence, v4Evidence, v5Evidence] = await Promise.all([
    readJson(options.scenario),
    readJson(options.v3Evidence),
    readJson(options.v4Evidence),
    readJson(options.v5Evidence),
  ]);
  const report = runCommercialDemandTournamentV5(scenario, v3Evidence, v4Evidence, v5Evidence);

  if (options.assertVerdict && report.targetSupportVerdict !== options.assertVerdict) {
    throw new Error(`expected verdict ${options.assertVerdict}, got ${report.targetSupportVerdict}`);
  }
  if (options.assertSelected && report.selectedStrategyId !== options.assertSelected) {
    throw new Error(`expected selected strategy ${options.assertSelected}, got ${report.selectedStrategyId}`);
  }
  if (options.assertFloorMilli !== null && report.objective.minimumPlanningFloorClientsMilli !== options.assertFloorMilli) {
    throw new Error(`expected floor ${options.assertFloorMilli}, got ${report.objective.minimumPlanningFloorClientsMilli}`);
  }
  if (options.assertWorstMilli !== null && report.growthFrontier.winnerWorstCaseModeledClientsMilli !== options.assertWorstMilli) {
    throw new Error(`expected worst-case modeled clients ${options.assertWorstMilli}, got ${report.growthFrontier.winnerWorstCaseModeledClientsMilli}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V5_ERROR=${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
